import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { getOpenAI, trackOpenAiCall } from "@/lib/ai";
import { enforceAiBudget } from "@/lib/ai-budget";
import { isPlatformAdmin as isPlatformAdminEmail } from "@/lib/super-admins";
import {
  getJobById,
  getCompanionJobs,
  getUpsellJobs,
  getShopHistoricalAverage,
  JobKnowledgeEntry,
} from "@/lib/estimate-assist/job-knowledge-base";
import { getDb } from "@/lib/db/drizzle";
import { normalizedVehicles } from "@/lib/db/schema/normalized";
import { eq, and } from "drizzle-orm";
import {
  validateExtensionToken,
  getAuthErrorStatus,
  buildAuthErrorBody,
} from "@/lib/extension-auth";
import { withUpstreamTimeout } from "@/lib/with-upstream-timeout";
import {
  resolveKnowledgeBaseJob,
  applyVinAttributeAdjustments,
  shouldUseAiFallback,
} from "@/lib/estimate-assist/job-builder-logic";

// Budget for the optional AI-description pass. When the job is already in the
// knowledge base we return KB data on timeout instead of hanging the request.
const AI_TIMEOUT_MS = 20_000;

export const dynamic = "force-dynamic";

// Test seam: route-level smoke tests swap these to run the handler without
// a live session store, Postgres, or OpenAI (same pattern as cron routes).
export const __deps = {
  getSession,
  validateExtensionToken,
  enforceAiBudget,
  isPlatformAdmin: isPlatformAdminEmail,
  getOpenAI,
  trackOpenAiCall,
  getShopHistoricalAverage,
  lookupVehicleByVin,
};

/** VIN → normalized-vehicle attributes lookup (PG). Extracted so tests can stub it. */
async function lookupVehicleByVin(vin: string, shopId: number) {
  const db = getDb();
  const rows = await db
    .select({
      year: normalizedVehicles.year,
      make: normalizedVehicles.make,
      model: normalizedVehicles.model,
      submodel: normalizedVehicles.submodel,
      drivetrain: normalizedVehicles.drivetrain,
      engineCylinders: normalizedVehicles.engineCylinders,
      engineDescription: normalizedVehicles.engineDescription,
      fuelType: normalizedVehicles.fuelType,
      transmission: normalizedVehicles.transmission,
    })
    .from(normalizedVehicles)
    .where(
      and(
        eq(normalizedVehicles.vin, vin.toUpperCase()),
        eq(normalizedVehicles.shopId, shopId),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders });
}

interface JobBuilderRequest {
  jobNameOrId: string;
  vin?: string;
  year?: number;
  make?: string;
  model?: string;
  submodel?: string;
  drivetrain?: string;
  engineCylinders?: number;
  engineDescription?: string;
  languageMode?: "technical" | "customer";
}

interface AIEnhancedJobResult {
  technicalDescription: string;
  customerDescription: string;
  estimatedLaborHours: number;
  requiredParts: string[];
  companionJobs: string[];
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

    const body: JobBuilderRequest = await req.json();
    const { jobNameOrId, vin, year, make, model, submodel, drivetrain, engineCylinders, engineDescription, languageMode } = body;

    const isAdmin = await __deps.isPlatformAdmin(sessionEmail || "");
    {
      const blocked = await __deps.enforceAiBudget({
        shopId,
        route: "/api/estimate-assist/job-builder",
        isPlatformAdmin: isAdmin,
      });
      if (blocked) return blocked;
    }

    if (!jobNameOrId) {
      return NextResponse.json({ ok: false, error: "jobNameOrId is required" }, { status: 400, headers: corsHeaders });
    }

    const knowledgeBaseJob = resolveKnowledgeBaseJob(jobNameOrId);

    let vehicleInfo: { year?: number; make?: string; model?: string; submodel?: string; drivetrain?: string; engineCylinders?: number; engineDescription?: string; fuelType?: string; transmission?: string } | null = null;
    if (vin) {
      try {
        const r = await __deps.lookupVehicleByVin(vin, shopId);
        vehicleInfo = r
          ? {
              year: r.year ?? undefined,
              make: r.make ?? undefined,
              model: r.model ?? undefined,
              submodel: r.submodel ?? undefined,
              drivetrain: r.drivetrain ?? undefined,
              engineCylinders: r.engineCylinders ?? undefined,
              engineDescription: r.engineDescription ?? undefined,
              fuelType: r.fuelType ?? undefined,
              transmission: r.transmission ?? undefined,
            }
          : null;
      } catch (vinErr) {
        console.warn("[Estimate Job Builder] VIN lookup failed:", vinErr);
      }
    }

    const vehicleContext = {
      year: year || vehicleInfo?.year,
      make: make || vehicleInfo?.make,
      model: model || vehicleInfo?.model,
      submodel: submodel || vehicleInfo?.submodel,
      drivetrain: drivetrain || vehicleInfo?.drivetrain,
      engineCylinders: engineCylinders || vehicleInfo?.engineCylinders,
      engineDescription: engineDescription || vehicleInfo?.engineDescription,
      fuelType: vehicleInfo?.fuelType,
      transmission: vehicleInfo?.transmission,
    };

    const shopHistory = await __deps.getShopHistoricalAverage(shopId, knowledgeBaseJob?.title || jobNameOrId, {
      make: vehicleContext.make,
      model: vehicleContext.model,
      year: vehicleContext.year,
    });

    const { laborHoursAdjust, additionalParts, additionalCompanions } =
      applyVinAttributeAdjustments(knowledgeBaseJob, vehicleContext);

    let companionJobs: JobKnowledgeEntry[] = [];
    let upsellJobs: JobKnowledgeEntry[] = [];
    if (knowledgeBaseJob) {
      companionJobs = getCompanionJobs(knowledgeBaseJob.jobId);
      upsellJobs = getUpsellJobs(knowledgeBaseJob.jobId);

      if (additionalCompanions.length > 0) {
        for (const compId of additionalCompanions) {
          const compJob = getJobById(compId);
          if (compJob && !companionJobs.some(j => j.jobId === compJob.jobId)) {
            companionJobs.push(compJob);
          }
        }
      }
    }

    let aiResult: AIEnhancedJobResult | null = null;
    if (shouldUseAiFallback(knowledgeBaseJob)) {
      try {
        const openai = __deps.getOpenAI();
        const startTime = Date.now();
        const vehicleStr = [vehicleContext.year, vehicleContext.make, vehicleContext.model].filter(Boolean).join(" ");

        const completion = await withUpstreamTimeout(
          openai.chat.completions.create({
          model: "gpt-4o-mini",
          messages: [
            {
              role: "system",
              content: "You are an experienced automotive service advisor. Generate a professional estimate line item description for an automotive repair job. Return JSON with: { \"technicalDescription\": \"string\", \"customerDescription\": \"string\", \"estimatedLaborHours\": number, \"requiredParts\": [\"string\"], \"companionJobs\": [\"string\"] }",
            },
            {
              role: "user",
              content: `Generate an estimate line for: "${jobNameOrId}"${vehicleStr ? ` on a ${vehicleStr}` : ""}. Make descriptions professional and accurate.`,
            },
          ],
          temperature: 0.3,
          max_tokens: 500,
          response_format: { type: "json_object" },
          }),
          AI_TIMEOUT_MS,
          "estimate-job-builder-ai",
          null,
        );

        if (completion) {
          __deps.trackOpenAiCall(shopId, "/api/estimate-assist/job-builder", completion, Date.now() - startTime);
        }

        const aiContent = completion?.choices[0]?.message?.content;
        if (aiContent) {
          try {
            const parsed = JSON.parse(aiContent);
            aiResult = {
              technicalDescription: parsed.technicalDescription || "",
              customerDescription: parsed.customerDescription || "",
              estimatedLaborHours: Number(parsed.estimatedLaborHours) || 0,
              requiredParts: Array.isArray(parsed.requiredParts) ? parsed.requiredParts : [],
              companionJobs: Array.isArray(parsed.companionJobs) ? parsed.companionJobs : [],
            };
          } catch (parseErr) {
            console.warn("[Estimate Job Builder] AI response parse failed:", parseErr);
          }
        }
      } catch (aiErr) {
        console.warn("[Estimate Job Builder] AI enhancement failed:", aiErr);
      }
    }

    // No KB match AND the AI fallback failed/timed out — an empty shell with
    // zero hours and no description would look like a silent success, so fail
    // loudly instead.
    if (!knowledgeBaseJob && !aiResult) {
      return NextResponse.json({
        ok: false,
        error: `Couldn't build an estimate for "${jobNameOrId}" right now — the AI description service took too long. Please try again.`,
      }, { status: 504, headers: corsHeaders });
    }

    const baseHoursMin = knowledgeBaseJob?.laborHoursMin || aiResult?.estimatedLaborHours || 0;
    const baseHoursMax = knowledgeBaseJob?.laborHoursMax || baseHoursMin;
    const baseHoursTypical = knowledgeBaseJob?.laborHoursTypical || baseHoursMin;

    const result = {
      jobId: knowledgeBaseJob?.jobId || null,
      title: knowledgeBaseJob?.title || jobNameOrId,
      category: knowledgeBaseJob?.category || "Custom",
      description: languageMode === "customer"
        ? (knowledgeBaseJob?.customerDescription || aiResult?.customerDescription || "")
        : (knowledgeBaseJob?.technicalDescription || aiResult?.technicalDescription || ""),
      technicalDescription: knowledgeBaseJob?.technicalDescription || aiResult?.technicalDescription || "",
      customerDescription: knowledgeBaseJob?.customerDescription || aiResult?.customerDescription || "",
      laborHours: {
        min: Math.round((baseHoursMin + laborHoursAdjust) * 10) / 10,
        max: Math.round((baseHoursMax + laborHoursAdjust) * 10) / 10,
        typical: Math.round((baseHoursTypical + laborHoursAdjust) * 10) / 10,
        shopAverage: shopHistory?.avgHours || null,
      },
      requiredParts: [
        ...(knowledgeBaseJob?.requiredParts || aiResult?.requiredParts || []),
        ...additionalParts,
      ],
      companionJobs: companionJobs.map(j => ({
        jobId: j.jobId,
        title: j.title,
        category: j.category,
        laborHoursTypical: j.laborHoursTypical,
        safetyRelated: j.safetyRelated,
      })),
      upsellJobs: upsellJobs.map(j => ({
        jobId: j.jobId,
        title: j.title,
        category: j.category,
        laborHoursTypical: j.laborHoursTypical,
      })),
      shopHistory: shopHistory ? {
        avgHours: shopHistory.avgHours,
        avgTotal: shopHistory.avgTotal,
        avgLaborTotal: shopHistory.avgLaborTotal,
        avgPartsTotal: shopHistory.avgPartsTotal,
        occurrences: shopHistory.count,
      } : null,
      vehicleContext: {
        year: vehicleContext.year,
        make: vehicleContext.make,
        model: vehicleContext.model,
        drivetrain: vehicleContext.drivetrain,
        vinAdjustments: laborHoursAdjust > 0 ? {
          laborHoursAdded: laborHoursAdjust,
          additionalParts,
        } : null,
      },
      safetyRelated: knowledgeBaseJob?.safetyRelated || false,
      aiEnhanced: !!aiResult,
    };

    return NextResponse.json({ ok: true, estimate: result }, { headers: corsHeaders });
  } catch (error: any) {
    console.error("[Estimate Job Builder] Error:", error);
    return NextResponse.json({ ok: false, error: error.message || "Failed to build estimate" }, { status: 500, headers: corsHeaders });
  }
}
