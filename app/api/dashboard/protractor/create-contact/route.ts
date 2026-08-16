import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { createContact } from "@/lib/integrations/protractor";
import { withUpstreamTimeout } from "@/lib/with-upstream-timeout";
import { resolveClientRequestId } from "@/lib/idempotent-create-id";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Task #936: bounded upstream deadline so the wizard's Create Customer button
// can never spin forever — the route always answers (success, error, or 504).
const UPSTREAM_DEADLINE_MS = 35_000;
const SLOW_UPSTREAM_MSG = "Protractor is responding slowly — please try again.";

export async function POST(req: NextRequest) {
  try {
    const sess = await getSession();
    if (!sess) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const body = await req.json();
    const { firstName, lastName, phone1, phone2, email, company, street, city, province, postalCode, country, marketingSource, note, clientRequestId } = body;

    if (!firstName || !lastName) {
      return NextResponse.json({ error: "First name and last name are required" }, { status: 400 });
    }

    const shopId = Number(sess.shopId);
    // Interactive lane (priority pool, 1 retry) + a client-pinned contact ID so
    // a wizard retry after a timeout upserts the SAME contact (no duplicates —
    // Protractor's POST /Contact/{id} is an upsert by ID).
    const result = await withUpstreamTimeout(
      createContact(
        shopId,
        {
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
        },
        {
          priority: true,
          maxRetries: 1,
          // Task #937: derive the upstream ID server-side (hash of
          // kind+shop+user+key) so the wizard's retry stays duplicate-safe
          // without letting a caller target an existing record's UUID.
          contactId: resolveClientRequestId("contact", shopId, sess.email, clientRequestId),
        },
      ),
      UPSTREAM_DEADLINE_MS,
      `wizard-create-contact shop=${shopId}`,
      { ok: false, error: SLOW_UPSTREAM_MSG, timedOut: true } as any,
    );

    if (!result.ok) {
      const timedOut = (result as any).timedOut === true;
      if (timedOut) {
        console.error(`[Create Contact] upstream deadline (${UPSTREAM_DEADLINE_MS}ms) exceeded shop=${shopId}`);
      }
      return NextResponse.json({ error: result.error }, { status: timedOut ? 504 : 500 });
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
