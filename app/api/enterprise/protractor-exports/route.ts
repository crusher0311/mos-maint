import { randomBytes } from "node:crypto";
import { ObjectId } from "mongodb";
import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { authorizeManager, authorizeShop } from "@/lib/protractor-exports/authorization";
import { historyEnterprisesForShop } from "@/lib/data/repositories/vehicle-history-policy";
import { collections, exportEnterprise, prerequisites, workerAvailable } from "@/lib/protractor-exports/store";
import { validateSettings, type ExportConfig } from "@/lib/protractor-exports/contract";
import { protectSecret, resolveDestination } from "@/lib/protractor-exports/transport";
import { retryExportState } from "@/lib/protractor-exports/retry";
import { stateId } from "@/lib/protractor-exports/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const response = (data: unknown, status = 200) => NextResponse.json(data, {
  status, headers: { "Cache-Control": "no-store" },
});
async function context(id: unknown) {
  const session = await getSession();
  if (!session) throw new Error("Unauthorized");
  if (typeof id !== "string" || !ObjectId.isValid(id)) throw new Error("Invalid enterprise");
  await authorizeManager(session, id);
  return { session, id };
}
function failure(e: unknown) {
  const message = e instanceof Error ? e.message : "";
  if (message === "Unauthorized") return response({ error: message }, 401);
  if (message === "Permission denied") return response({ error: message }, 403);
  // Never expose database errors or DNS details.
  return response({ error: "Export operation unavailable. Check approval, shop ownership, entitlement, public destination, worker and operator prerequisites." }, 400);
}
export async function GET(req: Request) {
  try {
    const { session, id } = await context(new URL(req.url).searchParams.get("enterpriseId"));
    const c = await collections(), config = await c.configs.findOne({ _id: id });
    const memberships = await historyEnterprisesForShop(Number(session.shopId));
    const membership = memberships.find(e => e.id === id);
    // Platform admins may manage an explicit target; enterprise IDs never
    // authorize a shop implicitly. Read target members through canonical identity.
    const enterprise = await exportEnterprise(id);
    let ids = membership?.shopIds ?? enterprise?.shopIds?.map(Number) ?? [];
    const shops = [];
    for (const shopId of ids) {
      try { shops.push(await authorizeShop(id, shopId)); } catch { /* not eligible */ }
    }
    const status = config ? await c.states.find({ enterpriseId: id, revision: config.revision },
      { projection: { pending: 0, lease: 0, leaseUntil: 0 } }).limit(50).toArray() : [];
    const pending = config ? await c.states.find({ enterpriseId: id, revision: config.revision },
      { projection: { shopId: 1, "pending.deliveryId": 1 } }).limit(50).toArray() : [];
    const history = await c.history.find({ enterpriseId: id }).sort({ acceptedAt: -1 }).limit(100).toArray();
    return response({ enterprise: { id, name: enterprise?.name ?? "Enterprise" }, shops,
      config: config ? { revision: config.revision, destination: config.destination, shopIds: config.shopIds,
        timeZone: config.timeZone, dailyTime: config.dailyTime, initialSnapshot: config.initialSnapshot,
        paused: config.paused, revoked: config.revoked, confirmedAt: config.confirmedAt } : null,
      status: status.map(s => ({ shopId: s.shopId, window: s.window, lastSuccess: s.lastSuccess,
        failure: s.failure, coverage: s.coverage, attempts: s.attempts,
        pendingDeliveryId: pending.find(p => p.shopId === s.shopId)?.pending?.deliveryId })),
      history: history.map(h => ({ deliveryId: h._id, shopId: h.shopId, window: h.window,
        acceptedAt: h.acceptedAt, recordCount: h.recordCount })),
      workerAvailable: await workerAvailable(), enabled: process.env.PROTRACTOR_EXPORTS_ENABLED === "1" });
  } catch (e) { return failure(e); }
}
export async function POST(req: Request) {
  try {
    // Same-origin session writes only; no partner credential or cookie-only CSRF.
    if (req.headers.get("origin") !== new URL(req.url).origin) return response({ error: "Permission denied" }, 403);
    const text = await req.text();
    if (Buffer.byteLength(text) > 8192) return response({ error: "Request too large" }, 413);
    const input = JSON.parse(text), { session, id } = await context(input.enterpriseId);
    const c = await collections(), previous = await c.configs.findOne({ _id: id });
    if ((previous?.revision ?? null) !== input.revision) return response({ error: "Configuration changed; reload first" }, 409);
    if (input.action === "configure") {
      const settings = validateSettings(input);
      await prerequisites();
      const { url } = await resolveDestination(input.destination);
      for (const shopId of settings.shopIds) await authorizeShop(id, shopId);
      const revision = (previous?.revision ?? 0) + 1, signingSecret = randomBytes(32).toString("hex");
      const config: ExportConfig = { _id: id, revision, destination: url.toString(), ...settings,
        paused: true, revoked: false, confirmedAt: new Date().toISOString(),
        approvedBy: String(session.email),
        secret: protectSecret(signingSecret, `${id}:${revision}`) };
      if (previous) {
        const result = await c.configs.replaceOne({ _id: id, revision: previous.revision }, config);
        if (!result.matchedCount) return response({ error: "Configuration changed; reload first" }, 409);
      } else {
        try { await c.configs.insertOne(config); }
        catch { return response({ error: "Configuration changed; reload first" }, 409); }
      }
      // Old revision is no longer send-authorized; remove retained customer bodies.
      await c.states.updateMany({ enterpriseId: id, revision: { $ne: revision } },
        { $unset: { pending: "" }, $set: { failure: "configuration_replaced" } });
      return response({ ok: true, signingSecret });
    }
    if (!previous) return response({ error: "Configure a destination first" }, 400);
    if (input.action === "resume") {
      if (previous.revoked || input.contractConfirmed !== true) return response({ error: "Reconfigure and confirm redistribution first" }, 400);
      if (process.env.PROTRACTOR_EXPORTS_ENABLED !== "1" || !await workerAvailable())
        return response({ error: "Export worker or rollout flag unavailable" }, 503);
      await prerequisites();
      await resolveDestination(previous.destination);
      for (const shopId of previous.shopIds) await authorizeShop(id, shopId);
    } else if (input.action === "retry") {
      if (!previous.shopIds.includes(input.shopId) || previous.paused || previous.revoked)
        return response({ error: "Resume an approved shop before retrying" }, 400);
      await authorizeShop(id, input.shopId);
      if (process.env.PROTRACTOR_EXPORTS_ENABLED !== "1" || !await workerAvailable())
        return response({ error: "Export worker or rollout flag unavailable" }, 503);
      if (!await retryExportState(c.states, stateId(previous, input.shopId)))
        return response({ error: "No retryable failure, payload expired, or work is still running. Refresh status." }, 409);
      return response({ ok: true });
    } else if (!["pause", "revoke"].includes(input.action)) return response({ error: "Invalid action" }, 400);
    const result = await c.configs.updateOne({ _id: id, revision: previous.revision,
      ...(input.action === "resume" ? { revoked: false } : {}) },
    { $set: { paused: input.action !== "resume",
      ...(input.action === "revoke" ? { revoked: true, secret: "" } : {}) } });
    if (!result.matchedCount) return response({ error: "Configuration changed; reload first" }, 409);
    if (input.action === "revoke") await c.states.updateMany({ enterpriseId: id },
      { $unset: { pending: "" }, $set: { failure: "authorization_revoked" } });
    return response({ ok: true });
  } catch (e) { return failure(e); }
}
