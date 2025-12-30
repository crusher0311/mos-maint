// app/api/admin/billing/settings/route.ts
import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/mongo";
import { requireSession } from "@/lib/auth";

export async function POST(req: NextRequest) {
  try {
    const session = await requireSession();
    
    if (session.role !== "admin") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 403 });
    }

    const body = await req.json();
    const db = await getDb();

    const updateData = {
      type: "billing",
      professionalProductId: body.professionalProductId || "",
      professionalPriceMonthly: body.professionalPriceMonthly || "",
      professionalPriceYearly: body.professionalPriceYearly || "",
      enterpriseProductId: body.enterpriseProductId || "",
      enterprisePriceMonthly: body.enterprisePriceMonthly || "",
      enterprisePriceYearly: body.enterprisePriceYearly || "",
      trialDays: body.trialDays || 14,
      defaultVinLimit: body.defaultVinLimit || 100,
      updatedAt: new Date(),
      updatedBy: session.email,
    };

    await db.collection("platform_settings").updateOne(
      { type: "billing" },
      { $set: updateData },
      { upsert: true }
    );

    return NextResponse.json({ success: true });
  } catch (error: any) {
    console.error("Error saving billing settings:", error);
    return NextResponse.json(
      { error: error.message || "Failed to save settings" },
      { status: 500 }
    );
  }
}
