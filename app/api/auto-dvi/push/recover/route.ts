import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { durableRecovery } from "@/lib/auto-dvi/durable/recovery-handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session || session.isImpersonation || session.mustChangePassword)
    return NextResponse.json({error: "Unauthorized"}, {status: 403});
  let origin = "";
  try { origin = new URL(req.headers.get("origin") || "").host; } catch {}
  if (!origin || origin !== (req.headers.get("host") || new URL(req.url).host) ||
      req.headers.get("sec-fetch-site") === "cross-site")
    return NextResponse.json({error: "Same-origin request required"}, {status: 403});
  return durableRecovery(req, {shopId: Number(session.shopId), actor: session.email});
}
