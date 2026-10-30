import { resolveReportingScope, ReportingScopeError } from "./reporting-scope";
import { listShopsByShopIds } from "./data/repositories/shops";
import { findReportingRecipient } from "./data/repositories/reporting-subscriptions";
import { createTireRun, findTireRun, claimTireRun, saveTireRun, failTireRun, type TireDotRun } from "./data/repositories/tire-dot-report-runs";
import { readTireSourcePage, tireSourceMode } from "./data/repositories/tire-dot-source";
import { emptyTireResult, extractTireInvoice, tireCoverageGap, validateTireDefinition } from "./tire-dot-report";
import { TIRE_DOT_LIMITS, type TireDotScope } from "./tire-dot-report-contract";
import { findTirePilot, validateTirePilot, readTirePilotPage } from "./data/repositories/tire-dot-pilot";

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
  const shops = await tireDotDeps.listShopsByShopIds(scope.shopIds);
  const ids = new Set(shops.filter((s: any) => {
    const provider = s.integrationProvider || s.smsProvider || s.smsType;
    return (!provider || String(provider).toLowerCase() === "tekmetric") && Boolean(s.tekmetric?.shopId || s.tekmetricShopId || s.tekmetric?.configured);
  }).map((s: any) => Number(s.shopId)));
  return { scope, locations: scope.shops.filter(s => ids.has(s.shopId)).map(s => ({ shopId: s.shopId, name: s.name })) };
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
  const allowed = await authorize(session, input);
  let pilot;
  try { pilot = await tireDotDeps.findTirePilot(allowed.definition); }
  catch (e) { throw new TireDotError(e instanceof Error ? e.message : "Pilot evidence unavailable", 503); }
  if (!pilot && !tireDotEnabled()) throw new TireDotError("Tire DOT reporting awaits approved production setup and verification.", 503);
  const partial = emptyTireResult(allowed.definition, allowed.locations);
  if (pilot) {
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
  const run = await tireDotDeps.claimTireRun(pilotOnly || !tireDotEnabled());
  if (!run) return { claimed: 0, status: "idle" };
  try {
    const user = await tireDotDeps.findReportingRecipient(run.requestedBy);
    if (!user || user.active === false || user.status === "inactive") throw new TireDotError("Requester access is no longer active", 403);
    await authorize({ ...user, email: run.requestedBy }, { ...run.definition, scope: run.scope });
    const shop = run.definition.locationIds[run.shopIndex];
    if (run.pilot) await tireDotDeps.validateTirePilot(run.pilot, run.definition.locationIds);
    if (run.sourceMode === "pilot" && !run.pilot) throw new TireDotError("Pilot generation missing", 503);
    const page = run.sourceMode === "pilot"
      ? await tireDotDeps.readTirePilotPage(run.pilot!, shop, run.cursor)
      : await tireDotDeps.readTireSourcePage(shop, run.cursor, run.sourceMode);
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
    await tireDotDeps.saveTireRun(run, done);
    return { claimed: 1, status: done ? "succeeded" : "preparing" };
  } catch (error) {
    const message = error instanceof TireDotError || error instanceof ReportingScopeError ? error.message
      : "Stored-evidence extraction unavailable. Verify the approved source index and store configuration, then run again.";
    await tireDotDeps.failTireRun(run, message);
    return { claimed: 1, status: "failed" };
  }
}

export async function processTireRunBatch() {
  const started = Date.now();
  const outcomes = [];
  for (let page = 0; page < 10 && Date.now() - started < 15_000; page++) {
    const outcome = await processNextTireRun();
    outcomes.push(outcome);
    if (!outcome.claimed) break;
  }
  return outcomes;
}
