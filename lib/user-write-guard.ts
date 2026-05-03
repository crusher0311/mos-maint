/**
 * task #309: defensive guard against re-introducing the legacy `password`
 * field on rows in the `users` (or `platform_admins`) collection.
 *
 * Background:
 *   The login routes read the bcrypt/scrypt hash from `passwordHash`. An
 *   older code path used to write the hash under `password` instead, which
 *   left those users unable to log in once the plaintext-fallback was
 *   removed (see task #302). Audit task #307 found 4 admin rows that had
 *   regressed to the legacy field after #302 shipped — meaning at least
 *   one provisioning path was still writing it.
 *
 *   This helper is wired into every user-create / user-write call site so
 *   the bug fails loudly the next time someone reintroduces the legacy
 *   field name (e.g. by spreading a request body, copying an old script,
 *   or naming a new column `password`).
 */

type AnyDoc = Record<string, unknown> | null | undefined;

function hasOwn(obj: AnyDoc, key: string): boolean {
  return !!obj && Object.prototype.hasOwnProperty.call(obj, key);
}

/**
 * Throws if `doc` (a user document or a Mongo update operator object such
 * as `{ $set: {...}, $unset: {...} }`) attempts to set the legacy
 * `password` field. `$unset: { password: "" }` is allowed — that's how we
 * actively scrub the legacy field on read/write paths.
 */
export function assertNoLegacyPasswordField(doc: AnyDoc, context = "users"): void {
  if (!doc) return;

  // Direct doc shape: e.g. users.insertOne({ email, passwordHash, ... })
  if (hasOwn(doc, "password")) {
    throw new Error(
      `[user-write-guard] Refusing to write legacy 'password' field on ${context}. ` +
        `Use 'passwordHash' instead. (task #309)`,
    );
  }

  // Mongo update-operator shape: { $set: { ... }, $setOnInsert: { ... } }
  for (const op of ["$set", "$setOnInsert"] as const) {
    const inner = (doc as Record<string, AnyDoc>)[op];
    if (inner && hasOwn(inner, "password")) {
      throw new Error(
        `[user-write-guard] Refusing to ${op} legacy 'password' field on ${context}. ` +
          `Use 'passwordHash' instead. (task #309)`,
      );
    }
  }
}
