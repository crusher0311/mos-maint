import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import {
  APPFUELED_PROVIDERS,
  AppFueledMappingValidationError,
  createAppFueledMapping,
  disableAppFueledMapping,
  listAppFueledMappings,
  updateAppFueledMapping,
  type AppFueledProvider,
} from "@/lib/data/repositories/appfueled-shop-mappings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function authorize() {
  const session = await getSession();
  return session?.isPlatformAdmin ? session : null;
}

function parseInput(body: any) {
  const externalShopId = typeof body?.externalShopId === "string" ? body.externalShopId.trim() : "";
  const mosShopId = Number(body?.mosShopId);
  const provider = String(body?.provider || "").toLowerCase() as AppFueledProvider;
  if (!externalShopId) throw new Error("externalShopId is required");
  if (!Number.isInteger(mosShopId) || mosShopId <= 0) throw new Error("mosShopId must be a positive integer");
  if (!APPFUELED_PROVIDERS.includes(provider)) throw new Error("provider is invalid");
  return { externalShopId, mosShopId, provider };
}

export async function GET() {
  if (!await authorize()) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  return NextResponse.json({ success: true, mappings: await listAppFueledMappings() });
}

export async function POST(req: NextRequest) {
  const session = await authorize();
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  try {
    const mapping = await createAppFueledMapping(parseInput(await req.json()), session.email || "platform_admin");
    return NextResponse.json({ success: true, mapping }, { status: 201 });
  } catch (error) {
    const status = error instanceof AppFueledMappingValidationError ? 409 : 400;
    return NextResponse.json({ error: error instanceof Error ? error.message : "Invalid mapping" }, { status });
  }
}

export async function PATCH(req: NextRequest) {
  const session = await authorize();
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  try {
    const body = await req.json();
    const currentExternalShopId = String(body?.currentExternalShopId || body?.externalShopId || "").trim();
    if (!currentExternalShopId) throw new Error("currentExternalShopId is required");
    const actor = session.email || "platform_admin";
    const mapping = body.isActive === false
      ? await disableAppFueledMapping(currentExternalShopId, actor)
      : await updateAppFueledMapping(
          currentExternalShopId,
          { ...parseInput(body), ...(typeof body.isActive === "boolean" ? { isActive: body.isActive } : {}) },
          actor,
        );
    if (!mapping) return NextResponse.json({ error: "Mapping not found" }, { status: 404 });
    return NextResponse.json({ success: true, mapping });
  } catch (error) {
    const status = error instanceof AppFueledMappingValidationError ? 409 : 400;
    return NextResponse.json({ error: error instanceof Error ? error.message : "Invalid mapping" }, { status });
  }
}