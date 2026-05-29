/**
 * Browser-driven synthetic steps — task #527.
 *
 * Mirrors `lib/synthetic/steps.ts` (the API steps) but for the Chrome
 * extension overlay flow. Each step returns the same `StepResult` envelope
 * so the shared runner (`lib/synthetic/runner.ts`) can persist + page on it
 * identically — the only difference is the runner is invoked with
 * `{ runner: "browser" }` so results land in `synthetic_runs` tagged
 * `runner:"browser"` and dedup state is namespaced.
 *
 * DORMANT BY DEFAULT: `SYNTHETIC_BROWSER_ENABLED` must be `true` for the
 * probe to actually launch Chromium. Until then `stepOverlayPrefillDvi`
 * returns `ok:true` with `extra.skipped` so the 30-min cron is a safe no-op
 * on hosts without an extension-capable Chromium (matches the
 * `tekmetric_open_ros` auto-skip pattern).
 */

import type { StepResult, SyntheticEnv } from "./steps";
import {
  runOverlayProbe,
  defaultProbePaths,
  type OverlayProbeConfig,
  type OverlayProbeDeps,
} from "./overlay-probe";

export interface BrowserSyntheticConfig {
  enabled: boolean;
  apiHost: string;
  tekHost: string;
  roId: string;
  mileage: number;
  timeoutMs: number;
}

export function loadBrowserSyntheticConfig(): BrowserSyntheticConfig {
  return {
    enabled: process.env.SYNTHETIC_BROWSER_ENABLED === "true",
    // The MOS API host the extension is configured to talk to. Defaults to
    // the public host; the probe maps it to the local stand-in server.
    apiHost: process.env.SYNTHETIC_BROWSER_API_HOST || "mos.tools",
    tekHost: process.env.SYNTHETIC_BROWSER_TEK_HOST || "shop.tekmetric.com",
    // Sentinel RO id baked into the recorded fixture's URL. Any numeric id
    // works — nothing real is read or written.
    roId: process.env.SYNTHETIC_BROWSER_RO_ID || "4477",
    mileage: Number(process.env.SYNTHETIC_BROWSER_MILEAGE || "62500"),
    timeoutMs: Number(process.env.SYNTHETIC_BROWSER_TIMEOUT_MS || "120000"),
  };
}

export interface BrowserStepDeps {
  config?: BrowserSyntheticConfig;
  /** Test seam — replaces the real puppeteer probe. */
  runProbe?: (
    cfg: OverlayProbeConfig,
    deps?: OverlayProbeDeps,
  ) => Promise<Awaited<ReturnType<typeof runOverlayProbe>>>;
}

/**
 * Step — overlay Pre-fill DVI: load the extension against the recorded RO
 * page, click "Pre-fill DVI", assert the request fired + the UI updated.
 */
export async function stepOverlayPrefillDvi(
  env: SyntheticEnv,
  deps: BrowserStepDeps = {},
): Promise<StepResult> {
  const t0 = Date.now();
  const cfg = deps.config ?? loadBrowserSyntheticConfig();
  const runProbe = deps.runProbe ?? runOverlayProbe;

  if (!cfg.enabled) {
    return {
      name: "overlay_prefill_dvi",
      ok: true,
      latencyMs: Date.now() - t0,
      extra: { skipped: "SYNTHETIC_BROWSER_ENABLED!=true" },
    };
  }

  // The probe is hermetic, but it still needs a sentinel shop id to stamp
  // into the recorded RO URL + extension storage.
  const shopId = env.smsShopId;
  if (!shopId) {
    return {
      name: "overlay_prefill_dvi",
      ok: false,
      latencyMs: Date.now() - t0,
      error: "missing env: smsShopId",
    };
  }
  if (!env.extToken) {
    return {
      name: "overlay_prefill_dvi",
      ok: false,
      latencyMs: Date.now() - t0,
      error: "missing env: extToken",
    };
  }

  const paths = defaultProbePaths();
  const probeCfg: OverlayProbeConfig = {
    ...paths,
    executablePath: process.env.CHROMIUM_PATH || null,
    shopId,
    roId: cfg.roId,
    vin: env.vin || "4T1B11HK5JU123456",
    mileage: cfg.mileage,
    extToken: env.extToken,
    apiHost: cfg.apiHost,
    tekHost: cfg.tekHost,
    timeoutMs: cfg.timeoutMs,
  };

  const result = await runProbe(probeCfg);
  return {
    name: "overlay_prefill_dvi",
    ok: result.ok,
    latencyMs: result.latencyMs ?? Date.now() - t0,
    error: result.error ?? null,
    extra: {
      requestFired: result.requestFired,
      uiUpdated: result.uiUpdated,
      buttonInjected: result.buttonInjected,
      ...(result.extra || {}),
    },
  };
}

export const ALL_BROWSER_STEPS: Array<
  (env: SyntheticEnv) => Promise<StepResult>
> = [stepOverlayPrefillDvi];
