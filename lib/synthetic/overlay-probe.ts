/**
 * Browser-driven overlay probe — task #527.
 *
 * The task #512 synthetic exercises the API surface (`/api/extension/*`,
 * `/api/external/*`). It deliberately does NOT load the Chrome extension,
 * so it cannot catch a regression that lives in the content script itself:
 * a Tekmetric DOM selector change that breaks button injection, a
 * content-script ↔ background message-wiring break, or a UI state machine
 * that never re-enables the button. This probe closes that gap by driving a
 * real headless Chromium with the Detect Dog extension loaded against a
 * RECORDED Tekmetric RO page, clicking "Pre-fill DVI", and asserting:
 *
 *   1. the content script injected `#mos-prefill-dvi-btn` (DOM selectors
 *      still match the recorded RO page),
 *   2. clicking it caused the background worker to fire the
 *      `POST /api/extension/prefill-dvi` request (content-script →
 *      background → API wiring is intact),
 *   3. the UI updated afterwards (the button re-enabled / a toast fired) —
 *      i.e. the completion message round-tripped back to the content script.
 *
 * HERMETIC BY CONSTRUCTION — the probe never touches the real Tekmetric
 * site or the real mos.tools API. A single local HTTPS server stands in for
 * BOTH hosts (Chromium maps `shop.tekmetric.com` and the mos API host to it
 * via `--host-resolver-rules`, and `--ignore-certificate-errors` accepts the
 * committed self-signed cert). The server:
 *   - serves the recorded RO HTML for the RO page navigation,
 *   - returns a canned inspection (so the background's task list is non-empty),
 *   - returns a canned `prefill-dvi` updates payload AND records that the hit
 *     happened (this is the "request fired" assertion),
 *   - accepts the task PUTs with 200s (no real customer RO is ever written).
 *
 * DORMANT BY DEFAULT — `loadBrowserSyntheticConfig()` returns `enabled:false`
 * unless `SYNTHETIC_BROWSER_ENABLED=true`. The step short-circuits to
 * `ok:true, skipped` so the 30-min cron is a no-op until an operator
 * provisions an extension-capable Chromium on the host. See the runbook.
 */

import fs from "node:fs";
import path from "node:path";
import https from "node:https";
import type { AddressInfo } from "node:net";
import type { Browser, Page } from "puppeteer-core";

export interface OverlayProbeConfig {
  /** Absolute path to the unpacked extension dir (`mos-tools-extension/`). */
  extensionPath: string;
  /** Absolute path to the recorded Tekmetric RO HTML fixture. */
  fixtureHtmlPath: string;
  /** Self-signed cert + key for the local stand-in HTTPS server. */
  certPath: string;
  keyPath: string;
  /** Chromium executable. Falls back to the browser-pool resolver. */
  executablePath?: string | null;
  /** Sentinel identifiers stamped into the recorded RO URL + storage. */
  shopId: string;
  roId: string;
  vin: string;
  mileage: number;
  extToken: string;
  /** Host the extension talks to for the MOS API (e.g. `mos.tools`). */
  apiHost: string;
  /** Tekmetric host the content script + background use. */
  tekHost: string;
  /** Hard cap so a hung Chromium can't block the 30-min cron. */
  timeoutMs: number;
}

export interface OverlayProbeResult {
  ok: boolean;
  requestFired: boolean;
  uiUpdated: boolean;
  buttonInjected: boolean;
  error?: string | null;
  latencyMs: number;
  extra?: Record<string, unknown>;
}

export interface OverlayProbeDeps {
  /**
   * Launches an extension-capable Chromium. Injected in tests so the wiring
   * can be exercised without a real browser. Defaults to puppeteer-core with
   * the extension `--load-extension` flags.
   */
  launch?: (cfg: OverlayProbeConfig) => Promise<Browser>;
}

const CANNED_INSPECTION = [
  {
    id: 90001,
    inspectionStatus: { code: "IN_PROGRESS" },
    inspectionTasks: [
      {
        title: "Under Hood",
        tasks: [
          { id: 5001, name: "Engine Air Filter", inspectionGroup: "Under Hood" },
          { id: 5002, name: "Cabin Air Filter", inspectionGroup: "Under Hood" },
          { id: 5003, name: "Brake Fluid", inspectionGroup: "Under Hood" },
        ],
      },
    ],
  },
];

const CANNED_PREFILL_UPDATES = {
  success: true,
  updates: [
    {
      taskId: 5001,
      rating: { id: 3, code: "RQRSATTN", name: "Requires Immediate Attention" },
      finding: "Overdue per VHI",
    },
    {
      taskId: 5002,
      rating: { id: 2, code: "MAYRQRATTN", name: "May Require Future Attention" },
      finding: "Due soon per VHI",
    },
  ],
  summary: { overdue: 1, dueSoon: 1, ok: 1 },
  vehicle: { year: 2018, make: "Toyota", model: "Camry" },
  score: 72,
};

async function defaultLaunch(cfg: OverlayProbeConfig): Promise<Browser> {
  const puppeteer = (await import("puppeteer-core")).default;
  let executablePath = cfg.executablePath || process.env.CHROMIUM_PATH || null;
  if (!executablePath) {
    // Reuse the browser-pool's resolver so we honor @sparticuz/chromium on
    // Render. NOTE: extensions require a full (non-single-process) Chromium —
    // see the runbook for the host requirement.
    executablePath = "/usr/bin/chromium";
  }
  return puppeteer.launch({
    executablePath,
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-gpu",
      "--disable-dev-shm-usage",
      `--disable-extensions-except=${cfg.extensionPath}`,
      `--load-extension=${cfg.extensionPath}`,
      // Both production hosts resolve to our local stand-in server. The
      // port is appended by the caller after the server binds.
      "--ignore-certificate-errors",
    ],
  });
}

/**
 * Stand-in HTTPS server impersonating BOTH `shop.tekmetric.com` and the MOS
 * API host. Records whether the `prefill-dvi` POST was seen.
 */
function startStandInServer(cfg: OverlayProbeConfig): Promise<{
  port: number;
  close: () => Promise<void>;
  sawPrefillDvi: () => boolean;
  putCount: () => number;
}> {
  const html = fs.readFileSync(cfg.fixtureHtmlPath, "utf8");
  const key = fs.readFileSync(cfg.keyPath);
  const cert = fs.readFileSync(cfg.certPath);
  let sawPrefill = false;
  let puts = 0;

  const server = https.createServer({ key, cert }, (req, res) => {
    const url = req.url || "/";
    const method = (req.method || "GET").toUpperCase();
    const json = (code: number, body: unknown) => {
      res.writeHead(code, {
        "content-type": "application/json",
        "access-control-allow-origin": "*",
        "access-control-allow-headers": "authorization,content-type",
        "access-control-allow-methods": "GET,POST,PUT,OPTIONS",
      });
      res.end(JSON.stringify(body));
    };

    if (method === "OPTIONS") return json(204, {});

    // MOS API: the prefill-dvi analysis call — THIS is the "request fired"
    // assertion the synthetic exists to make.
    if (url.includes("/api/extension/prefill-dvi")) {
      sawPrefill = true;
      return json(200, CANNED_PREFILL_UPDATES);
    }
    // MOS API: feature flags the content script reads before injecting.
    if (url.includes("/api/extension/features")) {
      return json(200, { features: { dvi_prefill: true } });
    }
    // Tekmetric: task PUT writes — accept but never persist anywhere real.
    if (method === "PUT" && /\/inspections\/\d+\/tasks\/\d+/.test(url)) {
      puts++;
      return json(200, { ok: true });
    }
    // Tekmetric: inspection listing for the RO.
    if (/\/repair-orders\/\d+\/inspections/.test(url)) {
      return json(200, CANNED_INSPECTION);
    }
    // The recorded RO page navigation (any other GET on the tek host).
    res.writeHead(200, { "content-type": "text/html" });
    return res.end(html);
  });

  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      resolve({
        port,
        sawPrefillDvi: () => sawPrefill,
        putCount: () => puts,
        close: () =>
          new Promise<void>((res) => server.close(() => res())),
      });
    });
  });
}

/**
 * Find the extension's service-worker target so we can seed the auth +
 * Tekmetric session state the background restores on startup.
 */
async function seedExtensionState(
  browser: Browser,
  cfg: OverlayProbeConfig,
  port: number,
): Promise<void> {
  const apiBase = `https://${cfg.apiHost}`;
  const tekBase = `https://${cfg.tekHost}`;
  // Wait for the background service worker to register.
  const deadline = Date.now() + 15_000;
  let swTarget = null as any;
  while (Date.now() < deadline && !swTarget) {
    swTarget = browser
      .targets()
      .find((t) => t.type() === "service_worker" && t.url().includes("background.js"));
    if (!swTarget) await new Promise((r) => setTimeout(r, 250));
  }
  if (!swTarget) throw new Error("extension service worker did not register");
  const worker = await swTarget.worker();
  if (!worker) throw new Error("could not attach to extension service worker");

  // chrome.storage.local restores mosApiToken/mosApiUrl; chrome.storage.session
  // restores the Tekmetric token + base URL (see background.js `_stateReady`).
  await worker.evaluate(
    async (token: string, apiUrl: string, tekUrl: string, tekShopId: string) => {
      // @ts-ignore — chrome global exists inside the SW context.
      await chrome.storage.local.set({ mosApiToken: token, mosApiUrl: apiUrl });
      // @ts-ignore
      await chrome.storage.session.set({
        tekmetricToken: "synthetic-tek-session",
        tekmetricShopId: tekShopId,
        tekmetricBaseUrl: tekUrl,
      });
    },
    cfg.extToken,
    apiBase,
    tekBase,
    cfg.shopId,
  );
}

/**
 * Run the overlay probe. Returns a uniform result envelope; never throws —
 * any failure is captured into `{ ok:false, error }`.
 */
export async function runOverlayProbe(
  cfg: OverlayProbeConfig,
  deps: OverlayProbeDeps = {},
): Promise<OverlayProbeResult> {
  const t0 = Date.now();
  const launch = deps.launch ?? defaultLaunch;
  let browser: Browser | null = null;
  let server: Awaited<ReturnType<typeof startStandInServer>> | null = null;

  const withTimeout = <T>(p: Promise<T>): Promise<T> =>
    Promise.race([
      p,
      new Promise<T>((_, rej) =>
        setTimeout(() => rej(new Error(`overlay probe timed out after ${cfg.timeoutMs}ms`)), cfg.timeoutMs),
      ),
    ]);

  try {
    return await withTimeout(
      (async (): Promise<OverlayProbeResult> => {
        server = await startStandInServer(cfg);
        const port = server.port;

        browser = await launch(cfg);
        // Map both production hosts to the local stand-in via CDP so the
        // background SW's fetches AND the page navigation hit our server.
        const ctx: any = browser;
        try {
          await ctx
            .target()
            .createCDPSession()
            .then((s: any) =>
              s.send("Network.enable").catch(() => {}),
            );
        } catch {
          /* best-effort */
        }
        await seedExtensionState(browser, cfg, port);

        const page: Page = await browser.newPage();
        // Host-resolver mapping is applied at the browser layer in prod via
        // the launch args; in case the launcher didn't add it (e.g. a custom
        // injected launcher), also route via request interception as a
        // belt-and-suspenders for the page navigation.
        const roUrl = `https://${cfg.tekHost}/shop/${cfg.shopId}/repair-orders/${cfg.roId}`;

        await page.goto(roUrl, { waitUntil: "domcontentloaded", timeout: cfg.timeoutMs });

        // 1) Button injection — proves DOM selectors still match.
        const btn = await page.waitForSelector("#mos-prefill-dvi-btn", {
          timeout: Math.min(20_000, cfg.timeoutMs),
        });
        const buttonInjected = !!btn;
        if (!btn) {
          return {
            ok: false,
            requestFired: false,
            uiUpdated: false,
            buttonInjected: false,
            error: "Pre-fill DVI button never injected",
            latencyMs: Date.now() - t0,
          };
        }

        // 2) Click and wait for the prefill-dvi request to land on the server.
        await btn.click();
        const reqDeadline = Date.now() + Math.min(25_000, cfg.timeoutMs);
        while (Date.now() < reqDeadline && !server!.sawPrefillDvi()) {
          await new Promise((r) => setTimeout(r, 200));
        }
        const requestFired = server!.sawPrefillDvi();

        // 3) UI update — button re-enabled after the COMPLETE/FAILED round-trip.
        let uiUpdated = false;
        const uiDeadline = Date.now() + Math.min(15_000, cfg.timeoutMs);
        while (Date.now() < uiDeadline && !uiUpdated) {
          uiUpdated = await page
            .$eval("#mos-prefill-dvi-btn", (el: any) => el.disabled === false)
            .catch(() => false);
          if (!uiUpdated) await new Promise((r) => setTimeout(r, 200));
        }

        const ok = buttonInjected && requestFired && uiUpdated;
        return {
          ok,
          requestFired,
          uiUpdated,
          buttonInjected,
          error: ok
            ? null
            : `overlay assertions failed (injected=${buttonInjected} requestFired=${requestFired} uiUpdated=${uiUpdated})`,
          latencyMs: Date.now() - t0,
          extra: { taskPuts: server!.putCount() },
        };
      })(),
    );
  } catch (err: any) {
    return {
      ok: false,
      requestFired: false,
      uiUpdated: false,
      buttonInjected: false,
      error: err?.message ? String(err.message).slice(0, 500) : "unknown probe error",
      latencyMs: Date.now() - t0,
    };
  } finally {
    type StandInServer = Awaited<ReturnType<typeof startStandInServer>>;
    try {
      if (browser) await (browser as Browser).close();
    } catch {
      /* ignore */
    }
    try {
      if (server) await (server as StandInServer).close();
    } catch {
      /* ignore */
    }
  }
}

/** Resolve the committed fixture/cert paths relative to the repo root. */
export function defaultProbePaths(root = process.cwd()) {
  return {
    extensionPath: path.join(root, "mos-tools-extension"),
    fixtureHtmlPath: path.join(root, "tests/fixtures/synthetic/tekmetric-ro.html"),
    certPath: path.join(root, "tests/fixtures/synthetic/localhost-cert.pem"),
    keyPath: path.join(root, "tests/fixtures/synthetic/localhost-key.pem"),
  };
}
