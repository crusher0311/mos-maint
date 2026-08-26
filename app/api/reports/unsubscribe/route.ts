import { NextRequest, NextResponse } from "next/server";
import { disableReportingSubscriptionByToken } from "@/lib/data/repositories/reporting-subscriptions";
import { hashDisableToken } from "@/lib/reporting-delivery";

async function handle(req: NextRequest) {
  const token = req.nextUrl.searchParams.get("token");
  if (!token || token.length < 32) return NextResponse.json({ error: "Invalid unsubscribe token" }, { status: 400 });
  const doc = await disableReportingSubscriptionByToken(hashDisableToken(token));
  if (!doc) return NextResponse.json({ error: "Invalid or expired unsubscribe token" }, { status: 404 });
  return NextResponse.json({ ok: true, message: "Reporting summary disabled" });
}
export const GET = handle;
export const POST = handle;