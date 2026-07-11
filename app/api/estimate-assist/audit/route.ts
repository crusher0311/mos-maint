import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { getOpenAI, trackOpenAiCall } from "@/lib/ai";
import { getDb } from "@/lib/mongo";
import { trackApiRequest } from "@/lib/api-usage-tracker";
import { enforceAiBudget } from "@/lib/ai-budget";
import { isPlatformAdmin as isPlatformAdminEmail } from "@/lib/super-admins";
import {
  getJobKnowledgeBase,
  searchJobs,
  ESTIMATE_COLLECTIONS,
} from "@/lib/estimate-assist/job-knowledge-base";
import { NORMALIZED_COLLECTIONS } from "@/lib/normalized-schema";
import {
  validateExtensionToken,
  getAuthErrorStatus,
  buildAuthErrorBody,
} from "@/lib/extension-auth";
import { withUpstreamTimeout } from "@/lib/with-upstream-timeout";

// Budget for the optional AI-findings pass. The static rule findings are
// already computed by then, so on timeout we return those instead of hanging.
const AI_TIMEOUT_MS = 20_000;

export const dynamic = "force-dynamic";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders });
}

export interface AuditFinding {
  id: string;
  severity: "critical" | "warning" | "info";
  category: string;
  title: string;
  description: string;
  suggestedAction?: string;
  suggestedJobId?: string;
  suggestedJobTitle?: string;
  confidence: number;
  lineItemIndex?: number;
}

export interface AuditReport {
  workOrderId?: string;
  workOrderNumber?: string;
  vehicleDisplay?: string;
  auditDate: string;
  findings: AuditFinding[];
  summary: {
    totalFindings: number;
    critical: number;
    warnings: number;
    info: number;
    score: number;
  };
}

interface AuditRequest {
  workOrderId?: string;
  lineItems?: Array<{
    title: string;
    description?: string;
    type?: string;
    laborHours?: number;
    laborTotal?: number;
    partsTotal?: number;
    parts?: Array<{ description: string; quantity: number; unitPrice: number }>;
    total?: number;
  }>;
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
      const extAuth = await validateExtensionToken(req);
      if (!extAuth.authorized || !extAuth.user) {
        return NextResponse.json(
          buildAuthErrorBody(extAuth, { ok: false }),
          { status: getAuthErrorStatus(extAuth), headers: corsHeaders },
        );
      }
      sessionEmail = extAuth.user.email ?? null;
      shopId = Number(extAuth.user.shopId);
    } else {
      const session = await getSession();
      if (!session) {
        return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401, headers: corsHeaders });
      }
      sessionEmail = session.email;
      shopId = Number(session.shopId);
    }

    const body: AuditRequest = await req.json();

    const isAdmin = await isPlatformAdminEmail(sessionEmail || "");
    {
      const blocked = await enforceAiBudget({
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
      const db = await getDb();

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

    const findings: AuditFinding[] = [];
    let findingId = 0;

    const knowledgeBase = getJobKnowledgeBase();

    for (let i = 0; i < lineItems.length; i++) {
      const item = lineItems[i];
      const matchedKbJobs = searchJobs(item.title, 3);
      const primaryMatch = matchedKbJobs[0];

      if (item.laborTotal && item.laborTotal > 0 && (!item.partsTotal || item.partsTotal <= 0)) {
        const isDiag = item.type === "diagnostic" || item.type === "inspection" ||
          /diagnostic|inspection|check|test|scan/i.test(item.title);
        if (!isDiag && primaryMatch && primaryMatch.requiredParts.length > 0) {
          findings.push({
            id: `f-${++findingId}`,
            severity: "critical",
            category: "Missing Parts",
            title: `No parts on "${item.title}"`,
            description: `This job has $${item.laborTotal} labor but no parts listed. Typical parts for this job include: ${primaryMatch.requiredParts.join(", ")}.`,
            suggestedAction: `Add required parts: ${primaryMatch.requiredParts.join(", ")}`,
            suggestedJobId: primaryMatch.jobId,
            confidence: 0.85,
            lineItemIndex: i,
          });
        }
      }

      if (item.partsTotal && item.partsTotal > 0 && (!item.laborTotal || item.laborTotal <= 0)) {
        findings.push({
          id: `f-${++findingId}`,
          severity: "warning",
          category: "Missing Labor",
          title: `No labor on "${item.title}"`,
          description: `This job has $${item.partsTotal} in parts but no labor charged. Parts typically require installation labor.`,
          suggestedAction: primaryMatch ? `Add labor: typically ${primaryMatch.laborHoursTypical} hours for this job` : "Add appropriate labor time",
          confidence: 0.8,
          lineItemIndex: i,
        });
      }

      if (primaryMatch && item.laborHours) {
        if (item.laborHours < primaryMatch.laborHoursMin * 0.5) {
          findings.push({
            id: `f-${++findingId}`,
            severity: "warning",
            category: "Labor Hours",
            title: `Low labor hours on "${item.title}"`,
            description: `${item.laborHours}h charged, typical range is ${primaryMatch.laborHoursMin}-${primaryMatch.laborHoursMax}h. This may indicate under-billing.`,
            suggestedAction: `Review labor time. Typical: ${primaryMatch.laborHoursTypical}h`,
            confidence: 0.7,
            lineItemIndex: i,
          });
        } else if (item.laborHours > primaryMatch.laborHoursMax * 1.5) {
          findings.push({
            id: `f-${++findingId}`,
            severity: "info",
            category: "Labor Hours",
            title: `High labor hours on "${item.title}"`,
            description: `${item.laborHours}h charged, typical range is ${primaryMatch.laborHoursMin}-${primaryMatch.laborHoursMax}h. Verify if additional complications justified extra time.`,
            confidence: 0.6,
            lineItemIndex: i,
          });
        }
      }

      if (primaryMatch && primaryMatch.safetyRelated) {
        for (const compId of primaryMatch.companionJobs) {
          const compJob = knowledgeBase.find(j => j.jobId === compId);
          if (compJob && compJob.safetyRelated) {
            const isOnEstimate = lineItems.some(li =>
              li.title.toLowerCase().includes(compJob.title.toLowerCase().split(" ")[0]) ||
              compJob.tags.some(t => li.title.toLowerCase().includes(t))
            );
            if (!isOnEstimate) {
              const existingFinding = findings.find(f =>
                f.suggestedJobId === compId && f.category === "Missing Companion Service"
              );
              if (!existingFinding) {
                findings.push({
                  id: `f-${++findingId}`,
                  severity: "warning",
                  category: "Missing Companion Service",
                  title: `Consider adding "${compJob.title}"`,
                  description: `"${item.title}" is commonly performed with "${compJob.title}" for complete service.`,
                  suggestedAction: `Add "${compJob.title}" to the estimate`,
                  suggestedJobId: compJob.jobId,
                  suggestedJobTitle: compJob.title,
                  confidence: 0.65,
                });
              }
            }
          }
        }
      }

      if (!item.description || item.description.trim().length < 10) {
        findings.push({
          id: `f-${++findingId}`,
          severity: "info",
          category: "Description Quality",
          title: `Incomplete description on "${item.title}"`,
          description: "Adding a detailed description improves customer communication and protects the shop legally.",
          suggestedAction: primaryMatch
            ? `Suggested: "${primaryMatch.customerDescription.substring(0, 100)}..."`
            : "Add a clear description of the work to be performed",
          confidence: 0.9,
          lineItemIndex: i,
        });
      }
    }

    const brakeJob = lineItems.find(li =>
      /brake.*pad|pad.*replace|brake.*rotor|rotor.*replace/i.test(li.title)
    );
    if (brakeJob) {
      const hasBrakeFlush = lineItems.some(li => /brake.*fluid|fluid.*flush|brake.*flush/i.test(li.title));
      if (!hasBrakeFlush) {
        findings.push({
          id: `f-${++findingId}`,
          severity: "warning",
          category: "Missing Companion Service",
          title: "Consider Brake Fluid Flush",
          description: "Brake pad/rotor replacement is commonly paired with a brake fluid flush for complete brake service.",
          suggestedAction: "Add brake fluid flush to the estimate",
          suggestedJobId: "brake-fluid-flush",
          suggestedJobTitle: "Brake Fluid Flush",
          confidence: 0.75,
        });
      }
    }

    const timingBeltJob = lineItems.find(li => /timing.*belt/i.test(li.title));
    if (timingBeltJob) {
      const hasWaterPump = lineItems.some(li => /water.*pump/i.test(li.title));
      if (!hasWaterPump) {
        findings.push({
          id: `f-${++findingId}`,
          severity: "warning",
          category: "Missing Companion Service",
          title: "Consider Water Pump Replacement",
          description: "The water pump is commonly replaced during timing belt service since it's already accessible and prevents future labor duplication.",
          suggestedAction: "Add water pump replacement to the estimate",
          suggestedJobId: "water-pump",
          suggestedJobTitle: "Water Pump Replacement",
          confidence: 0.85,
        });
      }
    }

    let aiFindings: AuditFinding[] = [];
    try {
      const openai = getOpenAI();
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
        trackOpenAiCall(shopId, "/api/estimate-assist/audit", completion, Date.now() - startTime);
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

    const allFindings = [...findings, ...aiFindings];

    const existingTitles = new Set<string>();
    const deduped = allFindings.filter(f => {
      const key = `${f.category}:${f.title}`;
      if (existingTitles.has(key)) return false;
      existingTitles.add(key);
      return true;
    });

    deduped.sort((a, b) => {
      const severityOrder = { critical: 0, warning: 1, info: 2 };
      const diff = severityOrder[a.severity] - severityOrder[b.severity];
      if (diff !== 0) return diff;
      return b.confidence - a.confidence;
    });

    const critical = deduped.filter(f => f.severity === "critical").length;
    const warnings = deduped.filter(f => f.severity === "warning").length;
    const info = deduped.filter(f => f.severity === "info").length;

    let score = 100;
    score -= critical * 15;
    score -= warnings * 5;
    score -= info * 1;
    score = Math.max(0, Math.min(100, score));

    const report: AuditReport = {
      workOrderId,
      workOrderNumber,
      vehicleDisplay: vehicleInfo
        ? `${vehicleInfo.year || ''} ${vehicleInfo.make || ''} ${vehicleInfo.model || ''}`.trim()
        : undefined,
      auditDate: new Date().toISOString(),
      findings: deduped,
      summary: {
        totalFindings: deduped.length,
        critical,
        warnings,
        info,
        score,
      },
    };

    try {
      const db = await getDb();
      await db.collection(ESTIMATE_COLLECTIONS.estimateAudits).insertOne({
        shopId,
        userId: sessionEmail,
        workOrderId,
        workOrderNumber,
        lineItemCount: lineItems.length,
        findingCount: deduped.length,
        score,
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
