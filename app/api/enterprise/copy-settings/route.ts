import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { getEnterpriseByShopId } from "@/lib/enterprise";
import {
  findShopByShopId,
  listShopsByShopIds,
  replaceShopLogoMedia,
  replaceSharedSettingsForShop,
} from "@/lib/data/repositories/shops";
import {
  PROTECTED_STICKER_FIELDS,
  buildEnterpriseSettingsReplacement,
  canManageEnterpriseSettingSelection,
  canManageEnterpriseSettings,
  parseEnterpriseSettingCategories,
  snapshotEnterpriseSettings,
  type EnterpriseSettingCategory,
} from "@/lib/enterprise-settings-catalog";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type CopyOptions = {
  forceCategory?: EnterpriseSettingCategory;
  legacyStickerResponse?: boolean;
};

function numericShopId(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const result = Number(value);
  return Number.isSafeInteger(result) && result > 0 ? result : null;
}

async function context() {
  const session = await getSession();
  if (!session) {
    return { response: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  }
  if (!canManageEnterpriseSettings(session)) {
    return { response: NextResponse.json({ error: "Permission denied" }, { status: 403 }) };
  }
  const currentShopId = numericShopId(session.shopId);
  if (currentShopId === null) {
    return { response: NextResponse.json({ error: "Session shop is invalid" }, { status: 400 }) };
  }
  const enterprise = await getEnterpriseByShopId(currentShopId);
  const enterpriseShopIds = [
    ...new Set((enterprise?.shopIds ?? []).map(Number).filter(Number.isSafeInteger)),
  ];
  if (!enterprise || !enterpriseShopIds.includes(currentShopId)) {
    return { response: NextResponse.json({ error: "Not part of an enterprise" }, { status: 400 }) };
  }
  return { session, currentShopId, enterprise, enterpriseShopIds };
}

export async function GET(req: NextRequest) {
  const ctx = await context();
  if ("response" in ctx) return ctx.response;

  const { searchParams } = new URL(req.url);
  const sourceShopId = numericShopId(searchParams.get("sourceShopId"));
  if (sourceShopId === null) {
    return NextResponse.json({ error: "Source shop ID is required" }, { status: 400 });
  }
  if (!ctx.enterpriseShopIds.includes(sourceShopId)) {
    return NextResponse.json({ error: "Source shop not in your enterprise" }, { status: 403 });
  }

  let categories: EnterpriseSettingCategory[];
  try {
    categories = parseEnterpriseSettingCategories(searchParams.get("type"));
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Invalid setting type" },
      { status: 400 },
    );
  }
  if (!canManageEnterpriseSettingSelection(ctx.session, categories)) {
    return NextResponse.json({ error: "Permission denied" }, { status: 403 });
  }

  const sourceShop = await findShopByShopId<any>(sourceShopId);
  if (!sourceShop) {
    return NextResponse.json({ error: "Source shop not found" }, { status: 404 });
  }

  try {
    const sourceSettings = snapshotEnterpriseSettings(sourceShop, categories);
    const enterpriseShops = await listShopsByShopIds(ctx.enterpriseShopIds);
    const destinationShops = enterpriseShops.filter(
      (shop) => Number(shop.shopId) !== sourceShopId,
    );
    const categoryStatuses = Object.fromEntries(
      categories.map((category) => {
        const sourceValue = JSON.stringify(sourceSettings[category]);
        const matchingCount = destinationShops.filter((shop) => {
          const destination = snapshotEnterpriseSettings(shop, [category]);
          return JSON.stringify(destination[category]) === sourceValue;
        }).length;
        const differingCount = destinationShops.length - matchingCount;
        return [
          category,
          {
            consistent: differingCount === 0,
            matchingCount,
            differingCount,
            destinationCount: destinationShops.length,
          },
        ];
      }),
    );
    return NextResponse.json({
      ok: true,
      sourceShopId,
      sourceShopName: sourceShop.name || `Shop ${sourceShopId}`,
      categories,
      settings: sourceSettings,
      categoryStatuses,
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Invalid source settings" },
      { status: 409 },
    );
  }
}

function requestedDestinations(
  body: any,
  currentShopId: number,
  sourceShopId: number,
  enterpriseShopIds: number[],
  legacyStickerResponse: boolean,
) {
  const all =
    body.applyToAllLocations === true ||
    body.copyToAll === true ||
    body.destination === "allOther" ||
    body.destinationShopId === "all";
  if (all) return enterpriseShopIds.filter((id) => id !== sourceShopId);

  const supplied =
    body.destinationShopIds ??
    body.targetShopIds ??
    (body.destinationShopId !== undefined ? [body.destinationShopId] : undefined);
  if (supplied !== undefined) {
    if (!Array.isArray(supplied)) throw new Error("Destination shop IDs must be an array");
    const parsed = supplied.map(numericShopId);
    if (parsed.some((id) => id === null)) throw new Error("Destination shop ID is invalid");
    const ids = [...new Set(parsed as number[])];
    return legacyStickerResponse ? ids.filter((id) => id !== sourceShopId) : ids;
  }
  return [currentShopId];
}

export async function copySettingsPost(
  req: NextRequest,
  options: CopyOptions = {},
) {
  const ctx = await context();
  if ("response" in ctx) return ctx.response;

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const sourceShopId = numericShopId(body.sourceShopId);
  if (sourceShopId === null) {
    return NextResponse.json({ error: "Source shop ID is required" }, { status: 400 });
  }
  if (!ctx.enterpriseShopIds.includes(sourceShopId)) {
    return NextResponse.json({ error: "Source shop not in your enterprise" }, { status: 403 });
  }

  let categories: EnterpriseSettingCategory[];
  let destinationShopIds: number[];
  try {
    categories = options.forceCategory
      ? [options.forceCategory]
      : parseEnterpriseSettingCategories(body.settingTypes ?? body.type);
    destinationShopIds = requestedDestinations(
      body,
      ctx.currentShopId,
      sourceShopId,
      ctx.enterpriseShopIds,
      options.legacyStickerResponse === true,
    );
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Invalid copy request" },
      { status: 400 },
    );
  }
  if (!canManageEnterpriseSettingSelection(ctx.session, categories)) {
    return NextResponse.json({ error: "Permission denied" }, { status: 403 });
  }
  if (destinationShopIds.length === 0) {
    return NextResponse.json({ error: "At least one destination shop is required" }, { status: 400 });
  }
  if (destinationShopIds.some((id) => !ctx.enterpriseShopIds.includes(id))) {
    return NextResponse.json({ error: "Destination shop not in your enterprise" }, { status: 403 });
  }

  const sourceShop = await findShopByShopId<any>(sourceShopId);
  if (!sourceShop) {
    return NextResponse.json({ error: "Source shop not found" }, { status: 404 });
  }

  let snapshot;
  let replacements;
  try {
    // Snapshot once before any write, including when source is also selected.
    snapshot = snapshotEnterpriseSettings(sourceShop, categories);
    replacements = buildEnterpriseSettingsReplacement(snapshot, categories);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Invalid source settings" },
      { status: 409 },
    );
  }

  const destinationShops = await listShopsByShopIds(destinationShopIds);
  const shopsById = new Map(
    destinationShops.map((shop) => [Number(shop.shopId), shop]),
  );
  const results: Array<{
    shopId: number;
    shopName: string;
    success: boolean;
    matchedCount: number;
    modifiedCount: number;
    error?: string;
  }> = [];

  for (const destinationShopId of destinationShopIds) {
    const destinationShop = shopsById.get(destinationShopId);
    const shopName = destinationShop?.name || `Shop ${destinationShopId}`;
    if (!destinationShop) {
      results.push({
        shopId: destinationShopId,
        shopName,
        success: false,
        matchedCount: 0,
        modifiedCount: 0,
        error: "Destination shop was not found",
      });
      continue;
    }
    try {
      const result = await replaceSharedSettingsForShop(
        destinationShopId,
        replacements,
      );
      const matchedCount = result.matchedCount ?? 0;
      if (matchedCount === 1 && categories.includes("stickers")) {
        await replaceShopLogoMedia(sourceShopId, destinationShopId);
      }
      results.push({
        shopId: destinationShopId,
        shopName,
        success: matchedCount === 1,
        matchedCount,
        modifiedCount: result.modifiedCount ?? 0,
        ...(matchedCount === 1 ? {} : { error: "Destination shop was not updated" }),
      });
    } catch (error) {
      results.push({
        shopId: destinationShopId,
        shopName,
        success: false,
        matchedCount: 0,
        modifiedCount: 0,
        error: error instanceof Error ? error.message : "Failed to copy settings",
      });
    }
  }

  const successCount = results.filter((result) => result.success).length;
  const failCount = results.length - successCount;
  return NextResponse.json(
    {
      ok: successCount > 0,
      partialFailure: failCount > 0,
      message: `Copied settings to ${successCount} location(s)${failCount ? `, ${failCount} failed` : ""}`,
      sourceShopId,
      copiedTypes: categories,
      destinationShopIds,
      successCount,
      failCount,
      matchedCount: results.reduce((sum, result) => sum + result.matchedCount, 0),
      updatedCount: results.reduce((sum, result) => sum + result.modifiedCount, 0),
      results,
      ...(categories.includes("stickers")
        ? {
            copiedFields: Object.keys(replacements)
              .filter((key) => key.startsWith("stickerConfig."))
              .map((key) => key.slice("stickerConfig.".length)),
            preservedFields: [...PROTECTED_STICKER_FIELDS],
          }
        : {}),
    },
    { status: successCount === 0 ? 409 : 200 },
  );
}

export async function POST(req: NextRequest) {
  return copySettingsPost(req);
}