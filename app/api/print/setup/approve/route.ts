import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/auth";
import { approveSetup } from "@/lib/print-queue/setup-http";
export async function POST(req: NextRequest) {
  try { await requireSession(); } catch { return NextResponse.json({ error: "Unauthorized" }, { status: 401 }); }
  return approveSetup(req);
}
export const runtime = "nodejs";
