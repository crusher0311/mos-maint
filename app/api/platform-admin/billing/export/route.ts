import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { getDb } from "@/lib/mongo";
import { getBillingSettings } from "@/lib/stripe";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CSV_COLUMNS = [
  "shop_id",
  "shop_name",
  "location_identifier",
  "enterprise",
  "plan",
  "status",
  "revenue_source",
  "monthly_amount_usd",
  "stripe_customer_id",
  "stripe_subscription_id",
  "stripe_product_name",
] as const;

function csvEscape(value: unknown): string {
  if (value === null || value === undefined) return "";
  const s = String(value);
  if (s === "") return "";
  if (/[",\r\n]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

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

    const [shops, enterprises, billingSettings] = await Promise.all([
      db.collection("shops").find().project({
        shopId: 1,
        name: 1,
        locationIdentifier: 1,
        enterpriseId: 1,
        billing: 1,
        stripeCustomerId: 1,
        stripeSubscriptionId: 1,
        stripeSubscriptionAmount: 1,
      }).toArray(),
      db.collection("enterprise_accounts").find().project({ _id: 1, name: 1 }).toArray(),
      getBillingSettings(),
    ]);

    const enterpriseMap = new Map(enterprises.map((e: any) => [e._id.toString(), e.name]));

    const configuredPricing: Record<string, number> = {
      starter: billingSettings?.starterPrice ?? 49,
      professional: billingSettings?.mosProPrice ?? 99,
      enterprise: billingSettings?.enterprisePrice ?? 199,
      detect_dog_founder: billingSettings?.detectDogFounderPrice ?? 229.95,
    };

    const rows: string[] = [];
    rows.push(CSV_COLUMNS.join(",") + "\r\n");

    let totalMRR = 0;

    for (const shop of shops) {
      const billing = shop.billing || {};
      const plan = billing.plan || "trial";
      const status = billing.status || "trial";

      if (!billing.isPaid || (status !== "active" && status !== "past_due")) {
        continue;
      }

      const isInvoicePlan = plan === "appfueled_invoice";
      const invoiceMonthlyAmount = typeof billing.invoiceMonthlyAmount === "number" ? billing.invoiceMonthlyAmount : null;

      const stripeAmountCents =
        (typeof shop.stripeSubscriptionAmount === "number" ? shop.stripeSubscriptionAmount : null)
        ?? (typeof billing.stripeSubscriptionAmount === "number" ? billing.stripeSubscriptionAmount : null);

      const monthlyAmountUsd = isInvoicePlan
        ? (invoiceMonthlyAmount !== null ? invoiceMonthlyAmount / 100 : 0)
        : stripeAmountCents !== null
          ? stripeAmountCents / 100
          : configuredPricing[plan] || 0;

      totalMRR += monthlyAmountUsd;

      const revenueSource = isInvoicePlan ? "Invoice" : "Stripe";

      const cells = [
        shop.shopId ?? "",
        shop.name || `Shop ${shop.shopId}`,
        shop.locationIdentifier ?? "",
        shop.enterpriseId ? (enterpriseMap.get(shop.enterpriseId.toString()) ?? "") : "",
        plan,
        status,
        revenueSource,
        monthlyAmountUsd.toFixed(2),
        isInvoicePlan ? "" : (shop.stripeCustomerId ?? ""),
        isInvoicePlan ? "" : (shop.stripeSubscriptionId ?? ""),
        isInvoicePlan ? "" : (billing.stripeProductName ?? ""),
      ];

      rows.push(cells.map(csvEscape).join(",") + "\r\n");
    }

    rows.push(
      [
        "",
        "TOTAL",
        "",
        "",
        "",
        "",
        "All",
        totalMRR.toFixed(2),
        "",
        "",
        "",
      ].map(csvEscape).join(",") + "\r\n"
    );

    const stamp = new Date().toISOString().slice(0, 10);
    const filename = `monthly-revenue_${stamp}.csv`;

    return new Response(rows.join(""), {
      status: 200,
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (err: any) {
    console.error("Platform billing export error:", err);
    return NextResponse.json({ error: err?.message || "Unknown error" }, { status: 500 });
  }
}
