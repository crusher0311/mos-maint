// Task #860: shared helpers for DVI report parsers. Pure (tsx-testable).

/**
 * Extracts a balanced JSON object from `text` starting at the first `{`
 * at/after `startIndex`, honoring string literals and escapes. Returns the
 * raw JSON substring or null.
 */
export function extractBalancedJson(
  text: string,
  startIndex: number,
): string | null {
  const k = text.indexOf("{", startIndex);
  if (k < 0) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = k; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return text.slice(k, i + 1);
    }
  }
  return null;
}

/** Finds `marker` in `text` and parses the balanced JSON object after it. */
export function parseJsonAfterMarker<T = unknown>(
  text: string,
  marker: string,
): T | null {
  const i = text.indexOf(marker);
  if (i < 0) return null;
  const raw = extractBalancedJson(text, i + marker.length);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export function toIntOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = typeof value === "number" ? value : parseInt(String(value), 10);
  return Number.isFinite(n) ? Math.round(n) : null;
}

export function cleanText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const s = String(value).replace(/\s+/g, " ").trim();
  return s.length > 0 ? s : null;
}

/** Splits camel/Pascal-case provider keys into words ("FrontPadsShoes" → "Front Pads Shoes"). */
export function decamel(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .trim();
}
