import { withExtensionErrorMarker } from "@/lib/extension-route-wrapper";
import { NextRequest, NextResponse } from "next/server";
import { guardExtensionShopRequest } from "@/lib/extension-route-guard";
import { checkExtensionWritePermission } from "@/lib/extension-write-guard";
import { createContact } from "@/lib/integrations/protractor";
import { withUpstreamTimeout } from "@/lib/with-upstream-timeout";
import { resolveClientRequestId } from "@/lib/idempotent-create-id";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Task #937: same never-hang guarantee as the dashboard wizard (Task #936) —
// bounded upstream deadline so the extension's create-contact can never spin
// forever; the route always answers (success, error, or 504).
const UPSTREAM_DEADLINE_MS = 35_000;
const SLOW_UPSTREAM_MSG = "Protractor is responding slowly — please try again.";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders });
}

async function _POST(req: NextRequest) {
  try {
    const body = await req.json();
    const {
      shopId,
      firstName,
      lastName,
      phone1,
      phone2,
      email,
      company,
      street,
      city,
      province,
      postalCode,
      country,
      marketingSource,
      note,
      clientRequestId,
    } = body;

    if (!shopId) {
      return NextResponse.json({ error: "shopId is required" }, { status: 400, headers: corsHeaders });
    }
    if (!firstName || !lastName) {
      return NextResponse.json({ error: "First name and last name are required" }, { status: 400, headers: corsHeaders });
    }

    const guard = await guardExtensionShopRequest(req, {
      smsShopId: shopId,
      provider: body.provider || "protractor",
      corsHeaders,
    });
    if (!guard.ok) return guard.response;

    const writeDenied = checkExtensionWritePermission(guard.user);
    if (writeDenied) {
      return NextResponse.json({ error: writeDenied }, { status: 403, headers: corsHeaders });
    }

    // Task #937: interactive lane (priority pool, 1 retry) + optional
    // idempotency key so an extension retry after a timeout upserts the SAME
    // contact (Protractor's POST /Contact/{id} is an upsert by ID). The
    // upstream ID is DERIVED server-side (hash of kind+shop+user+key), never
    // the raw client value — a caller can't target an existing record's UUID.
    const pinnedContactId = resolveClientRequestId(
      "contact",
      guard.mosShopId,
      guard.user?._id ?? guard.user?.email,
      clientRequestId,
    );
    const result = await withUpstreamTimeout(
      createContact(
        guard.mosShopId,
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
          contactId: pinnedContactId,
        },
      ),
      UPSTREAM_DEADLINE_MS,
      `ext-create-contact shop=${guard.mosShopId}`,
      { ok: false, error: SLOW_UPSTREAM_MSG, timedOut: true } as any,
    );

    if (!result.ok) {
      const timedOut = (result as any).timedOut === true;
      if (timedOut) {
        console.error(`[Extension Protractor Create Contact] upstream deadline (${UPSTREAM_DEADLINE_MS}ms) exceeded shop=${guard.mosShopId}`);
      }
      return NextResponse.json({ error: result.error }, { status: timedOut ? 504 : 500, headers: corsHeaders });
    }

    return NextResponse.json(
      { success: true, contactId: result.contactId, contact: result.contact },
      { headers: corsHeaders },
    );
  } catch (err: any) {
    console.error("[Extension Protractor Create Contact] Error:", err);
    return NextResponse.json({ error: err.message || "Internal error" }, { status: 500, headers: corsHeaders });
  }
}

// Task #510: per-shop error-rate alerting — wrap all extension handlers
export const POST = withExtensionErrorMarker(_POST as any);
