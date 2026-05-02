import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/mongo";
import { requireSession } from "@/lib/auth";
import { sanitizeTrialReminderDays } from "@/lib/stripe";
import {
  DEFAULT_TRIAL_REMINDER_SUBJECT,
  DEFAULT_TRIAL_REMINDER_HTML,
  DEFAULT_TRIAL_REMINDER_TEXT,
} from "@/lib/email";

export async function POST(req: NextRequest) {
  try {
    const session = await requireSession();
    
    if (session.role !== "admin" && session.role !== "platform_admin") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 403 });
    }

    const body = await req.json();
    const db = await getDb();

    const updateData = {
      type: "billing",
      // Tier-specific pricing
      starterProductId: body.starterProductId || "",
      starterPriceId: body.starterPriceId || "",
      starterPrice: body.starterPrice ?? 199.95,
      starterIncludedVins: body.starterIncludedVins ?? 300,
      plusProductId: body.plusProductId || "",
      plusPriceId: body.plusPriceId || "",
      plusPrice: body.plusPrice ?? 229.95,
      plusIncludedVins: body.plusIncludedVins ?? 300,
      eliteProductId: body.eliteProductId || "",
      elitePriceId: body.elitePriceId || "",
      elitePrice: body.elitePrice ?? 279.95,
      eliteIncludedVins: body.eliteIncludedVins ?? 300,
      // Detect Dog - Founder
      detectDogFounderProductId: body.detectDogFounderProductId || "prod_UPkRVM5SeF3RiT",
      detectDogFounderPriceId: body.detectDogFounderPriceId || "",
      detectDogFounderPrice: body.detectDogFounderPrice ?? 229.95,
      detectDogFounderIncludedVins: body.detectDogFounderIncludedVins ?? 300,
      // Legacy mosPro fields
      mosProProductId: body.mosProProductId || "",
      mosProPriceId: body.mosProPriceId || "",
      mosProPrice: body.mosProPrice ?? 199,
      mosProIncludedVins: body.mosProIncludedVins ?? 300,
      // VIN packs
      vinPack100ProductId: body.vinPack100ProductId || "",
      vinPack100PriceId: body.vinPack100PriceId || "",
      vinPack100Price: body.vinPack100Price ?? 39,
      vinPack250ProductId: body.vinPack250ProductId || "",
      vinPack250PriceId: body.vinPack250PriceId || "",
      vinPack250Price: body.vinPack250Price ?? 79,
      vinPack500ProductId: body.vinPack500ProductId || "",
      vinPack500PriceId: body.vinPack500PriceId || "",
      vinPack500Price: body.vinPack500Price ?? 149,
      // Onboarding
      onboardingProductId: body.onboardingProductId || "",
      onboardingPriceId: body.onboardingPriceId || "",
      onboardingPrice: body.onboardingPrice ?? 495,
      // Trial settings
      trialDays: body.trialDays ?? 14,
      trialVinLimit: body.trialVinLimit ?? 10,
      defaultVinLimit: body.defaultVinLimit ?? 300,
      foundingShopPricing: body.foundingShopPricing ?? true,
      skipTrialBonusVins: body.skipTrialBonusVins ?? 50,
      // Trial reminder cron config (admin-tunable). Sanitize the day list
      // here so the cron always reads a clean array, and fall back to the
      // safe defaults if the admin clears a template field.
      trialReminderDays: sanitizeTrialReminderDays(body.trialReminderDays),
      trialReminderSubject:
        typeof body.trialReminderSubject === "string" && body.trialReminderSubject.trim()
          ? body.trialReminderSubject
          : DEFAULT_TRIAL_REMINDER_SUBJECT,
      trialReminderHtml:
        typeof body.trialReminderHtml === "string" && body.trialReminderHtml.trim()
          ? body.trialReminderHtml
          : DEFAULT_TRIAL_REMINDER_HTML,
      trialReminderText:
        typeof body.trialReminderText === "string" && body.trialReminderText.trim()
          ? body.trialReminderText
          : DEFAULT_TRIAL_REMINDER_TEXT,
      updatedAt: new Date(),
      updatedBy: session.email,
    };

    await db.collection("platform_settings").updateOne(
      { type: "billing" },
      { $set: updateData },
      { upsert: true }
    );

    // Return the persisted/sanitized values so the form can rehydrate its
    // local state — otherwise an admin who cleared (e.g.) the day list or a
    // template field would briefly see an empty input even though the
    // server stored the safe defaults.
    const { type: _type, updatedAt: _updatedAt, updatedBy: _updatedBy, ...persistedSettings } = updateData;
    return NextResponse.json({ success: true, settings: persistedSettings });
  } catch (error: any) {
    console.error("Error saving billing settings:", error);
    return NextResponse.json(
      { error: error.message || "Failed to save settings" },
      { status: 500 }
    );
  }
}
