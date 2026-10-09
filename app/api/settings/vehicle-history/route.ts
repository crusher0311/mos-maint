import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { historySettingsContext } from "@/lib/vehicle-history/settings";
import { DEFAULT_HISTORY_POLICY, validateHistoryPolicy } from "@/lib/vehicle-history/model";
import { saveHistoryPolicy } from "@/lib/data/repositories/vehicle-history-policy";
import { historyBudget } from "@/lib/vehicle-history/budget";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "private, no-store, max-age=0" };

export async function GET() {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers });
  if (process.env.ENTERPRISE_VEHICLE_HISTORY_ENABLED !== "1") {
    return NextResponse.json({ policy: DEFAULT_HISTORY_POLICY, locations: [], canManage: false }, { headers });
  }
  try {
    const context = await historyBudget()(() => historySettingsContext(session.email, Number(session.shopId), session.role));
    return NextResponse.json(context
      ? { policy: context.policy, locations: context.locations, canManage: context.canManage }
      : { policy: DEFAULT_HISTORY_POLICY, locations: [], canManage: false }, { headers });
  } catch {
    return NextResponse.json({ error: "Sharing settings are unavailable." }, { status: 503, headers });
  }
}

export async function PUT(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers });
  if (!["owner", "admin"].includes(session.role) || process.env.ENTERPRISE_VEHICLE_HISTORY_ENABLED !== "1") {
    return NextResponse.json({ error: "Sharing management is not authorized." }, { status: 403, headers });
  }
  let policy;
  try { policy = validateHistoryPolicy(await req.json()); }
  catch { return NextResponse.json({ error: "Invalid sharing policy." }, { status: 400, headers }); }
  try {
    const context = await historyBudget()(() => historySettingsContext(session.email, Number(session.shopId), session.role));
    if (!context?.canManage ||
        policy.shopIds.some(id => !context.locations.some(l => l.shopId === id)) ||
        (policy.enabled && !policy.shopIds.includes(Number(session.shopId)))) {
      return NextResponse.json({ error: "Every selected location requires explicit owner/admin access." }, { status: 403, headers });
    }
    const saved = await saveHistoryPolicy(context.enterpriseId, policy);
    if (!saved) return NextResponse.json({ error: "Sharing settings changed. Reload before saving." }, { status: 409, headers });
    return NextResponse.json({ policy: saved }, { headers });
  } catch {
    return NextResponse.json({ error: "Sharing settings could not be saved." }, { status: 503, headers });
  }
}
