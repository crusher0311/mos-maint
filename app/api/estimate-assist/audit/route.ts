import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { getOpenAI } from "@/lib/ai";
import { getDb } from "@/lib/mongo";
import { trackApiRequest } from "@/lib/api-usage-tracker";
import {
  getJobKnowledgeBase,
  searchJobs,
  ESTIMATE_COLLECTIONS,
} from "@/lib/estimate-assist/job-knowledge-base";
import { NORMALIZED_COLLECTIONS } from "@/lib/normalized-schema";

export const dynamic = "force-dynamic";

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
    const session = await getSession();
    if (!session) {
      return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
    }

    const body: AuditRequest = await req.json();
    const shopId = Number(session.shopId);

    let lineItems = body.lineItems || [];
    let vehicleInfo = body.vehicleInfo || null;
    let workOrderNumber: string | undefined;
    let workOrderId = body.workOrderId;

    if (workOrderId && lineItems.length === 0) {
      const db = await getDb();
      const wo = await db.collection(NORMALIZED_COLLECTIONS.workOrders).findOne({
        _id: workOrderId,
        shopId,
      });

      if (!wo) {
        const woByNumber = await db.collection(NORMALIZED_COLLECTIONS.workOrders).findOne({
          shopId,
          workOrderNumber: workOrderId,
        });
        if (woByNumber) {
          workOrderId = woByNumber._id as string;
          workOrderNumber = woByNumber.workOrderNumber;

          if (woByNumber.vehicle) {
            vehicleInfo = {
              year: woByNumber.vehicle.year,
              make: woByNumber.vehicle.make,
              model: woByNumber.vehicle.model,
              mileage: woByNumber.odometerIn,
            };
          }

          const serviceJobs = await db.collection(NORMALIZED_COLLECTIONS.serviceJobs).find({
            workOrderId: workOrderId,
            shopId,
            'softDelete.isDeleted': { $ne: true },
          }).toArray();

          lineItems = serviceJobs.map((sj: any) => ({
            title: sj.title,
            description: sj.description,
            type: sj.jobType,
            laborHours: sj.laborHoursBilled || sj.laborHoursActual || sj.laborHoursEstimated,
            laborTotal: sj.laborTotal,
            partsTotal: sj.partsTotal,
            total: sj.total,
          }));
        }
      } else {
        workOrderNumber = wo.workOrderNumber;

        if (wo.vehicle) {
          vehicleInfo = {
            year: wo.vehicle.year,
            make: wo.vehicle.make,
            model: wo.vehicle.model,
            mileage: wo.odometerIn,
          };
        }

        const serviceJobs = wo.serviceJobs || [];
        if (serviceJobs.length > 0) {
          lineItems = serviceJobs.map((sj: any) => ({
            title: sj.title,
            description: sj.description,
            type: sj.jobType,
            laborHours: sj.laborHoursBilled || sj.laborHoursActual || sj.laborHoursEstimated,
            laborTotal: sj.laborTotal,
            partsTotal: sj.partsTotal,
            total: sj.total,
          }));
        }

        if (lineItems.length === 0) {
          const serviceJobs = await db.collection(NORMALIZED_COLLECTIONS.serviceJobs).find({
            workOrderId: wo._id,
            shopId,
            'softDelete.isDeleted': { $ne: true },
          }).toArray();

          lineItems = serviceJobs.map((sj: any) => ({
            title: sj.title,
            description: sj.description,
            type: sj.jobType,
            laborHours: sj.laborHoursBilled || sj.laborHoursActual || sj.laborHoursEstimated,
            laborTotal: sj.laborTotal,
            partsTotal: sj.partsTotal,
            total: sj.total,
          }));
        }
      }
    }

    if (lineItems.length === 0) {
      return NextResponse.json({
        ok: false,
        error: "No line items to audit. Provide lineItems or a valid workOrderId.",
      }, { status: 400 });
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

      const completion = await openai.chat.completions.create({
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
      });

      trackApiRequest("openai", "/chat/completions", "POST", 200, Date.now() - startTime, shopId).catch(() => {});

      const aiContent = completion.choices[0]?.message?.content || "{}";
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
        userId: session.email,
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

    return NextResponse.json({ ok: true, report });
  } catch (error: any) {
    console.error("[Estimate Audit] Error:", error);
    return NextResponse.json({ ok: false, error: error.message || "Audit failed" }, { status: 500 });
  }
}
