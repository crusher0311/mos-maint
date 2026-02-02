import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { getDb } from "@/lib/mongo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DEFAULT_TRIAL_VIN_LIMIT = 10;

export async function GET() {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!session.isPlatformAdmin) {
    return NextResponse.json({ error: "Forbidden - platform admin access required" }, { status: 403 });
  }

  try {
    const db = await getDb();
    const [trialSettings, billingSettings, generalSettings] = await Promise.all([
      db.collection("platform_settings").findOne({ key: "trial" }),
      db.collection("platform_settings").findOne({ type: "billing" }),
      db.collection("platform_settings").findOne({ key: "general" }),
    ]);

    return NextResponse.json({
      ok: true,
      settings: {
        trial: {
          vinLimit: trialSettings?.vinLimit ?? DEFAULT_TRIAL_VIN_LIMIT,
        },
        billing: {
          // Tier-specific pricing
          starterProductId: billingSettings?.starterProductId || "",
          starterPriceId: billingSettings?.starterPriceId || "",
          starterPrice: billingSettings?.starterPrice ?? 199.95,
          starterIncludedVins: billingSettings?.starterIncludedVins ?? 300,
          plusProductId: billingSettings?.plusProductId || "",
          plusPriceId: billingSettings?.plusPriceId || "",
          plusPrice: billingSettings?.plusPrice ?? 229.95,
          plusIncludedVins: billingSettings?.plusIncludedVins ?? 300,
          eliteProductId: billingSettings?.eliteProductId || "",
          elitePriceId: billingSettings?.elitePriceId || "",
          elitePrice: billingSettings?.elitePrice ?? 279.95,
          eliteIncludedVins: billingSettings?.eliteIncludedVins ?? 300,
          // Legacy mosPro fields
          mosProProductId: billingSettings?.mosProProductId || "",
          mosProPriceId: billingSettings?.mosProPriceId || "",
          mosProPrice: billingSettings?.mosProPrice ?? 199,
          mosProIncludedVins: billingSettings?.mosProIncludedVins ?? 300,
          // VIN packs
          vinPack100ProductId: billingSettings?.vinPack100ProductId || "",
          vinPack100PriceId: billingSettings?.vinPack100PriceId || "",
          vinPack100Price: billingSettings?.vinPack100Price ?? 39,
          vinPack250ProductId: billingSettings?.vinPack250ProductId || "",
          vinPack250PriceId: billingSettings?.vinPack250PriceId || "",
          vinPack250Price: billingSettings?.vinPack250Price ?? 79,
          vinPack500ProductId: billingSettings?.vinPack500ProductId || "",
          vinPack500PriceId: billingSettings?.vinPack500PriceId || "",
          vinPack500Price: billingSettings?.vinPack500Price ?? 149,
          // Onboarding
          onboardingProductId: billingSettings?.onboardingProductId || "",
          onboardingPriceId: billingSettings?.onboardingPriceId || "",
          onboardingPrice: billingSettings?.onboardingPrice ?? 495,
          // Trial settings
          trialVinLimit: billingSettings?.trialVinLimit ?? 10,
          skipTrialBonusVins: billingSettings?.skipTrialBonusVins ?? 50,
          foundingShopPricing: billingSettings?.foundingShopPricing ?? true,
          defaultVinLimit: billingSettings?.defaultVinLimit ?? 300,
        },
        general: {
          bookDemoUrl: generalSettings?.bookDemoUrl || "https://calendly.com/mos-tools",
        },
      },
    });
  } catch (err: any) {
    console.error("Platform settings error:", err);
    return NextResponse.json({ error: err?.message || "Unknown error" }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!session.isPlatformAdmin) {
    return NextResponse.json({ error: "Forbidden - platform admin access required" }, { status: 403 });
  }

  try {
    const { key, settings } = await req.json();
    const db = await getDb();

    if (key === "trial") {
      const vinLimit = Number(settings?.vinLimit);
      if (isNaN(vinLimit) || vinLimit < 1) {
        return NextResponse.json({ error: "Invalid VIN limit" }, { status: 400 });
      }

      await db.collection("platform_settings").updateOne(
        { key: "trial" },
        { 
          $set: { 
            vinLimit,
            updatedAt: new Date(),
            updatedBy: session.email,
          } 
        },
        { upsert: true }
      );

      return NextResponse.json({ 
        ok: true, 
        message: `Default trial VIN limit set to ${vinLimit}` 
      });
    }

    if (key === "billing") {
      await db.collection("platform_settings").updateOne(
        { type: "billing" },
        { 
          $set: { 
            type: "billing",
            // Tier-specific pricing
            starterProductId: settings.starterProductId || "",
            starterPriceId: settings.starterPriceId || "",
            starterPrice: settings.starterPrice ?? 199.95,
            starterIncludedVins: settings.starterIncludedVins ?? 300,
            plusProductId: settings.plusProductId || "",
            plusPriceId: settings.plusPriceId || "",
            plusPrice: settings.plusPrice ?? 229.95,
            plusIncludedVins: settings.plusIncludedVins ?? 300,
            eliteProductId: settings.eliteProductId || "",
            elitePriceId: settings.elitePriceId || "",
            elitePrice: settings.elitePrice ?? 279.95,
            eliteIncludedVins: settings.eliteIncludedVins ?? 300,
            // Legacy mosPro fields
            mosProProductId: settings.mosProProductId || "",
            mosProPriceId: settings.mosProPriceId || "",
            mosProPrice: settings.mosProPrice ?? 199,
            mosProIncludedVins: settings.mosProIncludedVins ?? 300,
            // VIN packs
            vinPack100ProductId: settings.vinPack100ProductId || "",
            vinPack100PriceId: settings.vinPack100PriceId || "",
            vinPack100Price: settings.vinPack100Price ?? 39,
            vinPack250ProductId: settings.vinPack250ProductId || "",
            vinPack250PriceId: settings.vinPack250PriceId || "",
            vinPack250Price: settings.vinPack250Price ?? 79,
            vinPack500ProductId: settings.vinPack500ProductId || "",
            vinPack500PriceId: settings.vinPack500PriceId || "",
            vinPack500Price: settings.vinPack500Price ?? 149,
            // Onboarding
            onboardingProductId: settings.onboardingProductId || "",
            onboardingPriceId: settings.onboardingPriceId || "",
            onboardingPrice: settings.onboardingPrice ?? 495,
            // Trial settings
            trialVinLimit: settings.trialVinLimit ?? 10,
            skipTrialBonusVins: settings.skipTrialBonusVins ?? 50,
            foundingShopPricing: settings.foundingShopPricing ?? true,
            defaultVinLimit: settings.defaultVinLimit ?? 300,
            updatedAt: new Date(),
            updatedBy: session.email,
          } 
        },
        { upsert: true }
      );

      return NextResponse.json({ 
        ok: true, 
        message: "Billing settings saved" 
      });
    }

    if (key === "general") {
      await db.collection("platform_settings").updateOne(
        { key: "general" },
        { 
          $set: { 
            key: "general",
            bookDemoUrl: settings.bookDemoUrl || "",
            updatedAt: new Date(),
            updatedBy: session.email,
          } 
        },
        { upsert: true }
      );

      return NextResponse.json({ 
        ok: true, 
        message: "General settings saved" 
      });
    }

    return NextResponse.json({ error: "Invalid settings key" }, { status: 400 });

  } catch (err: any) {
    console.error("Platform settings update error:", err);
    return NextResponse.json({ error: err?.message || "Unknown error" }, { status: 500 });
  }
}
