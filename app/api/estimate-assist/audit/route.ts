import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { getOpenAI, trackOpenAiCall } from "@/lib/ai";
import { getDb } from "@/lib/mongo";
import { enforceAiBudget } from "@/lib/ai-budget";
import { isPlatformAdmin as isPlatformAdminEmail } from "@/lib/super-admins";
import { ESTIMATE_COLLECTIONS } from "@/lib/estimate-assist/job-knowledge-base";
import {
  AuditFinding,
  AuditReport,
  AuditLineItem,
  runStaticAuditRules,
  dedupeAndSortFindings,
  summarizeFindings,
} from "@/lib/estimate-assist/audit-engine";
import { NORMALIZED_COLLECTIONS } from "@/lib/normalized-schema";
import {
  validateExtensionToken,
  getAuthErrorStatus,
  buildAuthErrorBody,
} from "@/lib/extension-auth";
import { withUpstreamTimeout } from "@/lib/with-upstream-timeout";

// Static rule logic (missing parts/labor, labor-hour ranges, companion
// suggestions, dedupe/sort, score math) lives in
// lib/estimate-assist/audit-engine.ts so it is unit-testable without this
// route's server-only auth imports.
export type { AuditFinding, AuditReport } from "@/lib/estimate-assist/audit-engine";

// Budget for the optional AI-findings pass. The static rule findings are
// already computed by then, so on timeout we return those instead of hanging.
const AI_TIMEOUT_MS = 20_000;

export const dynamic = "force-dynamic";

// Test seam: route-level smoke tests swap these to run the handler without
// a live session store, Mongo, or OpenAI (same pattern as the cron routes).
export const __deps = {
  getSession,
  validateExtensionToken,
  enforceAiBudget,
  isPlatformAdmin: isPlatformAdminEmail,
  getOpenAI,
  trackOpenAiCall,
  getDb,
};

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders });
}

interface AuditRequest {
  workOrderId?: string;
  lineItems?: AuditLineItem[];
  vehicleInfo?: {
    year?: number;
    make?: string;
    model?: string;
    drivetrain?: string;
    mileage?: number;
  };
}

export async function POST(req: NextRequest) {
  try {
    // Dual auth: extension Bearer ext_ token OR dashboard session cookie.
    // The middleware now allowlists this path (Task #734), so the route is
    // the only auth gate — it must validate the ext token itself.
    let sessionEmail: string | null = null;
    let shopId: number;

    const authHeader = req.headers.get("Authorization");
    if (authHeader?.startsWith("Bearer ext_")) {
      const extAuth = await __deps.validateExtensionToken(req);
      if (!extAuth.authorized || !extAuth.user) {
        return NextResponse.json(
          buildAuthErrorBody(extAuth, { ok: false }),
          { status: getAuthErrorStatus(extAuth), headers: corsHeaders },
        );
      }
      sessionEmail = extAuth.user.email ?? null;
      shopId = Number(extAuth.user.shopId);
    } else {
      const session = await __deps.getSession();
      if (!session) {
        return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401, headers: corsHeaders });
      }
      sessionEmail = session.email;
      shopId = Number(session.shopId);
    }

    const body: AuditRequest = await req.json();

    const isAdmin = await __deps.isPlatformAdmin(sessionEmail || "");
    {
      const blocked = await __deps.enforceAiBudget({
        shopId,
        route: "/api/estimate-assist/audit",
        isPlatformAdmin: isAdmin,
      });
      if (blocked) return blocked;
    }

    let lineItems = body.lineItems || [];
    let vehicleInfo = body.vehicleInfo || null;
    let workOrderNumber: string | undefined;
    let workOrderId = body.workOrderId;

    if (workOrderId && lineItems.length === 0) {
      const db = await __deps.getDb();

      // 1. Try the normalized _id directly (dashboard "Build Estimate" links).
      let wo = await db.collection(NORMALIZED_COLLECTIONS.workOrders).findOne({
        _id: workOrderId,
        shopId,
      } as any);

      // 2. Try the human-facing RO number (what users type into the dashboard).
      if (!wo) {
        wo = await db.collection(NORMALIZED_COLLECTIONS.workOrders).findOne({
          shopId,
          workOrderNumber: String(workOrderId),
        });
      }

      // 3. Try the SMS-internal id via provenance. The extension sends the
      // provider's internal RO id (e.g. Tekmetric's numeric id), which is
      // neither our normalized _id nor the display RO number. sourceSystem is
      // constrained so the (sourceSystem, sourceIds.idValue) index is used
      // instead of a collection scan.
      if (!wo) {
        wo = await db.collection(NORMALIZED_COLLECTIONS.workOrders).findOne({
          shopId,
          'provenance.sourceSystem': { $in: ['tekmetric', 'protractor', 'shopware', 'autoflow'] },
          'provenance.sourceIds.idValue': String(workOrderId),
        });
      }

      if (!wo) {
        return NextResponse.json({
          ok: false,
          code: "RO_NOT_SYNCED",
          error: `We don't have repair order "${workOrderId}" synced yet. It may still be importing from your shop management system — try again in a few minutes, or check the RO number.`,
        }, { status: 404, headers: corsHeaders });
      }

      workOrderId = String(wo._id);
      workOrderNumber = wo.workOrderNumber;

      if (wo.vehicle) {
        vehicleInfo = {
          year: wo.vehicle.year,
          make: wo.vehicle.make,
          model: wo.vehicle.model,
          mileage: wo.odometerIn,
        };
      }

      let serviceJobs: any[] = Array.isArray(wo.serviceJobs) ? wo.serviceJobs : [];
      if (serviceJobs.length === 0) {
        serviceJobs = await db.collection(NORMALIZED_COLLECTIONS.serviceJobs).find({
          workOrderId: wo._id,
          shopId,
          'softDelete.isDeleted': { $ne: true },
        }).toArray();
      }

      lineItems = serviceJobs.map((sj: any) => ({
        title: sj.title,
        description: sj.description,
        type: sj.jobType,
        laborHours: sj.laborHoursBilled || sj.laborHoursActual || sj.laborHoursEstimated,
        laborTotal: sj.laborTotal,
        partsTotal: sj.partsTotal,
        total: sj.total,
      }));

      if (lineItems.length === 0) {
        return NextResponse.json({
          ok: false,
          code: "RO_NO_LINE_ITEMS",
          error: `Repair order ${workOrderNumber || workOrderId} is synced, but it has no jobs/line items yet. Add jobs to the estimate first, then run the audit.`,
        }, { status: 400, headers: corsHeaders });
      }
    }

    if (lineItems.length === 0) {
      return NextResponse.json({
        ok: false,
        error: "No line items to audit. Provide lineItems or a valid workOrderId.",
      }, { status: 400, headers: corsHeaders });
    }

    const findings = runStaticAuditRules(lineItems);
    let findingId = findings.length;

    let aiFindings: AuditFinding[] = [];
    try {
      const openai = __deps.getOpenAI();
      const startTime = Date.now();

      const lineItemsSummary = lineItems.map((li, i) =>
        `${i + 1}. "${li.title}" - Labor: ${li.laborHours || 'N/A'}h ($${li.laborTotal || 'N/A'}), Parts: $${li.partsTotal || 'N/A'}, Total: $${li.total || 'N/A'}`
      ).join("\n");

      const vehicleStr = vehicleInfo
        ? `${vehicleInfo.year || ''} ${vehicleInfo.make || ''} ${vehicleInfo.model || ''} (${vehicleInfo.mileage || 'N/A'} miles)`.trim()
        : "Unknown vehicle";

      const completion = await withUpstreamTimeout(
        openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          {
            role: "system",
            content: `You are an expert automotive estimate auditor. Review the estimate line items and identify issues. Focus on:
1. Pricing anomalies (unusually high or low for the service)
2. Missing commonly-associated services not already flagged
3. Description improvements for customer communication
4. Safety concerns

Return JSON array of findings:
[{
  "severity": "critical"|"warning"|"info",
  "category": "string",
  "title": "string",
  "description": "string",
  "suggestedAction": "string",
  "confidence": 0.0-1.0,
  "lineItemIndex": number|null
}]

Only include genuinely useful findings. Do not repeat obvious items. Maximum 5 findings.`,
          },
          {
            role: "user",
            content: `Vehicle: ${vehicleStr}\n\nEstimate Line Items:\n${lineItemsSummary}`,
          },
        ],
        temperature: 0.3,
        max_tokens: 800,
        response_format: { type: "json_object" },
        }),
        AI_TIMEOUT_MS,
        "estimate-audit-ai",
        null,
      );

      if (completion) {
        __deps.trackOpenAiCall(shopId, "/api/estimate-assist/audit", completion, Date.now() - startTime);
      }

      const aiContent = completion?.choices[0]?.message?.content || "{}";
      let parsed: any;
      try {
        parsed = JSON.parse(aiContent);
      } catch {
        parsed = {};
      }

      const aiItems = Array.isArray(parsed) ? parsed : (parsed.findings || parsed.items || []);
      aiFindings = aiItems
        .filter((f: any) => f && f.title && f.description)
        .map((f: any) => ({
          id: `f-${++findingId}`,
          severity: f.severity || "info",
          category: f.category || "AI Analysis",
          title: f.title,
          description: f.description,
          suggestedAction: f.suggestedAction,
          confidence: f.confidence || 0.5,
          lineItemIndex: f.lineItemIndex,
        }));
    } catch (aiError) {
      console.error("[Estimate Audit] AI analysis failed:", aiError);
    }

    const deduped = dedupeAndSortFindings([...findings, ...aiFindings]);
    const summary = summarizeFindings(deduped);

    const report: AuditReport = {
      workOrderId,
      workOrderNumber,
      vehicleDisplay: vehicleInfo
        ? `${vehicleInfo.year || ''} ${vehicleInfo.make || ''} ${vehicleInfo.model || ''}`.trim()
        : undefined,
      auditDate: new Date().toISOString(),
      findings: deduped,
      summary,
    };

    try {
      const db = await __deps.getDb();
      await db.collection(ESTIMATE_COLLECTIONS.estimateAudits).insertOne({
        shopId,
        userId: sessionEmail,
        workOrderId,
        workOrderNumber,
        lineItemCount: lineItems.length,
        findingCount: deduped.length,
        score: summary.score,
        report,
        createdAt: new Date(),
      });
    } catch (saveErr) {
      console.warn("[Estimate Audit] Failed to save audit history:", saveErr);
    }

    return NextResponse.json({ ok: true, report }, { headers: corsHeaders });
  } catch (error: any) {
    console.error("[Estimate Audit] Error:", error);
    return NextResponse.json({ ok: false, error: error.message || "Audit failed" }, { status: 500, headers: corsHeaders });
  }
}
