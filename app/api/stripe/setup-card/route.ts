import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { createCardSetupSession } from "@/lib/stripe";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const sess = await getSession();
  if (!sess) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!sess.shopId) {
    return NextResponse.json({ error: "Shop session required" }, { status: 400 });
  }

  let returnTo = "/dashboard";
  try {
    const body = await req.json().catch(() => ({}));
    if (body && typeof body.returnTo === "string" && body.returnTo.startsWith("/")) {
      returnTo = body.returnTo;
    }
  } catch {
    // ignore
  }

  try {
    const result = await createCardSetupSession({
      shopId: Number(sess.shopId),
      ownerEmail: sess.email,
      returnTo,
      createdVia: "setup_card_endpoint",
    });
    return NextResponse.json({ url: result.url });
  } catch (error: any) {
    console.error("Stripe setup-card error:", error);
    const status = error?.message?.includes("not found") ? 404 : 500;
    return NextResponse.json(
      { error: error?.message || "Failed to create card setup session" },
      { status },
    );
  }
}
