/**
 * Synthetic prod smoke — step functions for task #512.
 *
 * Each step calls a real production HTTP endpoint (or library entry-point)
 * against a sentinel shop + sentinel VIN and returns a uniform
 * `{ ok, latencyMs, error?, status?, extra? }` envelope. Steps reuse the
 * production code paths — they do NOT carry their own client copies of
 * Tekmetric / Stripe / etc. The runner (`lib/synthetic/runner.ts`)
 * orchestrates the steps, persists results, and triggers alerts.
 *
 * Sentinel configuration (env vars):
 *   - `SYNTHETIC_BASE_URL`      — base URL for HTTP fetches
 *                                (default: `http://127.0.0.1:${PORT||5000}`).
 *   - `SYNTHETIC_SHOP_ID`       — MOS shopId of the sentinel shop.
 *   - `SYNTHETIC_SMS_SHOP_ID`   — sentinel shop's SMS-provider shopId
 *                                (e.g. Tekmetric numeric id) used by every
 *                                extension route that takes `smsShopId`.
 *   - `SYNTHETIC_PROVIDER`      — `tekmetric` | `protractor` | `shopware`
 *                                (default: `tekmetric`).
 *   - `SYNTHETIC_VIN`           — 17-char sentinel VIN.
 *   - `SYNTHETIC_EXT_TOKEN`     — extension token (`ext_...`) for the
 *                                sentinel test user. Treat as a secret.
 *   - `SYNTHETIC_PARTNER_API_KEY` — partner API key for `/api/external/*`.
 *
 * Out-of-scope writes: steps 4/5 deliberately exercise read paths and
 * synthetic-tagged short-circuits — they NEVER push fake jobs / concerns
 * into a customer SMS. The `_synthetic=1` early-return in
 * `app/api/extension/inspections/route.ts` is the contract that keeps
 * the "save concern" smoke from polluting Tekmetric data.
 */

import { renderStickerStandard } from "@/lib/canvas-renderer";

export type StepName =
  | "extension_auth"
  | "plan_build_vhi"
  | "tekmetric_labor_rates"
  | "tekmetric_open_ros"
  | "apply_canned_job"
  | "save_concern"
  | "sticker_print";

export interface StepResult {
  name: StepName;
  ok: boolean;
  latencyMs: number;
  status?: number | null;
  error?: string | null;
  extra?: Record<string, unknown>;
}

export interface SyntheticEnv {
  baseUrl: string;
  shopId: number | null;
  smsShopId: string | null;
  provider: "tekmetric" | "protractor" | "shopware";
  vin: string | null;
  extToken: string | null;
  partnerApiKey: string | null;
}

export function loadSyntheticEnv(): SyntheticEnv {
  const port = process.env.PORT || "5000";
  return {
    baseUrl:
      process.env.SYNTHETIC_BASE_URL ||
      `http://127.0.0.1:${port}`,
    shopId: process.env.SYNTHETIC_SHOP_ID
      ? Number(process.env.SYNTHETIC_SHOP_ID)
      : null,
    smsShopId: process.env.SYNTHETIC_SMS_SHOP_ID || null,
    provider:
      (process.env.SYNTHETIC_PROVIDER as SyntheticEnv["provider"]) ||
      "tekmetric",
    vin: process.env.SYNTHETIC_VIN || null,
    extToken: process.env.SYNTHETIC_EXT_TOKEN || null,
    partnerApiKey: process.env.SYNTHETIC_PARTNER_API_KEY || null,
  };
}

async function timed<T>(
  name: StepName,
  fn: () => Promise<{ ok: boolean; status?: number | null; error?: string | null; extra?: Record<string, unknown> }>,
): Promise<StepResult> {
  const t0 = Date.now();
  try {
    const out = await fn();
    return {
      name,
      ok: out.ok,
      latencyMs: Date.now() - t0,
      status: out.status ?? null,
      error: out.error ?? null,
      extra: out.extra,
    };
  } catch (err: any) {
    return {
      name,
      ok: false,
      latencyMs: Date.now() - t0,
      status: null,
      error: err?.message ? String(err.message).slice(0, 500) : "unknown",
    };
  }
}

function requireEnv<K extends keyof SyntheticEnv>(
  env: SyntheticEnv,
  keys: K[],
): string | null {
  for (const k of keys) {
    if (env[k] == null || env[k] === "") {
      return `missing env: ${String(k)}`;
    }
  }
  return null;
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs = 20_000,
): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** Step 1 — extension auth: hit a protected `/api/extension/*` endpoint. */
export async function stepExtensionAuth(env: SyntheticEnv): Promise<StepResult> {
  return timed("extension_auth", async () => {
    const miss = requireEnv(env, ["extToken", "smsShopId"]);
    if (miss) return { ok: false, error: miss };
    const url = `${env.baseUrl}/api/extension/labor-rates?smsShopId=${encodeURIComponent(
      env.smsShopId!,
    )}&provider=${env.provider}`;
    const res = await fetchWithTimeout(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${env.extToken}` },
    });
    if (res.status === 401 || res.status === 403) {
      return {
        ok: false,
        status: res.status,
        error: `auth rejected: ${await safeText(res)}`,
      };
    }
    if (res.status >= 500) {
      return { ok: false, status: res.status, error: await safeText(res) };
    }
    // 200 / 404 (shop has no rates configured) both prove auth+lookup worked.
    return { ok: true, status: res.status };
  });
}

/** Step 2 — plan build: request a VHI for the sentinel VIN. */
export async function stepPlanBuildVhi(env: SyntheticEnv): Promise<StepResult> {
  return timed("plan_build_vhi", async () => {
    const miss = requireEnv(env, ["vin", "partnerApiKey"]);
    if (miss) return { ok: false, error: miss };
    const url = `${env.baseUrl}/api/external/vehicles/${encodeURIComponent(
      env.vin!,
    )}/vhi`;
    const res = await fetchWithTimeout(
      url,
      {
        method: "GET",
        headers: { Authorization: `Bearer ${env.partnerApiKey}` },
      },
      30_000,
    );
    if (res.status >= 500) {
      return { ok: false, status: res.status, error: await safeText(res) };
    }
    if (!res.ok) {
      return {
        ok: false,
        status: res.status,
        error: `non-2xx: ${await safeText(res)}`,
      };
    }
    const body: any = await res.json().catch(() => null);
    const hasScore = body && (typeof body.score === "number" || typeof body?.vhi?.score === "number");
    if (!hasScore) {
      return {
        ok: false,
        status: res.status,
        error: "vhi response missing score",
      };
    }
    return { ok: true, status: res.status, extra: { hasScore: true } };
  });
}

/** Step 3 — Tekmetric: pull labor rates + a small open-RO list for the shop. */
export async function stepTekmetricLaborRates(env: SyntheticEnv): Promise<StepResult> {
  return timed("tekmetric_labor_rates", async () => {
    const miss = requireEnv(env, ["extToken", "smsShopId"]);
    if (miss) return { ok: false, error: miss };
    // The labor-rates extension route is the cheapest path that proves
    // Tekmetric auth + our /labor-rates fetch is healthy end-to-end.
    const url = `${env.baseUrl}/api/extension/labor-rates?smsShopId=${encodeURIComponent(
      env.smsShopId!,
    )}&provider=${env.provider}`;
    const res = await fetchWithTimeout(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${env.extToken}` },
    });
    if (res.status >= 500) {
      return { ok: false, status: res.status, error: await safeText(res) };
    }
    if (!res.ok) {
      return {
        ok: false,
        status: res.status,
        error: `non-2xx: ${await safeText(res)}`,
      };
    }
    const body: any = await res.json().catch(() => null);
    if (!body || body.ok === false) {
      return {
        ok: false,
        status: res.status,
        error: `bad payload: ${JSON.stringify(body).slice(0, 200)}`,
      };
    }
    return { ok: true, status: res.status };
  });
}

/** Step 3b — Tekmetric open ROs: prove the Tekmetric upstream call for
 * the active repair-order list works (the second leg of the task's
 * "labor rates AND open ROs" requirement). Calls the Tekmetric client
 * lib directly — same code path the sync workers, the side panel
 * `/api/extension/plan`, and the migration wizard use. No HTTP hop so
 * the synthetic does not double-count its own request through the
 * shared rate limiter. */
export async function stepTekmetricOpenRos(env: SyntheticEnv): Promise<StepResult> {
  return timed("tekmetric_open_ros", async () => {
    if (env.provider !== "tekmetric") {
      return { ok: true, extra: { skipped: "non-tekmetric provider" } };
    }
    const miss = requireEnv(env, ["smsShopId"]);
    if (miss) return { ok: false, error: miss };
    const tekShopId = Number(env.smsShopId);
    if (!Number.isFinite(tekShopId)) {
      return { ok: false, error: `bad tekmetric shopId: ${env.smsShopId}` };
    }
    const { getRepairOrders } = await import("@/lib/integrations/tekmetric/client");
    const resp: any = await getRepairOrders(tekShopId, { page: 0, size: 5 });
    // Tekmetric paginated payload shape: { content: [...], totalElements }
    const content = Array.isArray(resp?.content)
      ? resp.content
      : Array.isArray(resp)
        ? resp
        : null;
    if (!content) {
      return {
        ok: false,
        error: `bad repair-orders payload: ${JSON.stringify(resp).slice(0, 200)}`,
      };
    }
    // An empty page is fine (sentinel shop may be quiet). What matters is
    // the upstream call returned a well-formed payload.
    return { ok: true, extra: { count: content.length } };
  });
}

/** Step 4 — apply canned job: POST to `/api/extension/jobs/apply-canned`
 * with the `_synthetic=1` short-circuit so we exercise auth +
 * authorization + payload validation for the exact path Kurt reported
 * broken when "Add canned job" silently dropped. The short-circuit
 * returns before any Protractor/Tekmetric lookup or write — no fake
 * job ever lands on a customer RO. */
export async function stepApplyCannedJob(env: SyntheticEnv): Promise<StepResult> {
  return timed("apply_canned_job", async () => {
    const miss = requireEnv(env, ["extToken", "shopId"]);
    if (miss) return { ok: false, error: miss };
    const url = `${env.baseUrl}/api/extension/jobs/apply-canned?_synthetic=1`;
    const payload = {
      shopId: env.shopId,
      cannedJobId: "synthetic-canned",
      cannedJobTitle: "Synthetic smoke probe",
      vin: env.vin || undefined,
      _synthetic: true,
    };
    const res = await fetchWithTimeout(
      url,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.extToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      },
      25_000,
    );
    if (res.status >= 500) {
      return { ok: false, status: res.status, error: await safeText(res) };
    }
    if (!res.ok) {
      return {
        ok: false,
        status: res.status,
        error: `non-2xx: ${await safeText(res)}`,
      };
    }
    const body: any = await res.json().catch(() => null);
    // Synthetic contract: the route must return `synthetic:true` AND
    // `lookup_ok:true` AND at least one upstream leg reporting
    // `ran_found` or `ran_empty`. Any leg with outcome `errored` or
    // all legs `skipped_*` is treated as a failure — otherwise the
    // smoke would stay green while the canned-job path Kurt reported
    // is silently broken.
    if (!body?.synthetic || body?.lookup_ok !== true) {
      return {
        ok: false,
        status: res.status,
        error: `apply-canned synthetic contract violated: ${JSON.stringify(body).slice(0, 300)}`,
      };
    }
    const outcomes = body.lookupOutcomes || {};
    const ranLegs = Object.values(outcomes).filter(
      (v) => v === "ran_found" || v === "ran_empty",
    ).length;
    if (ranLegs === 0) {
      return {
        ok: false,
        status: res.status,
        error: `apply-canned: no upstream leg ran (outcomes=${JSON.stringify(outcomes)})`,
      };
    }
    return {
      ok: true,
      status: res.status,
      extra: { lookupOutcomes: outcomes, wo: body.targetWorkOrderId || null },
    };
  });
}

/** Step 5 — save concern: POST to `/api/extension/inspections` with the
 * `_synthetic=1` short-circuit so we exercise auth + shop-resolution +
 * validation without writing into the customer RO. */
export async function stepSaveConcern(env: SyntheticEnv): Promise<StepResult> {
  return timed("save_concern", async () => {
    const miss = requireEnv(env, ["extToken", "smsShopId"]);
    if (miss) return { ok: false, error: miss };
    const url = `${env.baseUrl}/api/extension/inspections?_synthetic=1`;
    // Sentinel roId — `synthetic-smoke-<smsShopId>` will never collide
    // with a real Tekmetric workOrderId. The route upserts into
    // `tekmetric_work_orders` keyed by (shopId, workOrderId), so the
    // write lands on a dedicated synthetic doc. We deliberately let
    // the full Mongo write run so this step catches write regressions.
    const sentinelRoId = `synthetic-smoke-${env.smsShopId}`;
    const payload = {
      provider: env.provider,
      smsShopId: env.smsShopId,
      roId: sentinelRoId,
      vin: env.vin || undefined,
      inspections: [
        {
          inspectionTasks: [
            {
              tasks: [
                {
                  name: "Synthetic smoke probe",
                  inspectionRating: { code: "CHCKD" },
                },
              ],
            },
          ],
        },
      ],
      _synthetic: true,
    };
    const res = await fetchWithTimeout(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.extToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });
    if (res.status >= 500) {
      return { ok: false, status: res.status, error: await safeText(res) };
    }
    if (!res.ok) {
      return {
        ok: false,
        status: res.status,
        error: `non-2xx: ${await safeText(res)}`,
      };
    }
    const body: any = await res.json().catch(() => null);
    // The route writes (or upserts) into `tekmetric_work_orders` keyed by
    // our sentinel roId, then returns `{ok, cached, matched, modified}`.
    // A healthy run produces either matched>=1 (re-write of the same
    // sentinel doc) or stored>=1 with cached:true on the upsert path.
    if (!body?.ok || body?.cached !== true) {
      return {
        ok: false,
        status: res.status,
        error: `unexpected response: ${JSON.stringify(body).slice(0, 200)}`,
      };
    }
    return {
      ok: true,
      status: res.status,
      extra: { matched: body.matched, modified: body.modified },
    };
  });
}

/** Step 6 — sticker print: render a sticker server-side and confirm the
 * PNG buffer is non-empty. Calls the renderer lib directly — no HTTP hop —
 * because the lib IS the production code path the route uses. */
export async function stepStickerPrint(_env: SyntheticEnv): Promise<StepResult> {
  return timed("sticker_print", async () => {
    const buf = await renderStickerStandard(
      {
        colors: {},
        fontStyles: {},
      } as any,
      {
        nextServiceMileage: 50_000,
        nextServiceDate: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString(),
      } as any,
      { width: 591, height: 591 },
      1,
    );
    if (!buf || buf.length < 1024) {
      return {
        ok: false,
        error: `sticker buffer too small (${buf?.length ?? 0} bytes)`,
      };
    }
    const png = buf.slice(0, 8).toString("hex");
    if (!png.startsWith("89504e47")) {
      return { ok: false, error: `bad PNG signature: ${png}` };
    }
    return { ok: true, extra: { bytes: buf.length } };
  });
}

async function safeText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 500);
  } catch {
    return "";
  }
}

export const ALL_STEPS: Array<(env: SyntheticEnv) => Promise<StepResult>> = [
  stepExtensionAuth,
  stepPlanBuildVhi,
  stepTekmetricLaborRates,
  stepTekmetricOpenRos,
  stepApplyCannedJob,
  stepSaveConcern,
  stepStickerPrint,
];
