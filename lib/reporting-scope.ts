import type { SessionInfo } from "@/lib/auth";
import { getEnterpriseById } from "@/lib/enterprise";
import {
  findShopByShopId,
  listAllShops,
  listShopsByShopIds,
} from "@/lib/data/repositories/shops";
import { listReportingUserShopAssignments } from "@/lib/data/repositories/reporting-scope";
import {
  REPORTING_MAX_SHOPS,
  restrictToAssignedShops,
  type ReportingScopeKind,
} from "@/lib/reporting-kpi-contract";

export class ReportingScopeError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

export interface ResolvedReportingScope {
  kind: ReportingScopeKind;
  shopIds: number[];
  enterpriseId?: string;
  shops: Array<{ shopId: number; name: string; locationIdentifier: string | null }>;
}

function numericIds(values: unknown[]): number[] {
  return [...new Set(values.map(Number).filter((n) => Number.isSafeInteger(n) && n > 0))];
}

async function assignedShopIds(session: SessionInfo): Promise<number[]> {
  const docs = await listReportingUserShopAssignments(session.email) as Array<{
    shopId?: unknown;
    shopIds?: unknown[];
  }>;
  return numericIds([
    session.shopId,
    ...docs.flatMap((doc) => [doc.shopId, ...(Array.isArray(doc.shopIds) ? doc.shopIds : [])]),
  ]);
}

export async function resolveReportingScope(
  session: SessionInfo,
  request: { kind?: string | null; shopId?: string | null; enterpriseId?: string | null },
): Promise<ResolvedReportingScope> {
  const isPlatform = Boolean(session.isPlatformAdmin || session.role === "platform_admin");
  const kind = (request.kind || "shop") as ReportingScopeKind;
  if (!["shop", "enterprise", "platform"].includes(kind)) {
    throw new ReportingScopeError("Invalid reporting scope", 400);
  }

  let shopIds: number[] = [];
  let enterpriseId: string | undefined;
  if (kind === "platform") {
    if (!isPlatform) throw new ReportingScopeError("Platform reporting requires platform admin access", 403);
    shopIds = numericIds((await listAllShops()).map((shop) => shop.shopId));
  } else if (kind === "enterprise") {
    if (!request.enterpriseId) throw new ReportingScopeError("enterpriseId is required", 400);
    const enterprise = await getEnterpriseById(request.enterpriseId);
    if (!enterprise) throw new ReportingScopeError("Enterprise not found", 404);
    enterpriseId = String(enterprise._id);
    const enterpriseIds = numericIds(enterprise.shopIds || []);
    if (isPlatform) {
      shopIds = enterpriseIds;
    } else {
      if (!["owner", "admin"].includes(session.role || "")) {
        throw new ReportingScopeError("Enterprise reporting requires owner or admin access", 403);
      }
      const homeShop = await findShopByShopId(session.shopId);
      if (String(session.enterpriseId || homeShop?.enterpriseId || "") !== enterpriseId) {
        throw new ReportingScopeError("Enterprise is outside your assigned scope", 403);
      }
      shopIds = restrictToAssignedShops(enterpriseIds, await assignedShopIds(session));
    }
  } else {
    const requestedId = request.shopId ? Number(request.shopId) : Number(session.shopId);
    if (!Number.isSafeInteger(requestedId) || requestedId <= 0) {
      throw new ReportingScopeError("Valid shopId is required", 400);
    }
    if (!isPlatform && restrictToAssignedShops([requestedId], await assignedShopIds(session)).length === 0) {
      throw new ReportingScopeError("Shop is outside your assigned scope", 403);
    }
    shopIds = [requestedId];
  }

  if (shopIds.length === 0) throw new ReportingScopeError("No authorized shops in scope", 403);
  if (shopIds.length > REPORTING_MAX_SHOPS) {
    throw new ReportingScopeError(`Reporting scope exceeds ${REPORTING_MAX_SHOPS} shops`, 400);
  }
  const shops = await listShopsByShopIds(shopIds);
  const existingIds = new Set(shops.map((s) => Number(s.shopId)));
  shopIds = shopIds.filter((id) => existingIds.has(id));
  if (!shopIds.length) throw new ReportingScopeError("No reporting shops found", 404);
  return {
    kind,
    shopIds,
    enterpriseId,
    shops: shops.map((s) => ({
      shopId: Number(s.shopId),
      name: s.name || `Shop ${s.shopId}`,
      locationIdentifier: s.locationIdentifier || null,
    })),
  };
}
