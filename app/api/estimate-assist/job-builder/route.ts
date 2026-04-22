import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { getOpenAI, trackOpenAiCall } from "@/lib/ai";
import { trackApiRequest } from "@/lib/api-usage-tracker";
import { enforceAiBudget } from "@/lib/ai-budget";
import { isPlatformAdmin as isPlatformAdminEmail } from "@/lib/super-admins";
import {
  searchJobs,
  getJobById,
  getCompanionJobs,
  getUpsellJobs,
  getShopHistoricalAverage,
  JobKnowledgeEntry,
} from "@/lib/estimate-assist/job-knowledge-base";
import { getDb } from "@/lib/mongo";

export const dynamic = "force-dynamic";

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
    const session = await getSession();
    if (!session) {
      return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
    }

    const body: JobBuilderRequest = await req.json();
    const { jobNameOrId, vin, year, make, model, submodel, drivetrain, engineCylinders, engineDescription, languageMode } = body;
    const shopId = Number(session.shopId);

    const isAdmin = await isPlatformAdminEmail(session.email);
    {
      const blocked = await enforceAiBudget({
        shopId,
        route: "/api/estimate-assist/job-builder",
        isPlatformAdmin: isAdmin,
      });
      if (blocked) return blocked;
    }

    if (!jobNameOrId) {
      return NextResponse.json({ ok: false, error: "jobNameOrId is required" }, { status: 400 });
    }

    let knowledgeBaseJob = getJobById(jobNameOrId);
    if (!knowledgeBaseJob) {
      const results = searchJobs(jobNameOrId, 1);
      knowledgeBaseJob = results[0] || null;
    }

    let vehicleInfo: { year?: number; make?: string; model?: string; submodel?: string; drivetrain?: string; engineCylinders?: number; engineDescription?: string; fuelType?: string; transmission?: string } | null = null;
    if (vin) {
      try {
        const db = await getDb();
        vehicleInfo = await db.collection("normalized_vehicles").findOne(
          { vin: vin.toUpperCase(), shopId },
          { projection: { year: 1, make: 1, model: 1, submodel: 1, drivetrain: 1, engineCylinders: 1, engineDescription: 1, fuelType: 1, transmission: 1 } }
        ) as typeof vehicleInfo;
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

    const shopHistory = await getShopHistoricalAverage(shopId, knowledgeBaseJob?.title || jobNameOrId, {
      make: vehicleContext.make,
      model: vehicleContext.model,
      year: vehicleContext.year,
    });

    let laborHoursAdjust = 0;
    const additionalParts: string[] = [];
    const additionalCompanions: string[] = [];

    if (knowledgeBaseJob?.vinAttributes) {
      for (const attr of knowledgeBaseJob.vinAttributes) {
        const condLower = attr.condition.toLowerCase();
        const drivetrainLower = (vehicleContext.drivetrain || "").toLowerCase();
        const cylinders = vehicleContext.engineCylinders;

        if (condLower === "awd" && drivetrainLower.includes("awd")) {
          laborHoursAdjust += attr.laborHoursAdjust || 0;
          additionalParts.push(...(attr.additionalParts || []));
          additionalCompanions.push(...(attr.additionalCompanions || []));
        }
        if (condLower === "4wd" && (drivetrainLower.includes("4wd") || drivetrainLower.includes("4x4"))) {
          laborHoursAdjust += attr.laborHoursAdjust || 0;
          additionalParts.push(...(attr.additionalParts || []));
          additionalCompanions.push(...(attr.additionalCompanions || []));
        }
        if (condLower === "v6_engine" && cylinders === 6) {
          laborHoursAdjust += attr.laborHoursAdjust || 0;
          additionalParts.push(...(attr.additionalParts || []));
        }
        if (condLower === "v8_engine" && cylinders === 8) {
          laborHoursAdjust += attr.laborHoursAdjust || 0;
          additionalParts.push(...(attr.additionalParts || []));
        }
        if (condLower === "electronic_parking_brake" && (vehicleContext.year || 0) >= 2016) {
          laborHoursAdjust += attr.laborHoursAdjust || 0;
        }
        if (condLower === "cvt_transmission" && (vehicleContext.transmission || "").toLowerCase().includes("cvt")) {
          additionalParts.push(...(attr.additionalParts || []));
        }
      }
    }

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
    if (!knowledgeBaseJob || knowledgeBaseJob.technicalDescription.length < 50) {
      try {
        const openai = getOpenAI();
        const startTime = Date.now();
        const vehicleStr = [vehicleContext.year, vehicleContext.make, vehicleContext.model].filter(Boolean).join(" ");

        const completion = await openai.chat.completions.create({
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
        });

        trackOpenAiCall(shopId, "/api/estimate-assist/job-builder", completion, Date.now() - startTime);

        const aiContent = completion.choices[0]?.message?.content;
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

    return NextResponse.json({ ok: true, estimate: result });
  } catch (error: any) {
    console.error("[Estimate Job Builder] Error:", error);
    return NextResponse.json({ ok: false, error: error.message || "Failed to build estimate" }, { status: 500 });
  }
}
