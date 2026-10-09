import { createExternalEndpoint } from "@/lib/external-api/middleware";
import { receiveVhiLink } from "@/lib/external-api/vhi-link-webhook";
import { getDb } from "@/lib/mongo";
import { findShopByShopId } from "@/lib/data/repositories/shops";
import { getFeatureEntitlements } from "@/lib/featureResolver";
import { createAppFueledLinkEndpoint } from "@/lib/external-api/appfueled-native-webhook";
import { resolveAppFueledConnection, admitAppFueledWebhook } from "@/lib/data/repositories/appfueled-connections";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const deps = {
    getDb,
    shopExists: async (id: number) => Boolean(await findShopByShopId(id, { shopId: 1 })),
    canUseVhi: async (id: number) => (await getFeatureEntitlements(id, { throwIfMissing: true })).canUseFeature("maintenance"),
};
const legacy = createExternalEndpoint("vhi:write", async (req, context) => {
  try { return await receiveVhiLink(req, context, deps); }
  catch { return NextResponse.json({ error: "Webhook temporarily unavailable", requestId: context.requestId }, { status: 503 }); }
});
export const POST = createAppFueledLinkEndpoint(legacy, {
  ...deps, resolveConnection: resolveAppFueledConnection, admit: admitAppFueledWebhook,
});
