export const BACKFILL_WORKER_KINDS = [
  "tekmetric-fullpage",
  "tekmetric-prepass",
  "drain-tekmetric",
  "drain-protractor",
] as const;

/** Pure boot-time selection; isolation removes only Protractor work. */
export function selectBackfillWorkerKinds(protractorAllowed: boolean) {
  return BACKFILL_WORKER_KINDS.filter(
    (kind) => kind !== "drain-protractor" || protractorAllowed,
  );
}