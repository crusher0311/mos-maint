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
  mapAiCompanionTitlesToKbJobs,
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

    // VIN-aware AI labor pass (Task follow-up): the KB "typical" is a
    // cross-vehicle generic. When we know the vehicle, ask the model for
    // vehicle-specific hours (e.g. a 2012 Traverse 3.6L water pump books
    // well above the generic 2.5h). Result is clamped to a sane band around
    // the KB range so a hallucination can't produce absurd hours; any
    // failure falls back silently to the KB numbers.
    // Mutually exclusive with the description-fallback AI call below: a
    // thin-KB job routes to the fallback (which already asks for hours), so
    // running both would double-bill one build.
    let aiVehicleHours: { hours: number; rationale: string } | null = null;
    if (knowledgeBaseJob && !shouldUseAiFallback(knowledgeBaseJob) && vehicleContext.make && vehicleContext.model) {
      try {
        const openai = __deps.getOpenAI();
        const startTime = Date.now();
        const vehicleStr = [
          vehicleContext.year, vehicleContext.make, vehicleContext.model, vehicleContext.submodel,
          vehicleContext.engineDescription || (vehicleContext.engineCylinders ? `${vehicleContext.engineCylinders}-cyl` : null),
          vehicleContext.drivetrain,
        ].filter(Boolean).join(" ");
        const completion = await withUpstreamTimeout(
          openai.chat.completions.create({
            model: "gpt-4o-mini",
            messages: [
              {
                role: "system",
                content: "You are an automotive labor-time estimator. Given a repair job and a specific vehicle, return realistic book labor hours for THAT vehicle configuration (consider engine layout, access difficulty, known quirks). Return JSON: { \"laborHours\": number, \"rationale\": \"one short sentence\" }",
              },
              {
                role: "user",
                content: `Job: "${knowledgeBaseJob.title}". Vehicle: ${vehicleStr}. Generic cross-vehicle range is ${knowledgeBaseJob.laborHoursMin}-${knowledgeBaseJob.laborHoursMax}h (typical ${knowledgeBaseJob.laborHoursTypical}h).`,
              },
            ],
            temperature: 0.2,
            max_tokens: 120,
            response_format: { type: "json_object" },
          }),
          AI_TIMEOUT_MS,
          "estimate-job-builder-vehicle-hours",
          null,
        );
        if (completion) {
          __deps.trackOpenAiCall(shopId, "/api/estimate-assist/job-builder", completion, Date.now() - startTime);
          const content = completion.choices[0]?.message?.content;
          if (content) {
            const parsed = JSON.parse(content);
            const hours = Number(parsed.laborHours);
            // Clamp: within [half the KB min, 1.5x the KB max] and positive.
            const lo = Math.max(0.2, knowledgeBaseJob.laborHoursMin * 0.5);
            const hi = knowledgeBaseJob.laborHoursMax * 1.5;
            if (Number.isFinite(hours) && hours > 0) {
              aiVehicleHours = {
                hours: Math.round(Math.min(hi, Math.max(lo, hours)) * 10) / 10,
                rationale: String(parsed.rationale || "").slice(0, 200),
              };
            }
          }
        }
      } catch (aiHoursErr) {
        console.warn("[Estimate Job Builder] Vehicle-hours AI pass failed:", aiHoursErr);
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

    // AI-built (off-KB) jobs: the AI suggests companion jobs as title strings.
    // Map them onto real KB entries so the Related Jobs list isn't empty —
    // previously these were parsed and then silently dropped.
    if (companionJobs.length === 0 && aiResult && aiResult.companionJobs.length > 0) {
      companionJobs = mapAiCompanionTitlesToKbJobs(
        aiResult.companionJobs,
        knowledgeBaseJob?.jobId ?? null,
      );
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

    // Recommended hours precedence:
    //   1. The shop's own history for this job on this make/model (real data,
    //      vehicle-scoped, >=2 occurrences — see getShopHistoricalAverage).
    //   2. The AI vehicle-specific estimate (clamped above).
    //   3. Shop-wide history for this job (>=3 occurrences).
    //   4. The generic KB typical (+ attribute adjustments).
    const typicalAdjusted = Math.round((baseHoursTypical + laborHoursAdjust) * 10) / 10;
    let recommendedHours = typicalAdjusted;
    let recommendedSource: "shop_vehicle_history" | "ai_vehicle" | "shop_history" | "typical" = "typical";
    if (shopHistory?.vehicleScoped && shopHistory.avgHours > 0.2) {
      recommendedHours = shopHistory.avgHours;
      recommendedSource = "shop_vehicle_history";
    } else if (aiVehicleHours) {
      recommendedHours = aiVehicleHours.hours;
      recommendedSource = "ai_vehicle";
    } else if (shopHistory && !shopHistory.vehicleScoped && shopHistory.count >= 3 && shopHistory.avgHours > 0.2) {
      recommendedHours = shopHistory.avgHours;
      recommendedSource = "shop_history";
    }

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
        typical: typicalAdjusted,
        shopAverage: shopHistory?.avgHours || null,
        shopAverageVehicleScoped: shopHistory?.vehicleScoped || false,
        recommended: recommendedHours,
        recommendedSource,
        aiVehicleEstimate: aiVehicleHours?.hours ?? null,
        aiVehicleRationale: aiVehicleHours?.rationale || null,
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
