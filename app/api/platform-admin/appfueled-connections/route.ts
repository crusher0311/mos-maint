import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { getAppFueledConnection, replaceAppFueledConnection, disableAppFueledConnection } from "@/lib/data/repositories/appfueled-connections";
import { createAppFueledConnectionAdmin } from "@/lib/external-api/appfueled-connection-admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function handle(req: NextRequest, action: "get" | "replace" | "disable") {
  try {
    const session = await getSession();
    if (!session?.isPlatformAdmin) return NextResponse.json({ error: "Forbidden" }, { status: 403, headers: { "Cache-Control": "no-store" } });
    return createAppFueledConnectionAdmin({
      getSession: async () => session,
      get: getAppFueledConnection, replace: replaceAppFueledConnection, disable: disableAppFueledConnection,
    })(req, action);
  } catch {
    return NextResponse.json({ error: "Credential management unavailable" }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}
export async function GET(req: NextRequest) { return handle(req, "get"); }
export async function PUT(req: NextRequest) { return handle(req, "replace"); }
export async function PATCH(req: NextRequest) { return handle(req, "disable"); }
