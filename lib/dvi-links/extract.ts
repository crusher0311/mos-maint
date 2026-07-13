// Task #860: detect DVI share links inside a synced work-order payload.
//
// Links live in Protractor service-package line `URL` fields and in free
// text (package titles/descriptions/footers, deferred packages). Rather
// than chase every nesting variant, we scan the serialized payload for
// URLs and match them against the provider registry — new payload shapes
// can never hide a link from us. Pure module (tsx-testable).
import type { DetectedDviLink } from "./types";
import { providerForUrl } from "./registry";

// Match http(s) URLs; stop at whitespace, quotes, angle brackets and
// JSON-escaping artifacts.
const URL_RE = /https?:\/\/[^\s"'<>\\|)\]}]+/gi;

/** Trailing punctuation that belongs to surrounding prose, not the URL. */
function trimUrl(raw: string): string {
  return raw.replace(/[.,;:!?]+$/, "");
}

/**
 * Extracts all recognized DVI share links from an arbitrary payload
 * (object or string). Returns deduped, normalized links.
 */
export function extractDviLinks(payload: unknown): DetectedDviLink[] {
  const text =
    typeof payload === "string" ? payload : safeStringify(payload);
  if (!text) return [];
  const seen = new Set<string>();
  const out: DetectedDviLink[] = [];
  let m: RegExpExecArray | null;
  URL_RE.lastIndex = 0;
  while ((m = URL_RE.exec(text)) !== null) {
    const url = trimUrl(m[0]);
    const def = providerForUrl(url);
    if (!def) continue;
    const key = normalizeDviLinkKey(url);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ provider: def.provider, url });
  }
  return out;
}

/**
 * Canonical dedup key for a link: lowercase host, path as-is, query kept
 * (AutoFlow microsite ids live in the query string), fragment dropped.
 */
export function normalizeDviLinkKey(rawUrl: string): string {
  try {
    const u = new URL(rawUrl);
    u.hash = "";
    return `${u.hostname.toLowerCase()}${u.pathname}${u.search}`;
  } catch {
    return rawUrl;
  }
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "";
  }
}
