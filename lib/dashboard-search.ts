/**
 * Index-friendly search helpers for the dashboard / KB Mongo queries.
 *
 * The dashboard search used unanchored, case-insensitive `$regex` across
 * vin / make / model / customer name. A `{ $regex: term, $options: 'i' }`
 * predicate is a leading-wildcard "contains" match: MongoDB cannot bound it
 * with an index, so every `$or` branch degrades the query to a collection
 * scan of the shop's documents. On large shops (100k+ ROs) that gets slow in
 * exactly the same way the job-search `ILIKE '%…%'` path did before pg_trgm.
 *
 * The fix is to anchor each branch to a prefix expression (`^term`). An
 * anchored regex is index-eligible, so with the companion indexes in
 * `scripts/ensure-indexes.ts` the planner can use a bounded index scan
 * instead of a full COLLSCAN. VIN values are stored upper-cased, so VIN is
 * matched case-sensitively against the upper-cased term for the tightest
 * bounds; the remaining human-entered fields stay case-insensitive.
 *
 * Semantics change from "contains" to "starts with". That is acceptable for
 * these fields: VIN/RO searches are prefix (or full) by nature, and customer
 * searches match first- or last-name prefixes via their own `$or` branches.
 */

/** Escape a user-supplied string so it is treated as a literal in a regex. */
export function escapeRegex(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Build an anchored (prefix) regex condition for a Mongo field.
 * Anchoring makes the predicate index-eligible instead of a full scan.
 */
export function prefixRegex(
  term: string,
  opts: { caseInsensitive?: boolean } = {},
): { $regex: string; $options?: string } {
  const anchored = `^${escapeRegex(term)}`;
  return opts.caseInsensitive === false
    ? { $regex: anchored }
    : { $regex: anchored, $options: "i" };
}

/** Anchored, case-sensitive VIN prefix (VINs are stored upper-cased). */
export function vinPrefix(term: string): { $regex: string } {
  return prefixRegex(term.toUpperCase(), { caseInsensitive: false }) as {
    $regex: string;
  };
}

/**
 * Small set of casing variants for a human-entered value ("toyota" →
 * ["toyota", "TOYOTA", "Toyota"]). Used to turn a case-INSENSITIVE match —
 * which MongoDB cannot bound with a regular index — into an index-eligible
 * `$in` of case-SENSITIVE values. Covers the casings real writers produce
 * (raw, UPPER, lower, Title Case per word); pathological MiXeD case is not
 * matched, which is acceptable for make/model fields that come from SMS
 * providers with consistent casing.
 */
export function caseVariants(term: string): string[] {
  const t = term.trim();
  if (!t) return [];
  const title = t
    .toLowerCase()
    .replace(/(^|[\s\-/])([a-z])/g, (_m, sep, ch) => sep + ch.toUpperCase());
  return Array.from(new Set([t, t.toUpperCase(), t.toLowerCase(), title]));
}

/**
 * Index-eligible, case-insensitive-ish EXACT match: `$in` of the casing
 * variants. Replaces `{ $regex: ^term$, $options: "i" }`, which forces a
 * scan of the shopId-bounded slice.
 */
export function exactCaseVariants(term: string): { $in: string[] } {
  return { $in: caseVariants(term) };
}

/**
 * Index-eligible, case-insensitive-ish PREFIX match: `$in` of anchored,
 * case-SENSITIVE regexes (Mongo `$in` accepts regexes, and each anchored
 * case-sensitive branch can be bounded by an index). Replaces unanchored
 * `{ $regex: term, $options: "i" }` "contains" matches.
 */
export function prefixCaseVariants(term: string): { $in: RegExp[] } {
  return {
    $in: caseVariants(term).map((v) => new RegExp(`^${escapeRegex(v)}`)),
  };
}
