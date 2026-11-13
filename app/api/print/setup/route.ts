import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/auth";
import { setupInfo } from "@/lib/print-queue/setup-http";
export async function GET(req: NextRequest) {
  try { await requireSession(); } catch { return NextResponse.json({ error: "Unauthorized" }, { status: 401 }); }
  return setupInfo(req);
}
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
