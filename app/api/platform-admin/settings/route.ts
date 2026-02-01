import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import sql from "@/lib/db/postgres";

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
    const [trialRows, billingRows, generalRows] = await Promise.all([
      sql`SELECT * FROM platform_settings WHERE key = 'trial'`,
      sql`SELECT * FROM platform_settings WHERE type = 'billing'`,
      sql`SELECT * FROM platform_settings WHERE key = 'general'`,
    ]);

    const trialSettings = trialRows[0] as any;
    const billingSettings = billingRows[0] as any;
    const generalSettings = generalRows[0] as any;

    return NextResponse.json({
      ok: true,
      settings: {
        trial: {
          vinLimit: trialSettings?.vin_limit ?? DEFAULT_TRIAL_VIN_LIMIT,
        },
        billing: {
          starterProductId: billingSettings?.starter_product_id || "",
          starterPriceId: billingSettings?.starter_price_id || "",
          starterPrice: billingSettings?.starter_price ?? 199.95,
          starterIncludedVins: billingSettings?.starter_included_vins ?? 300,
          plusProductId: billingSettings?.plus_product_id || "",
          plusPriceId: billingSettings?.plus_price_id || "",
          plusPrice: billingSettings?.plus_price ?? 229.95,
          plusIncludedVins: billingSettings?.plus_included_vins ?? 300,
          eliteProductId: billingSettings?.elite_product_id || "",
          elitePriceId: billingSettings?.elite_price_id || "",
          elitePrice: billingSettings?.elite_price ?? 279.95,
          eliteIncludedVins: billingSettings?.elite_included_vins ?? 300,
          mosProProductId: billingSettings?.mos_pro_product_id || "",
          mosProPriceId: billingSettings?.mos_pro_price_id || "",
          mosProPrice: billingSettings?.mos_pro_price ?? 199,
          mosProIncludedVins: billingSettings?.mos_pro_included_vins ?? 300,
          vinPack100ProductId: billingSettings?.vin_pack_100_product_id || "",
          vinPack100PriceId: billingSettings?.vin_pack_100_price_id || "",
          vinPack100Price: billingSettings?.vin_pack_100_price ?? 39,
          vinPack250ProductId: billingSettings?.vin_pack_250_product_id || "",
          vinPack250PriceId: billingSettings?.vin_pack_250_price_id || "",
          vinPack250Price: billingSettings?.vin_pack_250_price ?? 79,
          vinPack500ProductId: billingSettings?.vin_pack_500_product_id || "",
          vinPack500PriceId: billingSettings?.vin_pack_500_price_id || "",
          vinPack500Price: billingSettings?.vin_pack_500_price ?? 149,
          onboardingProductId: billingSettings?.onboarding_product_id || "",
          onboardingPriceId: billingSettings?.onboarding_price_id || "",
          onboardingPrice: billingSettings?.onboarding_price ?? 495,
          trialVinLimit: billingSettings?.trial_vin_limit ?? 10,
          skipTrialBonusVins: billingSettings?.skip_trial_bonus_vins ?? 50,
          foundingShopPricing: billingSettings?.founding_shop_pricing ?? true,
          defaultVinLimit: billingSettings?.default_vin_limit ?? 300,
        },
        general: {
          bookDemoUrl: generalSettings?.book_demo_url || "https://calendly.com/mos-tools",
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

    if (key === "trial") {
      const vinLimit = Number(settings?.vinLimit);
      if (isNaN(vinLimit) || vinLimit < 1) {
        return NextResponse.json({ error: "Invalid VIN limit" }, { status: 400 });
      }

      await sql`
        INSERT INTO platform_settings (key, vin_limit, updated_at, updated_by)
        VALUES ('trial', ${vinLimit}, NOW(), ${session.email})
        ON CONFLICT (key) DO UPDATE SET vin_limit = ${vinLimit}, updated_at = NOW(), updated_by = ${session.email}
      `;

      return NextResponse.json({ 
        ok: true, 
        message: `Default trial VIN limit set to ${vinLimit}` 
      });
    }

    if (key === "billing") {
      await sql`
        INSERT INTO platform_settings (key, type, settings, updated_at, updated_by)
        VALUES ('billing_settings', 'billing', ${JSON.stringify(settings)}::jsonb, NOW(), ${session.email})
        ON CONFLICT (key) DO UPDATE SET 
          type = 'billing',
          settings = ${JSON.stringify(settings)}::jsonb,
          updated_at = NOW(),
          updated_by = ${session.email}
      `;

      return NextResponse.json({ 
        ok: true, 
        message: "Billing settings saved" 
      });
    }

    if (key === "general") {
      await sql`
        INSERT INTO platform_settings (key, book_demo_url, updated_at, updated_by)
        VALUES ('general', ${settings.bookDemoUrl || ''}, NOW(), ${session.email})
        ON CONFLICT (key) DO UPDATE SET 
          book_demo_url = ${settings.bookDemoUrl || ''},
          updated_at = NOW(),
          updated_by = ${session.email}
      `;

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
