import { DurableError, type Reply, type Scope } from "./model";
import { DurablePushService } from "./service";
import type { VerifiedProtractorCapabilities } from "./protractor-provider";
import { digest, parseRequest } from "./model";

/** Reviewed enrollment is permanent even when admissions are switched off.
 * NEVER remove an enrolled shop to roll back: it must not use the legacy writer
 * while durable records exist. Empty by default; no runtime provisioning. */
export const DURABLE_DVI_ENROLLMENTS: Readonly<Record<number, {
  admissions: boolean; recovery?: boolean; capabilities?: VerifiedProtractorCapabilities;
}>> = Object.freeze({});

async function durableDependencies(shopId: number) {
  const policy = DURABLE_DVI_ENROLLMENTS[shopId];
  if (!policy) return null;
  const [{ getDb, getMongoClient }, { MongoDviStore }, { Repository }, { ProtractorDurableProvider },
    { buildRecommendedWorkPackages }] = await Promise.all([
    import("@/lib/mongo"), import("@/lib/data/repositories/auto-dvi-durable"), import("./repository"),
    import("./protractor-provider"), import("../recommended-work"),
  ]);
  const store = new MongoDviStore(await getMongoClient(), await getDb());
  await store.ready();
  return {repository: new Repository(store), admissions: policy.admissions,
    provider: new ProtractorDurableProvider(policy.capabilities),
    price: async (id: number, request: import("./model").Request) => request.recommendedItems.length
      ? (await buildRecommendedWorkPackages({shopId: id, items: request.recommendedItems})).packages : [],
  };
}
export async function durableService(shopId: number): Promise<DurablePushService | null> {
  const deps = await durableDependencies(shopId);
  return deps ? new DurablePushService(deps) : null;
}

export async function durableRecoveryService(shopId: number) {
  const deps = await durableDependencies(shopId);
  if (!deps) throw new DurableError("DURABLE_NOT_ENROLLED", 404);
  const [{RecoveryService}, {assertRecoveryOperator}] = await Promise.all([import("./recovery"), import("./access")]);
  return new RecoveryService({...deps, service: new DurablePushService(deps),
    enabled: DURABLE_DVI_ENROLLMENTS[shopId].recovery === true, authorize: assertRecoveryOperator});
}
export function durableFailure(error: unknown): Reply {
  return {status: error instanceof DurableError ? error.status : 503, body: {
    ok: false, error: error instanceof DurableError ? error.code : "STORE_UNAVAILABLE",
    recoveryAllowed: false, nextAction: "verify", outcome: "uncertain",
    message: "Verification is required. Do not resend the inspection or create a replacement request.",
  }};
}
/** Authenticated context, never a VIN-only choice of the first open order. */
export async function discoverDurableTarget(scope: Scope, params: URLSearchParams): Promise<Reply> {
  const service = await durableService(scope.shopId);
  if (!service) return {status: 200, body: {ok: true, durable: false}};
  const target = params.get("workOrderGuid") || params.get("roNumber") || "";
  if (!/^(?:[0-9]+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.test(target))
    throw new DurableError("EXACT_WORK_ORDER_REQUIRED", 400);
  const {resolveWorkOrderGuid} = await import("@/lib/integrations/protractor");
  const resolved = await resolveWorkOrderGuid(scope.shopId, target);
  if (!resolved.ok || !resolved.workOrderGuid) throw new DurableError("UNVERIFIED_TARGET");
  const {request} = parseRequest({
    clientRequestId: "discovery", workOrderGuid: resolved.workOrderGuid,
    vin: params.get("vin"), roNumber: params.get("roNumber"),
    items: [{name: "Target verification"}],
  });
  const operation = await service.discover(scope, request);
  return {status: 200, body: {
    ok: true, durable: true, scopeKey: digest([scope.shopId, scope.actor]),
    workOrderGuid: request.workOrderGuid, vin: request.vin,
    operation: operation?.body || null,
  }};
}
/** Called after each channel's existing authentication + entitlement guard, and
 * before its legacy filtering/pricing. Transport metadata is not request content. */
export async function tryDurablePush(scope: Scope, raw: unknown, channel: "dashboard" | "extension"): Promise<Reply | null> {
  try {
    // Permanent pilot routing fence, including rollback. The visit-scoped
    // accepted-risk writer must never overlap either legacy VIN writer.
    if (scope.shopId === 66) return {status: 409, body: {ok: false,
      error: "WORKFLOW_SYNTHETIC_PILOT_ONLY", recoveryAllowed: false,
      message: "CAR Experts test inspections must be sent from the saved Shop Workflow visit. Legacy pushes are disabled, including during pilot rollback."}};
    const service = await durableService(scope.shopId);
    if (!service) return null;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new DurableError("INVALID_REQUEST", 400);
    const body = {...raw as Record<string, unknown>};
    // Reject a session/shop switch between discovery and submission.
    if (body.clientScopeKey !== digest([scope.shopId, scope.actor])) throw new DurableError("CLIENT_SCOPE_CHANGED", 403);
    delete body.clientScopeKey;
    if (channel === "extension") {
      delete body.shopId; delete body.provider;
      // roId is Tekmetric-only; accepting it for Protractor would hash a target
      // different from the one we actually use.
    }
    const {runWithProtractorInteractiveTransport} = await import("@/lib/integrations/protractor/interactive-context");
    return await runWithProtractorInteractiveTransport(scope.shopId, () => service.push(scope, body));
  } catch (error) { return durableFailure(error); }
}
