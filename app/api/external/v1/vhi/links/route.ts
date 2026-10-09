import { createExternalEndpoint } from "@/lib/external-api/middleware";
import { receiveVhiLink } from "@/lib/external-api/vhi-link-webhook";
import { getDb } from "@/lib/mongo";
import { findShopByShopId } from "@/lib/data/repositories/shops";
import { getFeatureEntitlements } from "@/lib/featureResolver";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const POST = createExternalEndpoint("vhi:write", (req, context) =>
  receiveVhiLink(req, context, {
    getDb,
    shopExists: async (id) => Boolean(await findShopByShopId(id, { shopId: 1 })),
    canUseVhi: async (id) => (await getFeatureEntitlements(id, { throwIfMissing: true })).canUseFeature("maintenance"),
  }),
);
