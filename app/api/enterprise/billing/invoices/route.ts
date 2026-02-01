import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { getShopByShopId } from "@/lib/db/shops-pg";
import { getEnterpriseById } from "@/lib/enterprise-pg";
import sql from "@/lib/db/postgres";
import { getStripe } from "@/lib/stripe";

async function requireEnterpriseAccess() {
  const session = await getSession();
  if (!session) {
    return { error: "Unauthorized", status: 401 };
  }

  const shop = await getShopByShopId(session.shopId);

  if (!shop?.enterprise_id) {
    return { error: "Not part of an enterprise", status: 403 };
  }

  if (session.role !== "owner" && session.role !== "admin") {
    return { error: "Enterprise admin access required", status: 403 };
  }

  return { session, enterpriseId: shop.enterprise_id };
}

export async function GET() {
  const auth = await requireEnterpriseAccess();
  if ("error" in auth) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }

  const { enterpriseId } = auth;

  try {
    const enterprise = await getEnterpriseById(enterpriseId);
    if (!enterprise) {
      return NextResponse.json({ error: "Enterprise not found" }, { status: 404 });
    }

    const shops = enterprise.shop_ids.length > 0 ? await sql`
      SELECT id, shop_id, name, billing FROM shops 
      WHERE shop_id::int = ANY(${enterprise.shop_ids})
    ` : [];

    const stripe = getStripe();
    const allInvoices: Array<{
      id: string;
      number: string;
      amount: number;
      status: string | null;
      created: number;
      hostedInvoiceUrl: string | null;
      invoicePdf: string | null;
      shopId: string;
      shopName: string | null;
    }> = [];

    for (const shop of shops) {
      const billing = shop.billing as Record<string, unknown> | null;
      const stripeCustomerId = billing?.stripeCustomerId as string | undefined;
      
      if (stripeCustomerId) {
        try {
          const invoices = await stripe.invoices.list({
            customer: stripeCustomerId,
            limit: 10,
          });

          for (const invoice of invoices.data) {
            allInvoices.push({
              id: invoice.id,
              number: invoice.number || invoice.id,
              amount: invoice.amount_paid || invoice.total,
              status: invoice.status,
              created: invoice.created,
              hostedInvoiceUrl: invoice.hosted_invoice_url || null,
              invoicePdf: invoice.invoice_pdf || null,
              shopId: shop.id,
              shopName: shop.name
            });
          }
        } catch (err) {
          console.error(`Error fetching invoices for shop ${shop.id}:`, err);
        }
      }
    }

    allInvoices.sort((a, b) => b.created - a.created);

    return NextResponse.json({
      invoices: allInvoices.slice(0, 50)
    });
  } catch (error: unknown) {
    console.error("Error fetching enterprise invoices:", error);
    return NextResponse.json({ error: "Failed to fetch invoices" }, { status: 500 });
  }
}
