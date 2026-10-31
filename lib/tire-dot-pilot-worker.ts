import { randomUUID } from "node:crypto";
import type { Db } from "mongodb";
import { PILOT_CONTROL, PILOT_MAX_REQUESTS, PILOT_PAGE_SIZE, PILOT_RANGE,
  pilotEvidence, pilotHash, pilotInRange, validatePilotPage } from "./tire-dot-pilot";
import { reconciliationWindow } from "./integrations/tekmetric/reconciliation-policy";

export interface PilotLocation { shopId: number; providerShopId: number; timezone: string }
export interface PilotWorkerDeps {
  now(): Date;
  locations(enterpriseId: string): Promise<PilotLocation[]>;
  page(location: PilotLocation, page: number, beforeRequest: () => Promise<void>): Promise<any>;
  manualBudget?: { available(): boolean; admit(): void };
}
export const pilotWindow = (location: PilotLocation, now: Date) =>
  reconciliationWindow({ ...location, startHour: 1, endHour: 5, enabled: true }, now);

/** Exactly one bounded page. Durable checkpoints survive process exits.
 * Only reporting collections are written; no provider or invoice write API. */
export async function tickTirePilot(db: Db, deps: PilotWorkerDeps) {
  const controls = db.collection<any>("tire_dot_pilot_control");
  const builds = db.collection<any>("tire_dot_pilot_generations");
  const evidence = db.collection<any>("tire_dot_pilot_evidence");
  const now = deps.now();
  const windowOpen = (location: PilotLocation, at: Date) => deps.manualBudget
    ? deps.manualBudget.available() : pilotWindow(location, at);
  const lease = randomUUID();
  const control = await controls.findOneAndUpdate({
    _id: PILOT_CONTROL, enabled: true, nextAt: { $lte: now },
    $or: [{ leaseUntil: { $exists: false } }, { leaseUntil: { $lt: now } }],
  }, { $set: { lease, leaseUntil: new Date(now.getTime() + 90_000) } }, { returnDocument: "after", maxTimeMS: 2000 });
  if (!control) return { status: "idle" };
  const owned = { _id: PILOT_CONTROL, lease };
  const release = async (status: string, delay: number, extra: Record<string, any> = {}) => {
    await controls.updateOne({ ...owned, enabled: true, leaseUntil: { $gt: deps.now() } }, { $set: { status, failureHttpStatus: null, nextAt: new Date(deps.now().getTime() + delay), ...extra },
      $unset: { lease: "", leaseUntil: "" } });
    return { status };
  };
  let build: any;
  try {
    if (control.captureUntil && now >= new Date(control.captureUntil))
      return release("refresh_window_ended", 24 * 60 * 60_000);
    const locations = (await deps.locations(control.enterpriseId)).sort((a, b) => a.shopId - b.shopId);
    if (!locations.length || locations.length > 50 ||
        new Set(locations.map(l => l.shopId)).size !== locations.length) throw Error("scope_invalid");
    const scopeHash = pilotHash(locations);
    build = control.build && await builds.findOne({ _id: control.build });
    if (build && build.scopeHash !== scopeHash) throw Error("scope_changed");
    if (build?.state === "published") return release("ready", 6 * 60 * 60_000, {
      published: build._id, build: null, finishedAt: build.finishedAt, failure: null,
      invoiceCount: build.locations.reduce((n: number, l: any) => n + l.invoices, 0),
    });
    if (build?.state === "failed") build = null;
    if (!build) {
      if (!locations.every(l => windowOpen(l, now))) return release("waiting_for_overnight_window", 60_000);
      build = { _id: randomUUID(), enterpriseId: control.enterpriseId, scopeHash,
        start: PILOT_RANGE.start, end: PILOT_RANGE.end, startedAt: now.toISOString(),
        state: "building", pass: 0, shopIndex: 0, page: 0, requests: 0, locations,
        totals: {}, warnings: ["All provider-listed posted invoices were examined, not a tire-candidate or CSV sample.",
          "Two matching passes verify retained evidence, not a transactional provider snapshot. Missing DOT fields remain exceptions."] };
      await builds.insertOne(build);
      const linked = await controls.updateOne(owned, { $set: { build: build._id } });
      if (!linked.matchedCount) throw Error("lease_lost");
    }
    const publish = async () => {
      if (pilotHash((await deps.locations(control.enterpriseId)).sort((a, b) => a.shopId - b.shopId)) !== scopeHash)
        throw Error("scope_changed");
      const finishedAt = deps.now().toISOString();
      const coverage = [];
      for (const l of locations) coverage.push({ ...l, invoices: await evidence.countDocuments({
        generation: build._id, shopId: l.shopId, verified: true, inMonth: true,
      }, { maxTimeMS: 2000 }) });
      await builds.updateOne({ _id: build._id, state: "building" }, { $set: {
        state: "published", locations: coverage, finishedAt,
        finalMonth: Date.parse(build.startedAt) >= Date.parse("2026-11-01T00:00:00Z"),
      } });
      return release("ready", 6 * 60 * 60_000, { published: build._id, build: null, finishedAt,
        invoiceCount: coverage.reduce((n, l) => n + l.invoices, 0), failure: null });
    };
    // Recover a crash after the final checkpoint or after manifest publication.
    if (build.pass === 1 && build.shopIndex === locations.length) return publish();
    const location = build.locations[build.shopIndex] as PilotLocation;
    if (!windowOpen(location, now)) return release("waiting_for_overnight_window", 60_000);
    if (build.requests >= PILOT_MAX_REQUESTS) throw Error("request_limit");
    const page = await deps.page(location, build.page, async () => {
      // Limiter waits must not permit requests outside the window or old leases.
      const current = (await deps.locations(control.enterpriseId)).sort((a, b) => a.shopId - b.shopId);
      if (pilotHash(current) !== scopeHash) throw Error("scope_changed");
      if (!windowOpen(location, deps.now())) throw Error("window_closed");
      // Charge every physical attempt, including retries after limiter waits.
      // This allowance never replaces the durable cumulative request budget.
      deps.manualBudget?.admit();
      const renewed = await controls.updateOne({ ...owned, enabled: true,
        leaseUntil: { $gt: deps.now() }, $or: [
          { requestsUsed: { $exists: false } }, { requestsUsed: { $lt: PILOT_MAX_REQUESTS } },
        ] }, { $set: { leaseUntil: new Date(deps.now().getTime() + 90_000) }, $inc: { requestsUsed: 1 } });
      if (!renewed.matchedCount) {
        const currentControl = await controls.findOne({ _id: PILOT_CONTROL }, { projection: { requestsUsed: 1 } });
        throw Error(currentControl?.requestsUsed >= PILOT_MAX_REQUESTS ? "request_limit" : "lease_lost");
      }
      const counted = await builds.updateOne({ _id: build._id, requests: { $lt: PILOT_MAX_REQUESTS }, state: "building" },
        { $inc: { requests: 1 } });
      if (!counted.matchedCount) throw Error("request_limit");
    });
    validatePilotPage(page, build.page);
    const totalKey = String(location.shopId);
    if (build.totals[totalKey] !== undefined && build.totals[totalKey] !== page.totalElements)
      throw Error("provider_population_changed");
    build.totals[totalKey] = page.totalElements;
    const rows = page.content.map((raw: any) => {
      const data = pilotEvidence(raw, location.providerShopId);
      if (!Number.isFinite(Date.parse(data.postedDate)) || !Array.isArray(data.jobs) ||
          data.jobs.some((j: any) => typeof j.authorized !== "boolean" || !Array.isArray(j.parts)))
        throw Error("incomplete_invoice_payload");
      return { key: String(data.id), data, hash: pilotHash(data), inMonth: pilotInRange(data) };
    });
    if (new Set(rows.map((r: any) => r.key)).size !== rows.length) throw Error("duplicate_page_identity");
    // A stale lease cannot publish. Immutable-generation checks keep abandoned
    // work isolated; checkpoint CAS below prevents stale page advancement.
    const stillOwned = await controls.findOne({ ...owned, enabled: true, leaseUntil: { $gt: deps.now() } });
    if (!stillOwned) throw Error("lease_lost");
    if (build.pass === 0 && rows.length) {
      const prior = await evidence.find({ generation: build._id, shopId: location.shopId,
        key: { $in: rows.map((r: any) => r.key) } }, { projection: { key: 1, page: 1 } }).toArray();
      if (prior.some((r: any) => r.page !== build.page)) throw Error("duplicate_pagination_identity");
      await evidence.bulkWrite(rows.map((r: any) => ({ updateOne: {
        filter: { generation: build._id, shopId: location.shopId, key: r.key },
        // $setOnInsert makes a retried page immutable. The verification pass
        // will reject any source change across a crashed first-pass request.
        update: { $setOnInsert: { ...r, data: r.inMonth ? r.data : { id: r.data.id, shopId: r.data.shopId, postedDate: r.data.postedDate },
          generation: build._id, shopId: location.shopId, page: build.page, verified: false } }, upsert: true,
      } })));
    } else if (build.pass === 1) {
      for (const row of rows) {
        const matched = await evidence.updateOne({ generation: build._id, shopId: location.shopId,
          key: row.key, hash: row.hash, page: build.page }, { $set: { verified: true } });
        if (!matched.matchedCount) throw Error("provider_evidence_changed");
      }
    }
    const nextPage = build.page + 1;
    const locationDone = nextPage >= Math.max(1, page.totalPages);
    if (locationDone) {
      const count = await evidence.countDocuments({ generation: build._id, shopId: location.shopId,
        ...(build.pass === 1 ? { verified: true } : {}) }, { maxTimeMS: 2000 });
      if (count !== page.totalElements) throw Error("invoice_count_mismatch");
    }
    let shopIndex = locationDone ? build.shopIndex + 1 : build.shopIndex;
    let pass = build.pass;
    let next = locationDone ? 0 : nextPage;
    if (shopIndex === locations.length && pass === 0) { pass = 1; shopIndex = 0; next = 0; }
    const done = shopIndex === locations.length && pass === 1;
    const advanced = await builds.updateOne({ _id: build._id, state: "building", pass: build.pass,
      shopIndex: build.shopIndex, page: build.page }, { $set: { pass, shopIndex, page: next, totals: build.totals } });
    if (!advanced.matchedCount) throw Error("checkpoint_conflict");
    if (!done) return release("refreshing", 10_000);
    return publish();
  } catch (error: any) {
    const failureHttpStatus = error?.message === "provider_http_error" &&
      Number.isInteger(error.status) && error.status >= 400 && error.status <= 599
      ? error.status : null;
    const code = error?.status === 429 ? "provider_throttled" :
      /^(scope_|lease_|window_|request_limit|provider_|incomplete_|duplicate_|invoice_|checkpoint_)/.test(error?.message || "")
        ? error.message : "refresh_unavailable";
    const restart = ["scope_changed", "provider_population_changed", "provider_evidence_changed",
      "duplicate_pagination_identity", "invoice_count_mismatch", "request_limit", "incomplete_invoice_payload"].includes(code);
    if (restart && build) await builds.updateOne({ _id: build._id, state: "building" },
      { $set: { state: "failed", failure: code } });
    return release("deferred", 60 * 60_000, { failure: code, failureHttpStatus, ...(restart ? { build: null } : {}) });
  }
}
