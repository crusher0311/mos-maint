import { DurableError, type Reply, type Scope } from "./model";
import { DurablePushService } from "./service";
import type { VerifiedProtractorCapabilities } from "./protractor-provider";

/** Reviewed enrollment is permanent even when admissions are switched off.
 * NEVER remove an enrolled shop to roll back: it must not use the legacy writer
 * while durable records exist. Empty by default; no runtime provisioning. */
export const DURABLE_DVI_ENROLLMENTS: Readonly<Record<number, {
  admissions: boolean; capabilities?: VerifiedProtractorCapabilities;
}>> = Object.freeze({});

export async function durableService(shopId: number): Promise<DurablePushService | null> {
  const policy = DURABLE_DVI_ENROLLMENTS[shopId];
  if (!policy) return null;
  const [{ getDb, getMongoClient }, { MongoDviStore }, { Repository }, { ProtractorDurableProvider },
    { buildRecommendedWorkPackages }] = await Promise.all([
    import("@/lib/mongo"), import("@/lib/data/repositories/auto-dvi-durable"), import("./repository"),
    import("./protractor-provider"), import("../recommended-work"),
  ]);
  const store = new MongoDviStore(await getMongoClient(), await getDb());
  await store.ready();
  return new DurablePushService({repository: new Repository(store), admissions: policy.admissions,
    provider: new ProtractorDurableProvider(policy.capabilities),
    price: async (id, request) => request.recommendedItems.length
      ? (await buildRecommendedWorkPackages({shopId: id, items: request.recommendedItems})).packages : [],
  });
}
export function durableFailure(error: unknown): Reply {
  return {status: error instanceof DurableError ? error.status : 503, body: {
    ok: false, error: error instanceof DurableError ? error.code : "STORE_UNAVAILABLE",
    recoveryAllowed: false, nextAction: "verify", outcome: "uncertain",
    message: "Verification is required. Do not resend the inspection or create a replacement request.",
  }};
}
/** Called after each channel's existing authentication + entitlement guard, and
 * before its legacy filtering/pricing. Transport metadata is not request content. */
export async function tryDurablePush(scope: Scope, raw: unknown, channel: "dashboard" | "extension"): Promise<Reply | null> {
  try {
    const service = await durableService(scope.shopId);
    if (!service) return null;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new DurableError("INVALID_REQUEST", 400);
    const body = {...raw as Record<string, unknown>};
    if (channel === "extension") {
      delete body.shopId; delete body.provider;
      // roId is Tekmetric-only; accepting it for Protractor would hash a target
      // different from the one we actually use.
    }
    const {runWithProtractorInteractiveTransport} = await import("@/lib/integrations/protractor/interactive-context");
    return await runWithProtractorInteractiveTransport(scope.shopId, () => service.push(scope, body));
  } catch (error) { return durableFailure(error); }
}
