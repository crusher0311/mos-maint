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
  const hashMisplaced: any[] = [];
  const noCredentials: any[] = [];
  const strayPasswordOnHashedRow: any[] = [];

  for (const u of all) {
    const hashOk = looksLikeBcrypt(u.passwordHash) || looksLikeScrypt(u.passwordHash);
    const passwordIsBcrypt = looksLikeBcrypt(u.password) || looksLikeScrypt(u.password);
    if (hashOk) {
      // Hash is fine; just flag any leftover `password` field so we can clear it.
      if (typeof u.password === "string" && u.password.length > 0) {
        strayPasswordOnHashedRow.push(u);
      }
      continue;
    }
    // Anything past this point lacks a usable bcrypt/scrypt hash in passwordHash.
    if (passwordIsBcrypt) {
      // The hash landed under the legacy `password` field instead of
      // `passwordHash` (task #308). Move it; user keeps their existing password.
      hashMisplaced.push(u);
      continue;
    }
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

  type Bucket = "recoverable" | "orphan" | "misplaced" | "stray";
  const byShop = new Map<string, Record<Bucket, number>>();
  function bump(sid: any, key: Bucket) {
    const k = String(sid ?? "(none)");
    const cur = byShop.get(k) ?? { recoverable: 0, orphan: 0, misplaced: 0, stray: 0 };
    cur[key] += 1;
    byShop.set(k, cur);
  }
  plaintextRecoverable.forEach((u) => bump(u.shopId, "recoverable"));
  noCredentials.forEach((u) => bump(u.shopId, "orphan"));
  hashMisplaced.forEach((u) => bump(u.shopId, "misplaced"));
  strayPasswordOnHashedRow.forEach((u) => bump(u.shopId, "stray"));

  console.log(`\nAudit: ${all.length} total users`);
  console.log(`  ${plaintextRecoverable.length} plaintext-recoverable`);
  console.log(`  ${hashMisplaced.length} hash-in-wrong-field (task #308)`);
  console.log(`  ${strayPasswordOnHashedRow.length} stray-password-on-hashed-row`);
  console.log(`  ${noCredentials.length} no-usable-credentials`);
  console.log(`\nPer-shop breakdown:`);
  const rows = Array.from(byShop.entries()).sort();
  for (const [sid, c] of rows) {
    if (c.recoverable === 0 && c.orphan === 0 && c.misplaced === 0 && c.stray === 0) continue;
    console.log(
      `  shop ${sid.padEnd(8)} recoverable=${c.recoverable} misplaced=${c.misplaced} stray=${c.stray} orphan=${c.orphan}`,
    );
  }
  if (hashMisplaced.length > 0) {
    console.log(`\nHash-in-wrong-field rows:`);
    for (const u of hashMisplaced) {
      console.log(`  → ${u.email} (shop ${u.shopId ?? "(none)"})`);
    }
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

  let moved = 0;
  for (const u of hashMisplaced) {
    await users.updateOne(
      { _id: u._id },
      { $set: { passwordHash: String(u.password) }, $unset: { password: "" } },
    );
    moved += 1;
    console.log(`  → moved hash to passwordHash: ${u.email} (shop ${u.shopId ?? "(none)"})`);
  }
  console.log(`Moved ${moved} misplaced hash(es) into passwordHash.`);

  let cleared = 0;
  for (const u of strayPasswordOnHashedRow) {
    await users.updateOne({ _id: u._id }, { $unset: { password: "" } });
    cleared += 1;
  }
  console.log(`Cleared ${cleared} stray password field(s) on already-hashed rows.`);

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
