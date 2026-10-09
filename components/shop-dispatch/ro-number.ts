/** Human-facing RO input accepts the common display prefixes, not provider IDs. */
export function normalizeRoNumber(value: string): string {
  return value.trim().replace(/^(?:RO(?=\s|[:#-]|\d|$)\s*[:#-]?\s*|#\s*)/i, "").replace(/^#\s*/, "").trim();
}
