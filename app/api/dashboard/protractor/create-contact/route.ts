import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { createContact } from "@/lib/integrations/protractor";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    const sess = await getSession();
    if (!sess) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const body = await req.json();
    const { firstName, lastName, phone1, phone2, email, company, street, city, province, postalCode, country, marketingSource, note } = body;

    if (!firstName || !lastName) {
      return NextResponse.json({ error: "First name and last name are required" }, { status: 400 });
    }

    const shopId = Number(sess.shopId);
    const result = await createContact(shopId, {
      firstName,
      lastName,
      phone1: phone1 || undefined,
      phone2: phone2 || undefined,
      email: email || undefined,
      company: company || undefined,
      street: street || undefined,
      city: city || undefined,
      province: province || undefined,
      postalCode: postalCode || undefined,
      country: country || undefined,
      marketingSource: marketingSource || undefined,
      note: note || undefined,
    });

    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: 500 });
    }

    return NextResponse.json({
      success: true,
      contactId: result.contactId,
      contact: result.contact,
    });
  } catch (err: any) {
    console.error("[Create Contact] Error:", err);
    return NextResponse.json({ error: err.message || "Internal error" }, { status: 500 });
  }
}
