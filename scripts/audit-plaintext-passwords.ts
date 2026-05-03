/**
 * Audit & one-time backfill for plaintext credentials in the `users`
 * collection (task #302).
 *
 * Background:
 *   The extension and web login routes used to compare a submitted password
 *   against a plaintext `password` field on the user row, then opportunistically
 *   bcrypt-rehash on successful login. That fallback has been removed, so any
 *   user row whose only credential material is plaintext can no longer log in.
 *
 * What this script does (idempotent, safe to re-run):
 *   1. Counts user rows that look "plaintext-only" (no bcrypt/scrypt hash in
 *      `passwordHash`, but a non-empty `password` field). Reports counts by
 *      shopId.
 *   2. For rows that have a recoverable plaintext, bcrypt-hashes it into
 *      `passwordHash` and unsets the `password` field.
 *   3. For rows that have neither a usable hash nor a plaintext, marks them
 *      `mustChangePassword: true` so the next login forces a reset, and
 *      logs them so the affected shops can be notified out of band.
 *
 * Usage:
 *   npx tsx scripts/audit-plaintext-passwords.ts            # audit only
 *   npx tsx scripts/audit-plaintext-passwords.ts --apply    # backfill
 */

import bcrypt from "bcryptjs";
import { getDb } from "../lib/mongo";

function looksLikeBcrypt(s: unknown): boolean {
  return typeof s === "string" && /^\$2[aby]\$/.test(s);
}

function looksLikeScrypt(s: unknown): boolean {
  return typeof s === "string" && s.startsWith("scrypt:");
}

async function main() {
  const apply = process.argv.includes("--apply");
  const db = await getDb();
  const users = db.collection("users");

  const all = await users
    .find({}, { projection: { _id: 1, email: 1, shopId: 1, passwordHash: 1, password: 1, mustChangePassword: 1 } })
    .toArray();

  const plaintextRecoverable: any[] = [];
  const noCredentials: any[] = [];

  for (const u of all) {
    const hashOk = looksLikeBcrypt(u.passwordHash) || looksLikeScrypt(u.passwordHash);
    if (hashOk) continue;
    // Anything past this point lacks a usable bcrypt/scrypt hash.
    const plain = typeof u.password === "string" && u.password.length > 0 ? u.password : null;
    if (plain) {
      plaintextRecoverable.push(u);
    } else {
      // No usable hash AND no recoverable plaintext — covers:
      //   * passwordHash null/missing and no password column
      //   * passwordHash present but malformed (not bcrypt, not scrypt)
      //   * password column present but empty/non-string
      // All of these must be force-reset per task #302.
      noCredentials.push(u);
    }
  }

  const byShop = new Map<string, { recoverable: number; orphan: number }>();
  function bump(sid: any, key: "recoverable" | "orphan") {
    const k = String(sid ?? "(none)");
    const cur = byShop.get(k) ?? { recoverable: 0, orphan: 0 };
    cur[key] += 1;
    byShop.set(k, cur);
  }
  plaintextRecoverable.forEach((u) => bump(u.shopId, "recoverable"));
  noCredentials.forEach((u) => bump(u.shopId, "orphan"));

  console.log(`\nAudit: ${all.length} total users`);
  console.log(`  ${plaintextRecoverable.length} plaintext-recoverable`);
  console.log(`  ${noCredentials.length} no-usable-credentials`);
  console.log(`\nPer-shop breakdown:`);
  const rows = Array.from(byShop.entries()).sort();
  for (const [sid, c] of rows) {
    if (c.recoverable === 0 && c.orphan === 0) continue;
    console.log(`  shop ${sid.padEnd(8)} recoverable=${c.recoverable} orphan=${c.orphan}`);
  }

  if (!apply) {
    console.log(`\n(dry-run) re-run with --apply to backfill.`);
    return;
  }

  let rehashed = 0;
  for (const u of plaintextRecoverable) {
    const newHash = await bcrypt.hash(String(u.password), 12);
    await users.updateOne(
      { _id: u._id },
      { $set: { passwordHash: newHash }, $unset: { password: "" } },
    );
    rehashed += 1;
  }
  console.log(`Rehashed ${rehashed} plaintext credential(s) into bcrypt.`);

  let forcedReset = 0;
  for (const u of noCredentials) {
    await users.updateOne(
      { _id: u._id },
      { $set: { mustChangePassword: true }, $unset: { password: "" } },
    );
    forcedReset += 1;
    console.log(`  → must-reset: ${u.email} (shop ${u.shopId ?? "(none)"})`);
  }
  console.log(`Marked ${forcedReset} user(s) as must-change-password.`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("audit-plaintext-passwords failed:", err);
    process.exit(1);
  });
