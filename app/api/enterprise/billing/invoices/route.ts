import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { getDb } from "@/lib/mongo";
import { getStripe } from "@/lib/stripe";
import { ObjectId } from "mongodb";

async function requireEnterpriseAccess() {
  const session = await getSession();
  if (!session) {
    return { error: "Unauthorized", status: 401 };
  }

  const db = await getDb();
  const shop = await db.collection("shops").findOne({ id: session.shopId });

  if (!shop?.enterpriseId) {
    return { error: "Not part of an enterprise", status: 403 };
  }

  if (session.role !== "owner" && session.role !== "admin") {
    return { error: "Enterprise admin access required", status: 403 };
  }

  return { session, enterpriseId: shop.enterpriseId, db };
}

export async function GET() {
  const auth = await requireEnterpriseAccess();
  if ("error" in auth) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }

  const { db, enterpriseId } = auth;

  try {
    const enterpriseIdStr = enterpriseId.toString();
    let enterpriseObjId: ObjectId | null = null;
    try {
      enterpriseObjId = new ObjectId(enterpriseIdStr);
    } catch (e) {}

    const shops = await db.collection("shops").find({
      $or: [
        ...(enterpriseObjId ? [{ enterpriseId: enterpriseObjId }] : []),
        { enterpriseId: enterpriseIdStr }
      ]
    }).toArray();

    const stripe = getStripe();
    const allInvoices: any[] = [];

    for (const shop of shops) {
      if (shop.stripeCustomerId) {
        try {
          const invoices = await stripe.invoices.list({
            customer: shop.stripeCustomerId,
            limit: 10,
          });

          for (const invoice of invoices.data) {
            allInvoices.push({
              id: invoice.id,
              number: invoice.number || invoice.id,
              amount: invoice.amount_paid || invoice.total,
              status: invoice.status,
              created: invoice.created,
              hostedInvoiceUrl: invoice.hosted_invoice_url,
              invoicePdf: invoice.invoice_pdf,
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
  } catch (error: any) {
    console.error("Error fetching enterprise invoices:", error);
    return NextResponse.json({ error: "Failed to fetch invoices" }, { status: 500 });
  }
}
