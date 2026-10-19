import { historyFailureCode } from "./protractor-history-existing-invoice";

const stages = [
  "unknown", "mongo_duplicate_check", "postgres_duplicate_check",
  "ingestion", "ingestion_verification", "receipt_completion",
] as const;
export type HeldFailureStage = typeof stages[number];
export type HeldFailure = { stage: HeldFailureStage; code: string };

/** Deliberately excludes error text, SQL, invoice data and connection details. */
export function sanitizedHeldFailure(value: unknown): HeldFailure {
  const input = value as { stage?: unknown; code?: unknown } | null;
  return {
    stage: stages.includes(input?.stage as HeldFailureStage)
      ? input!.stage as HeldFailureStage : "unknown",
    code: historyFailureCode(input),
  };
}

/** Append evidence in the SAME atomic update that advances the held day. */
export function heldDayPush(day: string, page: number, failure: unknown) {
  return { heldDays: day, heldFailures: { day, page, ...sanitizedHeldFailure(failure) } };
}

export function heldDayFailureEvidence(cursor: any, day: string) {
  const records = Array.isArray(cursor?.heldFailures) ? cursor.heldFailures : [];
  return records.filter((r: any) => r?.day === day).map((r: any) => ({
    page: Number.isSafeInteger(r.page) && r.page >= 0 ? r.page : null,
    ...sanitizedHeldFailure(r),
  }));
}
