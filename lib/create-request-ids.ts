/**
 * Task #936: per-create idempotency keys for the New Work Order wizard.
 *
 * A key is generated on the first submit of a step and reused on retry after a
 * timeout/failure, so the server upserts the SAME client-pinned Protractor
 * record (POST /Contact/{id} and /WorkOrder/{id} upsert by ID) instead of
 * creating a duplicate. Keys are cleared on success — and MUST be cleared when
 * the modal session ends, or a stale key from a prior session would silently
 * overwrite the previous record instead of creating a new one.
 */

export type CreateStep = "contact" | "vehicle" | "workOrder";
export type CreateRequestIds = Partial<Record<CreateStep, string>>;

export function generateRequestId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  // Non-secure-context fallback (e.g. plain-HTTP dev preview).
  let out = "";
  const hex = "0123456789abcdef";
  for (const ch of "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx") {
    if (ch === "x") out += hex[Math.floor(Math.random() * 16)];
    else if (ch === "y") out += hex[8 + Math.floor(Math.random() * 4)];
    else out += ch;
  }
  return out;
}

/** Get the key for a step, generating (and storing) one if absent. Reused across retries within a session. */
export function getOrCreateRequestId(ids: CreateRequestIds, step: CreateStep): string {
  if (!ids[step]) ids[step] = generateRequestId();
  return ids[step]!;
}

/** Clear one step's key after a successful create. */
export function clearRequestId(ids: CreateRequestIds, step: CreateStep): void {
  ids[step] = undefined;
}

/** Clear ALL keys when the modal session ends (close/reset). */
export function resetRequestIds(ids: CreateRequestIds): void {
  ids.contact = undefined;
  ids.vehicle = undefined;
  ids.workOrder = undefined;
}
