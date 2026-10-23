import { sql, type SQL } from "drizzle-orm";

export class ProtractorSnapshotWriteConflict extends Error {
  constructor() {
    super("Protractor snapshot write rejected: identity or provider-version conflict");
    this.name = "ProtractorSnapshotWriteConflict";
  }
}

/** Compare provider versions, never local cache/write times.
 * Unknown incoming versions cannot overwrite a known provider version.
 * Equal-version, different payloads are conflicts, not last-writer-wins.
 */
export function protractorSnapshotFreshness(storedRawData: SQL, incomingRaw: unknown): SQL {
  const raw = incomingRaw as any;
  const stamp = raw?.Header?.LastModifiedTime;
  const zoned = typeof stamp === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(stamp);
  // Parse both versions in PostgreSQL so sub-millisecond provider precision
  // is not lost through JavaScript's millisecond Date representation.
  const epoch = zoned && Number.isFinite(Date.parse(stamp)) && Date.parse(stamp) > 0
    ? sql`extract(epoch from ${stamp}::timestamptz)` : sql`NULL::numeric`;
  const storedStamp = sql`(${storedRawData}->'rawPayload'->'Header'->>'LastModifiedTime')`;
  const storedEpoch = sql`CASE WHEN ${storedStamp} ~
    '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}([.][0-9]+)?(Z|[+-][0-9]{2}:[0-9]{2})$'
    THEN extract(epoch from ${storedStamp}::timestamptz) ELSE NULL END`;
  return sql`(
    (${storedEpoch} IS NULL AND ${epoch} IS NULL)
    OR (${epoch} IS NOT NULL AND
      (${storedEpoch} IS NULL OR ${epoch} > ${storedEpoch}))
    OR (${epoch} = ${storedEpoch}
      AND ${storedRawData}->'rawPayload' = ${JSON.stringify(raw ?? null)}::text::jsonb)
  )`;
}
