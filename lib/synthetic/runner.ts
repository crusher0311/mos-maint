/**
 * Synthetic prod smoke — orchestrator for task #512.
 *
 * Runs every step in `lib/synthetic/steps.ts`, persists the per-run summary
 * to Mongo, emits the unified `[ShopErrorRate]` marker on failure (group
 * `SYNTHETIC_FAIL` so Better Stack can page off the same query family as
 * the per-shop alerts in task #510), and triggers an email page to platform
 * admins only when the SAME step fails TWICE IN A ROW. Single transient
 * failures are recorded silently — only a consecutive failure represents a
 * real regression worth waking on-call for. Auto-clears (and emails a
 * recovery notice) when the step returns ok after a paged state.
 *
 * Task #525 generalized the runner to run every step once per configured
 * VENDOR (Tekmetric / Protractor / Shop-Ware), tagging each result + alert
 * with `provider` so one vendor's regression pages independently.
 *
 * Task #527 added a `runner` discriminator: the default `"api"` runner is
 * the multi-vendor HTTP smoke above, while the `"browser"` runner is the
 * Chrome-extension overlay synthetic. The two never share consecutive-
 * failure dedup state (state keys are namespaced by runner).
 *
 * Collections:
 *   - `synthetic_runs` — one doc per run, TTL 14 days. Powers the admin
 *     status tile.
 *   - `synthetic_state` — one doc keyed `{ _id: stepKey }` tracking
 *     consecutive failure count + last-alerted timestamp for state-based
 *     alert dedup. Mirrors the cron-health alerter pattern.
 */

import type { Db } from "mongodb";
import { getDb } from "@/lib/mongo";
import { emitShopErrorEvent } from "@/lib/alerts/shop-error-marker";
import { sendEmail } from "@/lib/email";
import { getPlatformAdminEmails } from "@/lib/super-admins";
import {
  ALL_STEPS,
  loadSyntheticEnvs,
  type StepName,
  type StepResult,
  type SyntheticEnv,
  type Vendor,
} from "./steps";

const RUNS_COLLECTION = "synthetic_runs";
const STATE_COLLECTION = "synthetic_state";
const RUNS_TTL_SECONDS = 14 * 24 * 60 * 60;
const PAGE_AFTER_CONSECUTIVE_FAILURES = 2;

let indexEnsured = false;
async function ensureIndexes(db: Db) {
  if (indexEnsured) return;
  try {
    await db
      .collection(RUNS_COLLECTION)
      .createIndex({ ts: 1 }, { expireAfterSeconds: RUNS_TTL_SECONDS });
    await db.collection(RUNS_COLLECTION).createIndex({ ts: -1 });
    indexEnsured = true;
  } catch (err: any) {
    console.warn(
      `[SyntheticSmoke] failed to ensure indexes: ${err?.message || err}`,
    );
  }
}

export interface VendorRun {
  provider: Vendor;
  shopId: number | null;
  vin: string | null;
  ok: boolean;
  steps: StepResult[];
}

export interface RunSummary {
  ok: boolean;
  ts: Date;
  durationMs: number;
  baseUrl: string;
  vendors: VendorRun[];
  alerts: Array<{ step: StepName; provider: Vendor; kind: "page" | "recover" }>;
  // Distinguishes the API-level synthetic (task #512/#525, `"api"`) from the
  // browser-driven overlay synthetic (task #527, `"browser"`).
  runner: string;
  // Legacy single-sentinel compatibility fields (first vendor's values + a
  // flattened step list across every vendor).
  shopId: number | null;
  vin: string | null;
  steps: StepResult[];
}

export interface RunnerDeps {
  // Single-env seam (back-compat). When set, treated as a one-vendor run.
  env?: SyntheticEnv;
  // Multi-vendor seam (task #525). Takes precedence over `env`.
  envs?: SyntheticEnv[];
  steps?: Array<(env: SyntheticEnv) => Promise<StepResult>>;
  // Distinguishes the API-level synthetic (task #512/#525, default `"api"`)
  // from the browser-driven overlay synthetic (task #527, `"browser"`).
  // Persisted on every `synthetic_runs` doc and used to namespace
  // `synthetic_state` keys so the two runners never share consecutive-failure
  // dedup state.
  runner?: string;
  // Test seam — when provided, skips Mongo + email.
  inMemory?: boolean;
  emit?: typeof emitShopErrorEvent;
  send?: typeof sendEmail;
  getAdmins?: typeof getPlatformAdminEmails;
  // Test seam — when provided, the runner uses this Mongo-shaped DB
  // instead of calling the real `getDb()`. Lets the smoke test exercise
  // the consecutive-failure paging path without touching Atlas.
  getDb?: () => Promise<Db>;
}

// State-key namespacing. Task #525 keys per (step × vendor):
// `step:<name>:<vendor>`. Task #527 layers the runner in front for non-api
// runners so the browser synthetic gets its own state docs without resetting
// the existing api-runner dedup on deploy:
//   - api:     `step:<name>:<vendor>`            (unchanged from task #525)
//   - browser: `step:browser:<name>:<vendor>`
function stateKey(runner: string, name: string, provider: Vendor): string {
  return runner === "api"
    ? `step:${name}:${provider}`
    : `step:${runner}:${name}:${provider}`;
}

export async function runSyntheticSmoke(
  deps: RunnerDeps = {},
): Promise<RunSummary> {
  const envs = deps.envs ?? (deps.env ? [deps.env] : loadSyntheticEnvs());
  const steps = deps.steps ?? ALL_STEPS;
  const runner = deps.runner ?? "api";
  const emit = deps.emit ?? emitShopErrorEvent;
  const send = deps.send ?? sendEmail;
  const getAdmins = deps.getAdmins ?? getPlatformAdminEmails;

  const t0 = Date.now();
  // Run every step once per configured vendor. Each result is tagged with
  // the vendor so per-(step × vendor) state can be tracked downstream.
  const vendorRuns: VendorRun[] = [];
  for (const env of envs) {
    const results: StepResult[] = [];
    for (const fn of steps) {
      const res = await fn(env);
      res.provider = env.provider;
      results.push(res);
    }
    vendorRuns.push({
      provider: env.provider,
      shopId: env.shopId,
      vin: env.vin,
      ok: results.every((r) => r.ok),
      steps: results,
    });
  }
  const durationMs = Date.now() - t0;
  const ok = vendorRuns.every((v) => v.ok);
  const summary: RunSummary = {
    ok,
    ts: new Date(),
    durationMs,
    baseUrl: envs[0]?.baseUrl ?? "",
    vendors: vendorRuns,
    alerts: [],
    runner,
    // Legacy single-sentinel compatibility fields.
    shopId: vendorRuns[0]?.shopId ?? null,
    vin: vendorRuns[0]?.vin ?? null,
    steps: vendorRuns.flatMap((v) => v.steps),
  };

  // Emit per-(vendor × step) failure markers immediately (the Better Stack
  // rule counts these — alerting/email is the SECONDARY signal for humans).
  for (const v of vendorRuns) {
    for (const r of v.steps) {
      if (!r.ok) {
        emit({
          group: "SYNTHETIC_FAIL",
          shopId: v.shopId,
          status: r.status ?? null,
          code: r.name,
          message: r.error || null,
          extra: {
            latencyMs: r.latencyMs,
            vin: v.vin || null,
            provider: v.provider,
            runner,
          },
        });
      }
    }
  }

  if (deps.inMemory) {
    return summary;
  }

  const db = deps.getDb ? await deps.getDb() : await getDb();
  await ensureIndexes(db);

  const serializeStep = (r: StepResult) => ({
    name: r.name,
    ok: r.ok,
    latencyMs: r.latencyMs,
    status: r.status ?? null,
    error: r.error ?? null,
    extra: r.extra ?? null,
  });

  // Persist the run record.
  try {
    await db.collection(RUNS_COLLECTION).insertOne({
      ts: summary.ts,
      ok: summary.ok,
      durationMs: summary.durationMs,
      baseUrl: summary.baseUrl,
      runner: summary.runner,
      // Per-vendor grouping (task #525) — powers the by-vendor status surface.
      vendors: summary.vendors.map((v) => ({
        provider: v.provider,
        shopId: v.shopId,
        vin: v.vin,
        ok: v.ok,
        steps: v.steps.map(serializeStep),
      })),
      // Legacy flattened fields kept so older readers/aggregations keep working.
      shopId: summary.shopId,
      vin: summary.vin,
      steps: summary.steps.map(serializeStep),
      synthetic: true, // billing/analytics tag — every synthetic write carries this
    });
  } catch (err: any) {
    console.warn(
      `[SyntheticSmoke] failed to persist run: ${err?.message || err}`,
    );
  }

  // State-based consecutive-failure tracking + paging, keyed per
  // (runner × step × vendor) so a Protractor regression pages independently
  // of a healthy Tekmetric run of the same step, and the browser runner
  // never collides with the api runner's dedup.
  const admins = ok ? [] : await getAdmins().catch(() => [] as string[]);
  for (const v of vendorRuns) {
    for (const r of v.steps) {
      const stateId = stateKey(runner, r.name, v.provider);
      const prior = (await db
        .collection(STATE_COLLECTION)
        .findOne({ _id: stateId as any })) as any;
      const priorConsecutive: number = prior?.consecutiveFailures || 0;
      const priorAlerted: boolean = !!prior?.alertedAt;

      if (!r.ok) {
        const consecutive = priorConsecutive + 1;
        const shouldPage =
          consecutive >= PAGE_AFTER_CONSECUTIVE_FAILURES && !priorAlerted;
        await db.collection(STATE_COLLECTION).updateOne(
          { _id: stateId as any },
          {
            $set: {
              stepName: r.name,
              provider: v.provider,
              runner,
              consecutiveFailures: consecutive,
              lastFailureAt: summary.ts,
              lastError: r.error || null,
              lastStatus: r.status ?? null,
              ...(shouldPage ? { alertedAt: summary.ts } : {}),
            },
          },
          { upsert: true },
        );
        if (shouldPage) {
          summary.alerts.push({
            step: r.name,
            provider: v.provider,
            kind: "page",
          });
          await sendPage(send, admins, r, {
            baseUrl: summary.baseUrl,
            shopId: v.shopId,
            vin: v.vin,
            provider: v.provider,
            runner,
          });
        }
      } else if (priorConsecutive > 0 || priorAlerted) {
        await db.collection(STATE_COLLECTION).updateOne(
          { _id: stateId as any },
          {
            $set: {
              stepName: r.name,
              provider: v.provider,
              runner,
              consecutiveFailures: 0,
              lastRecoveredAt: summary.ts,
            },
            $unset: { alertedAt: "", lastError: "", lastStatus: "" },
          },
          { upsert: true },
        );
        if (priorAlerted) {
          summary.alerts.push({
            step: r.name,
            provider: v.provider,
            kind: "recover",
          });
          const recipients = admins.length
            ? admins
            : await getAdmins().catch(() => [] as string[]);
          await sendRecover(send, recipients, r, v.provider);
        }
      }
    }
  }

  return summary;
}

interface PageContext {
  baseUrl: string;
  shopId: number | null;
  vin: string | null;
  provider: Vendor;
  runner: string;
}

async function sendPage(
  send: typeof sendEmail,
  to: string[],
  r: StepResult,
  ctx: PageContext,
) {
  if (!to.length) return;
  // The browser synthetic (task #527) is a distinct cron route from the
  // API one (task #512/#525); point the re-run command at the right endpoint.
  const cronPath =
    ctx.runner === "browser"
      ? "/api/cron/synthetic-overlay-smoke"
      : "/api/cron/synthetic-prod-smoke";
  const rerun = `curl -H "Authorization: Bearer $CRON_SECRET" ${ctx.baseUrl}${cronPath}`;
  const label =
    ctx.runner === "api" ? "Synthetic prod smoke" : `Synthetic ${ctx.runner} smoke`;
  const subject = `[Synthetic PAGE] ${r.name} (${ctx.provider}) failed twice in a row`;
  const html = `
    <h2>${label}: ${r.name} (${ctx.provider}) failed twice in a row</h2>
    <p><strong>Runner:</strong> ${ctx.runner}</p>
    <p><strong>Vendor:</strong> ${ctx.provider}</p>
    <p><strong>Status:</strong> ${r.status ?? "n/a"}</p>
    <p><strong>Latency:</strong> ${r.latencyMs} ms</p>
    <p><strong>Error:</strong></p>
    <pre>${escapeHtml(r.error || "")}</pre>
    <p><strong>Sentinel:</strong> shop=${ctx.shopId ?? "?"} vin=${ctx.vin ?? "?"}</p>
    <p><strong>Re-run command:</strong></p>
    <pre>${rerun}</pre>
    <p>Runbook: <code>docs/runbooks/synthetic-prod-smoke.md</code></p>
  `;
  try {
    await send({
      to: to.join(","),
      subject,
      html,
    });
  } catch (err: any) {
    console.warn(
      `[SyntheticSmoke] failed to send page: ${err?.message || err}`,
    );
  }
}

async function sendRecover(
  send: typeof sendEmail,
  to: string[],
  r: StepResult,
  provider: Vendor,
) {
  if (!to.length) return;
  try {
    await send({
      to: to.join(","),
      subject: `[Synthetic OK] ${r.name} (${provider}) recovered`,
      html: `<p>Synthetic step <strong>${r.name}</strong> (${provider}) returned ok after a previous page.</p>`,
    });
  } catch {
    /* never fail a run on a recovery email */
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
