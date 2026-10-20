import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { copySettingsGet, copySettingsPost } from "@/lib/enterprise-settings-http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  if (!await getSession()) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  return copySettingsGet(req);
}

export async function POST(req: NextRequest) {
  if (!await getSession()) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  return copySettingsPost(req);
}
