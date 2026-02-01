import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import sql from "@/lib/db/postgres";
import { getStripe } from "@/lib/stripe";

export async function GET() {
  try {
    const session = await getSession();
    if (!session) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const shopRows = await sql`SELECT * FROM shops WHERE shop_id = ${String(session.shopId)}`;
    const shop = shopRows[0] as any;
    
    if (!shop?.stripe_customer_id) {
      return NextResponse.json({ invoices: [] });
    }

    const stripe = getStripe();
    const invoices = await stripe.invoices.list({
      customer: shop.stripe_customer_id,
      limit: 20,
    });

    return NextResponse.json({
      invoices: invoices.data.map(inv => ({
        id: inv.id,
        number: inv.number,
        amount: inv.amount_due,
        status: inv.status,
        created: inv.created,
        dueDate: inv.due_date,
        paidAt: inv.status_transitions?.paid_at,
        hostedInvoiceUrl: inv.hosted_invoice_url,
        invoicePdf: inv.invoice_pdf,
        lines: inv.lines?.data?.map(line => ({
          description: line.description,
          amount: line.amount,
        })) || [],
      }))
    });
  } catch (error) {
    console.error("Error fetching invoices:", error);
    return NextResponse.json({ error: "Failed to fetch invoices" }, { status: 500 });
  }
}
