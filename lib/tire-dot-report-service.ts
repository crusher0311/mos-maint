import { resolveReportingScope, ReportingScopeError } from "./reporting-scope";
import { listShopsByShopIds } from "./data/repositories/shops";
import { findReportingRecipient } from "./data/repositories/reporting-subscriptions";
import { createTireRun, findTireRun, claimTireRun, saveTireRun, failTireRun, type TireDotRun } from "./data/repositories/tire-dot-report-runs";
import { readTireSourcePage, tireSourceMode } from "./data/repositories/tire-dot-source";
import { emptyTireResult, extractTireInvoice, tireCoverageGap, validateTireDefinition } from "./tire-dot-report";
import { TIRE_DOT_LIMITS, type TireDotScope } from "./tire-dot-report-contract";
import { findTirePilot, validateTirePilot, readTirePilotPage } from "./data/repositories/tire-dot-pilot";
import { validTireTimeZone } from "./tire-dot-dates";

export const tireDotDeps = { resolveReportingScope, listShopsByShopIds, findReportingRecipient, createTireRun, findTireRun, claimTireRun, saveTireRun, failTireRun, readTireSourcePage, tireSourceMode, findTirePilot, validateTirePilot, readTirePilotPage };
export class TireDotError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}
export const tireDotEnabled = () => process.env.REPORTING_TIRE_DOT_ENABLED === "true";
export async function tireLocations(session: any, request: any) {
  if (!["shop", "enterprise"].includes(request?.kind)) throw new TireDotError("Choose a shop or enterprise scope");
  const scope = await tireDotDeps.resolveReportingScope(session, {
    kind: request.kind, shopId: request.shopId == null ? null : String(request.shopId), enterpriseId: request.enterpriseId || null,
  });
  const shops = await tireDotDeps.listShopsByShopIds(scope.shopIds, { shopId: 1, integrationProvider: 1, smsProvider: 1, smsType: 1, "tekmetric.shopId": 1, "tekmetric.configured": 1, tekmetricShopId: 1, timezone: 1, timeZone: 1 });
  const ids = new Set(shops.filter((s: any) => {
    const provider = s.integrationProvider || s.smsProvider || s.smsType;
    return (!provider || String(provider).toLowerCase() === "tekmetric") && Boolean(s.tekmetric?.shopId || s.tekmetricShopId || s.tekmetric?.configured);
  }).map((s: any) => Number(s.shopId)));
  return { scope, locations: scope.shops.filter(s => ids.has(s.shopId)).map(s => {
    const shop: any = shops.find(x => Number(x.shopId) === s.shopId);
    const zone = shop?.timezone || shop?.timeZone;
    return { shopId: s.shopId, name: s.name, ...(validTireTimeZone(zone) ? { timeZone: zone } : {}) };
  }) };
}
async function authorize(session: any, input: any) {
  let definition;
  try { definition = validateTireDefinition(input); }
  catch (e) { throw new TireDotError(e instanceof Error ? e.message : "Invalid tire report definition"); }
  const { scope, locations } = await tireLocations(session, input.scope);
  if (definition.locationIds.some(id => !locations.some(l => l.shopId === id))) throw new TireDotError("Selected location is no longer an authorized Tekmetric location", 403);
  const request: TireDotScope = scope.kind === "shop" ? { kind: "shop", shopId: scope.shopIds[0] } : { kind: "enterprise", enterpriseId: scope.enterpriseId };
  return { definition, scope: request, locations: locations.filter(l => definition.locationIds.includes(l.shopId)) };
}
export async function requestTireRun(session: any, input: any) {
  // Only the server may choose the zone map for a new request.
  const allowed = await authorize(session, { ...input, timeZones: undefined });
  if (input.dateBasis === "shop-local") {
    if (allowed.locations.some(l => !validTireTimeZone(l.timeZone))) throw new TireDotError("Configure a valid timezone for every selected location first");
    allowed.definition.timeZones = Object.fromEntries(allowed.locations.map(l => [l.shopId, l.timeZone!]));
  } else if (input.dateBasis != null && input.dateBasis !== "UTC") throw new TireDotError("Unsupported reporting date basis");
  let pilot;
  try { pilot = await tireDotDeps.findTirePilot(allowed.definition); }
  catch (e) { throw new TireDotError(e instanceof Error ? e.message : "Pilot evidence unavailable", 503); }
  if (!pilot && !tireDotEnabled()) throw new TireDotError("Tire DOT reporting awaits approved production setup and verification.", 503);
  const partial = emptyTireResult(allowed.definition, allowed.locations);
  if (pilot) {
    if (allowed.definition.timeZones) tireCoverageGap(partial, "Pilot verification covered UTC month boundaries. Local-day boundary coverage is not fully verified; retained out-of-month evidence is included where available.");
    await tireDotDeps.validateTirePilot(pilot, allowed.definition.locationIds);
    tireCoverageGap(partial, `HEART reporting-only refresh ${pilot.startedAt} through ${pilot.finishedAt}. ${pilot.finalMonth ? "Closed-month verification" : "MONTH TO DATE: October is not yet closed"}. No production invoices were changed.`);
    for (const warning of pilot.warnings) tireCoverageGap(partial, warning);
  }
  return tireDotDeps.createTireRun({
    requestedBy: session.email.toLowerCase(), definition: allowed.definition, scope: allowed.scope,
    sourceMode: pilot ? "pilot" : tireDotDeps.tireSourceMode(), ...(pilot ? { pilot } : {}), partial,
  }, input.force === true);
}
export async function readableTireRun(session: any, id: string) {
  const run = await tireDotDeps.findTireRun(id);
  if (!run || run.requestedBy !== session.email.toLowerCase()) throw new TireDotError("Report run not found", 404);
  await authorize(session, { ...run.definition, scope: run.scope });
  if (run.pilot) await tireDotDeps.validateTirePilot(run.pilot, run.definition.locationIds);
  return run;
}
export function tireRunResponse(run: TireDotRun) {
  return { runId: run._id, status: run.status, stage: run.stage, error: run.error, result: run.result,
    stale: Boolean(run.result && Date.now() - Date.parse(run.result.generatedAt) > 15 * 60_000) };
}
/** One bounded, persisted page per cron tick. A lease token fences stale workers.
 * Each new Run is an immutable generation, never a cached mixture of scopes. */
export async function processNextTireRun(pilotOnly = false) {
  const started = Date.now();
  const run = await tireDotDeps.claimTireRun(pilotOnly || !tireDotEnabled());
  if (!run) return { claimed: 0, status: "idle" };
  const claimed = Date.now();
  try {
    const user = await tireDotDeps.findReportingRecipient(run.requestedBy);
    if (!user || user.active === false || user.status === "inactive") throw new TireDotError("Requester access is no longer active", 403);
    await authorize({ ...user, email: run.requestedBy }, { ...run.definition, scope: run.scope });
    const shop = run.definition.locationIds[run.shopIndex];
    if (run.pilot) await tireDotDeps.validateTirePilot(run.pilot, run.definition.locationIds);
    if (run.sourceMode === "pilot" && !run.pilot) throw new TireDotError("Pilot generation missing", 503);
    const authorized = Date.now();
    const page = run.sourceMode === "pilot"
      ? await tireDotDeps.readTirePilotPage(run.pilot!, shop, run.cursor, Boolean(run.definition.timeZones))
      : await tireDotDeps.readTireSourcePage(shop, run.cursor, run.sourceMode);
    const read = Date.now();
    for (const row of page) {
      extractTireInvoice(run.partial, shop, row.doc);
      run.cursor = row.key;
      if (run.partial.limited || run.partial.coverage.scanned >= TIRE_DOT_LIMITS.documents) {
        run.partial.limited = true;
        tireCoverageGap(run.partial, "Extraction safety limit reached; the report is incomplete. Narrow the scope before reconciliation.");
        break;
      }
    }
    if (page.length < TIRE_DOT_LIMITS.page) { run.shopIndex++; run.cursor = null; }
    const done = run.partial.limited || run.shopIndex >= run.definition.locationIds.length;
    const extracted = Date.now();
    await tireDotDeps.saveTireRun(run, done);
    console.info("[tire-report] page_complete", {
      claimMs: claimed - started, authorizationMs: authorized - claimed,
      sourceMs: read - authorized, extractionMs: extracted - read,
      checkpointMs: Date.now() - extracted, records: page.length, done,
      ...(done && run.createdAt ? { elapsedMs: Date.now() - new Date(run.createdAt).getTime() } : {}),
    });
    return { claimed: 1, status: done ? "succeeded" : "preparing" };
  } catch (error) {
    const message = error instanceof TireDotError || error instanceof ReportingScopeError ? error.message
      : "Stored-evidence extraction unavailable. Verify the approved source index and store configuration, then run again.";
    await tireDotDeps.failTireRun(run, message);
    return { claimed: 1, status: "failed" };
  }
}

export async function processTireRunBatch(options: {
  pilotOnly?: boolean;
  shouldStop?: () => boolean;
  now?: () => number;
} = {}) {
  const now = options.now ?? Date.now;
  const started = now();
  const outcomes = [];
  // The deadline is checked between persisted pages, never by abandoning an
  // in-flight write. Keep the same per-page authorization and lease fencing.
  for (let page = 0; page < 10 && now() - started < 15_000 && !options.shouldStop?.(); page++) {
    const outcome = await processNextTireRun(options.pilotOnly ?? false);
    outcomes.push(outcome);
    if (!outcome.claimed || outcome.status === "failed") break;
  }
  return outcomes;
}
