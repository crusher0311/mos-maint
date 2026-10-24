// app/api/admin/shops/[shopId]/autoflow/test/route.ts
import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/auth";
import { resolveAutoflowConfig, fetchDviByInvoice } from "@/lib/integrations/autoflow";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest, ctx: { params: Promise<{ shopId: string }> }) {
  const sess = await requireSession();
  const shopId = Number((await ctx.params).shopId);
  if (!shopId || shopId !== Number(sess.shopId)) {
    return NextResponse.json({ ok: false, error: "Forbidden" }, { status: 403 });
  }

  // optional invoice to test against (safer than a random endpoint)
  const { invoice } = await req.json().catch(() => ({}));
  const cfg = await resolveAutoflowConfig(shopId);
  if (!cfg.configured) {
    return NextResponse.json({ ok: false, error: "AutoFlow not configured." }, { status: 400 });
  }

  if (!invoice) {
    // No invoice provided: do a shallow verification of subdomain only
    // (we can't fully verify creds without hitting an authenticated route)
    return NextResponse.json({
      ok: true,
      note: "Subdomain saved. Provide an invoice to fully verify credentials."
    });
  }

  const res = await fetchDviByInvoice(shopId, String(invoice));
  if (!res.ok) {
    // If unauthorized, tell the user clearly; otherwise we still proved connectivity.
    return NextResponse.json({ ok: false, error: res.error || "Failed to fetch DVI" }, { status: 502 });
  }
  return NextResponse.json({ ok: true, sample: { invoice: res.invoice, sheet: res.sheetName } });
}
