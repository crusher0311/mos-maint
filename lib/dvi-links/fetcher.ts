// Task #860: DVI share-link fetcher — server-side fetch with timeouts,
// polite pacing, outcome classification, and the avlink.io TLS workaround.
//
// avlink.io serves a broken TLS chain (Node fetch fails with
// UNABLE_TO_VERIFY_LEAF_SIGNATURE) but only ever 302-redirects to
// tvpx.autovitals.com (valid TLS). We resolve the redirect with relaxed
// verification for that ONE host, then fetch the target with full
// verification. No report content is ever trusted from the relaxed hop.
import https from "node:https";
import { providerForUrl } from "./registry";
import type { DviFetchOutcome } from "./types";

const FETCH_TIMEOUT_MS = 20_000;
const MAX_BODY_BYTES = 4 * 1024 * 1024; // 4 MB cap on stored snapshots

const BROWSER_HEADERS: Record<string, string> = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  Accept:
    "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
};

export interface DviFetchResult {
  outcome: DviFetchOutcome;
  httpStatus?: number;
  contentType?: string | null;
  /** Final URL after redirects (e.g. tvpx.autovitals.com report page). */
  finalUrl?: string;
  /** Response body (HTML/JSON) when outcome is "ok". */
  body?: string;
  /** For media outcomes: the resolved media URL (body not stored). */
  mediaUrl?: string;
  error?: string;
}

function isAvlinkHost(url: string): boolean {
  try {
    const h = new URL(url).hostname.toLowerCase();
    return h === "avlink.io" || h.endsWith(".avlink.io");
  } catch {
    return false;
  }
}

/**
 * Resolves the redirect target of an avlink.io short link using relaxed TLS
 * verification (documented broken chain). Never returns body content.
 */
function resolveAvlinkRedirect(url: string): Promise<string | null> {
  return new Promise((resolve) => {
    const u = new URL(url);
    const req = https.request(
      {
        hostname: u.hostname,
        path: u.pathname + u.search,
        method: "GET",
        headers: BROWSER_HEADERS,
        rejectUnauthorized: false, // avlink.io broken chain — redirect hop only
        timeout: FETCH_TIMEOUT_MS,
      },
      (res) => {
        res.resume();
        const loc = res.headers.location;
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && loc) {
          resolve(new URL(loc, url).toString());
        } else {
          resolve(null);
        }
      },
    );
    req.on("timeout", () => {
      req.destroy(new Error("timeout"));
    });
    req.on("error", () => resolve(null));
    req.end();
  });
}

export async function fetchDviLink(url: string): Promise<DviFetchResult> {
  const def = providerForUrl(url);
  let target = url;

  try {
    if (isAvlinkHost(url)) {
      const resolved = await resolveAvlinkRedirect(url);
      if (!resolved) {
        return { outcome: "error", error: "avlink.io redirect resolution failed" };
      }
      target = resolved;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(target, {
        headers: BROWSER_HEADERS,
        redirect: "follow",
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    const contentType = res.headers.get("content-type");
    const finalUrl = res.url || target;

    // Media share links (AutoOps) resolve to images/video — record the URL,
    // don't download the payload.
    if (
      def?.mediaOnly ||
      (contentType && /^(image|video)\//i.test(contentType))
    ) {
      res.body?.cancel?.().catch(() => {});
      if (res.ok) {
        return {
          outcome: "media",
          httpStatus: res.status,
          contentType,
          finalUrl,
          mediaUrl: finalUrl,
        };
      }
      return classifyHttpFailure(res.status, contentType, finalUrl);
    }

    if (!res.ok) {
      res.body?.cancel?.().catch(() => {});
      return classifyHttpFailure(res.status, contentType, finalUrl);
    }

    const body = await readCapped(res, MAX_BODY_BYTES);

    // AutoFlow microsites expire with a 200 "Invalid id!" page.
    if (/invalid\s+id!?/i.test(body.slice(0, 4000)) && body.length < 20000) {
      return {
        outcome: "expired",
        httpStatus: res.status,
        contentType,
        finalUrl,
        body,
        error: "expired microsite (Invalid id!)",
      };
    }

    return { outcome: "ok", httpStatus: res.status, contentType, finalUrl, body };
  } catch (e: any) {
    const msg = String(e?.message ?? e);
    return { outcome: "error", error: msg };
  }
}

function classifyHttpFailure(
  status: number,
  contentType: string | null,
  finalUrl: string,
): DviFetchResult {
  // AutoServe1 expired reports return HTTP 500 with an empty body (verified
  // live); 404/410 are gone everywhere.
  if (status === 404 || status === 410 || status === 500) {
    return {
      outcome: "expired",
      httpStatus: status,
      contentType,
      finalUrl,
      error: `HTTP ${status} (report expired or removed)`,
    };
  }
  if (status === 401 || status === 403 || status === 429) {
    return {
      outcome: "blocked",
      httpStatus: status,
      contentType,
      finalUrl,
      error: `HTTP ${status}`,
    };
  }
  return {
    outcome: "error",
    httpStatus: status,
    contentType,
    finalUrl,
    error: `HTTP ${status}`,
  };
}

async function readCapped(res: Response, cap: number): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return await res.text();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      total += value.byteLength;
      if (total > cap) {
        reader.cancel().catch(() => {});
        break;
      }
      chunks.push(value);
    }
  }
  return Buffer.concat(chunks).toString("utf8");
}
