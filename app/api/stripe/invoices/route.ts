import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { getDb } from "@/lib/mongo";
import { getStripe } from "@/lib/stripe";

export async function GET() {
  try {
    const session = await getSession();
    if (!session) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const db = await getDb();
    const shop = await db.collection("shops").findOne({ id: session.shopId });
    
    if (!shop?.stripeCustomerId) {
      return NextResponse.json({ invoices: [] });
    }

    const stripe = getStripe();
    const invoices = await stripe.invoices.list({
      customer: shop.stripeCustomerId,
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
