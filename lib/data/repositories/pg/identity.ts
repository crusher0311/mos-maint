/**
 * Postgres-backed identity / billing / settings repository — the read &
 * write surface used by the W4-cutover central libraries (lib/auth.ts,
 * lib/extension-auth.ts, lib/super-admins.ts, lib/shops.ts,
 * lib/featureResolver.ts, lib/stripe.ts, lib/enterprise.ts) when
 * `IDENTITY_PG_CANONICAL=1` is set.
 *
 * Design notes:
 *   - Every function returns Mongo-shaped doc objects (`shopId`,
 *     `_id`-as-string, etc.) so the central libs and their existing
 *     callers don't have to learn a new shape. The dispatcher in each
 *     lib just picks PG vs Mongo and the rest of the file is unchanged.
 *   - Updates that previously used Mongo's `$set: { 'billing.plan': ...}`
 *     dot-path syntax are translated into jsonb path updates here (see
 *     `updateShopFields`).
 *   - This repo has NO knowledge of the kill-switch flag — the
 *     dispatching is done in the central lib so the flag check is
 *     near the call site and easy to grep.
 *
 * See `docs/runbooks/db-w4-cutover.md` for the cutover playbook.
 */
import { and, eq, gt, inArray, ne, sql } from "drizzle-orm";
import { getDb } from "@/lib/db/drizzle";
import {
  shops,
  users,
  sessions,
  enterpriseAccounts,
  shopFeatures,
  platformAdmins,
  platformSettings,
  platformPlans,
  pendingSignups,
  setupTokens,
  passwordResetTokens,
  billingSettings,
  billingStatusLog,
  stripeEvents,
  stripeWebhookEvents,
} from "@/lib/db/schema/wave4";

type Json = Record<string, unknown>;

/* -------------------------------------------------------------------------- */
/* Mongo-shaped return types                                                   */
/*                                                                             */
/* These describe the doc shape the central libs (lib/auth.ts,                */
/* lib/extension-auth.ts, lib/stripe.ts, lib/featureResolver.ts) expect       */
/* — i.e. what a Mongo `.findOne()` would have returned. Exporting them      */
/* lets the central libs drop their `let user: any` / `(shop as any)`         */
/* escape hatches and dispatch with a single shared type regardless of       */
/* whether the read landed against PG or Mongo.                              */
/* -------------------------------------------------------------------------- */

export interface MongoShapedShop {
  shopId: number;
  id?: number;
  name?: string;
  locationIdentifier?: string;
  enterpriseId?: string;
  enabledFeatures?: Json;
  billing?: {
    plan?: string;
    status?: string;
    stripeCustomerId?: string;
    [k: string]: unknown;
  };
  stripeCustomerId?: string;
  settings?: Json;
  sticker?: Json;
  metadata?: Json;
  createdAt?: Date;
  updatedAt?: Date;
  [k: string]: unknown;
}

export interface MongoShapedUser {
  _id: string;
  id: string;
  email: string;
  emailLower: string;
  passwordHash?: string;
  role: string;
  shopId?: number;
  shopIds: unknown[];
  isPlatformAdmin: boolean;
  mustChangePassword: boolean;
  extensionToken?: string;
  extensionTokenCreatedAt?: Date;
  profile?: Json;
  auditMeta?: Json;
  createdAt?: Date;
  updatedAt?: Date;
  [k: string]: unknown;
}

export interface MongoShapedSession {
  token: string;
  userId: string;
  shopId?: number;
  isImpersonation: boolean;
  impersonatedBy?: string;
  mustChangePassword: boolean;
  expiresAt: Date;
  createdAt: Date;
}

export interface MongoShapedEnterprise {
  _id: string;
  id: string;
  name: string;
  shopIds: unknown[];
  sharedMappings?: Json;
  sharedIntegrations?: Json;
  featureSettings?: Json;
  createdAt?: Date;
  updatedAt?: Date;
}

/* -------------------------------------------------------------------------- */
/* shops                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Reshape a PG `shops` row into the Mongo-style doc the rest of the
 * codebase expects (`shopId` numeric, `billing` subdoc, etc.).
 */
function shopRowToDoc(r: typeof shops.$inferSelect | null): MongoShapedShop | null {
  if (!r) return null;
  return {
    shopId: r.mosShopId,
    id: r.legacyId ?? undefined,
    name: r.name ?? undefined,
    locationIdentifier: r.locationIdentifier ?? undefined,
    enterpriseId: r.enterpriseId ?? undefined,
    enabledFeatures: (r.enabledFeatures as Json) ?? undefined,
    billing: (r.billing as Json) ?? undefined,
    stripeCustomerId: r.stripeCustomerId ?? undefined,
    settings: (r.settings as Json) ?? undefined,
    sticker: (r.sticker as Json) ?? undefined,
    metadata: (r.metadata as Json) ?? undefined,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    // Legacy callers sometimes spread the doc and read flat per-area
    // keys (e.g. `shop.autoflow?.apiKey`). Promote `settings` keys to
    // top-level so existing read code keeps working unchanged.
    ...((r.settings as Json) ?? {}),
  };
}

export async function findShopByMosShopId(shopId: number | string) {
  const db = getDb();
  const id = Number(shopId);
  if (!Number.isFinite(id)) return null;
  const rows = await db.select().from(shops).where(eq(shops.mosShopId, id)).limit(1);
  return shopRowToDoc(rows[0] ?? null);
}

export async function findShopByLegacyId(legacyId: number) {
  const db = getDb();
  const rows = await db.select().from(shops).where(eq(shops.legacyId, legacyId)).limit(1);
  return shopRowToDoc(rows[0] ?? null);
}

export async function listShopsByMosShopIds(ids: number[]) {
  const db = getDb();
  if (!ids.length) return [];
  const rows = await db.select().from(shops).where(inArray(shops.mosShopId, ids));
  return rows.map((r) => shopRowToDoc(r)!);
}

export async function listAllShops() {
  const db = getDb();
  const rows = await db.select().from(shops);
  return rows.map((r) => shopRowToDoc(r)!);
}

/**
 * Apply a flat `$set` map (possibly using Mongo dot-path keys like
 * `'billing.plan'` or `'autoflow.apiKey'`) to a single shop. Top-level
 * columns are written to their column; dot-paths land in the
 * appropriate jsonb container.
 *
 * Top-level columns we promote: `name`, `locationIdentifier`,
 * `enterpriseId`, `stripeCustomerId`, `billingPlan`, `billingStatus`,
 * `enabledFeatures`. Everything else lands in `settings` (the catch-all
 * jsonb that legacy code spreads to top-level on read — see
 * `shopRowToDoc`).
 */
const SHOP_TOP_LEVEL = new Set([
  "name",
  "locationIdentifier",
  "enterpriseId",
  "stripeCustomerId",
  "enabledFeatures",
]);

const SHOP_JSONB_CONTAINERS: Record<
  string,
  "billing" | "settings" | "sticker" | "metadata" | "enabledFeatures"
> = {
  billing: "billing",
  settings: "settings",
  sticker: "sticker",
  metadata: "metadata",
  // Per-feature toggles live in their own jsonb column. Legacy updates
  // targeted top-level dot-paths (`enabledFeatures.maintenance`); route
  // those into the `enabled_features` jsonb column rather than dumping
  // them in `settings` (where the read-time spread would shadow the
  // canonical column).
  enabledFeatures: "enabledFeatures",
  // Per-integration settings live under `settings` jsonb. Legacy
  // updates targeted top-level (`autoflow.apiKey`); we route those
  // into `settings.autoflow.apiKey`.
  autoflow: "settings",
  tekmetric: "settings",
  protractor: "settings",
  shopware: "settings",
  autovitals: "settings",
  branding: "settings",
  inspection: "settings",
  preferences: "settings",
  carfax: "settings",
};

/** Maps a jsonb container bucket to its physical column name. */
const BUCKET_TO_COLUMN: Record<string, string> = {
  billing: "billing",
  settings: "settings",
  sticker: "sticker",
  metadata: "metadata",
  enabledFeatures: "enabled_features",
};

export async function updateShopFields(
  shopId: number | string,
  set: Record<string, unknown>,
): Promise<{ matchedCount: number; modifiedCount: number }> {
  const db = getDb();
  const id = Number(shopId);
  if (!Number.isFinite(id)) return { matchedCount: 0, modifiedCount: 0 };

  // Group writes by destination container.
  const colWrites: Record<string, unknown> = { updatedAt: new Date() };
  const jsonbWrites: Record<string, Array<{ path: string[]; value: unknown }>> = {};

  for (const [k, v] of Object.entries(set)) {
    if (k === "updatedAt") continue;
    if (SHOP_TOP_LEVEL.has(k)) {
      colWrites[k] = v;
      // Mirror to indexed promoted columns when applicable.
      continue;
    }
    if (k === "billing.plan") {
      colWrites.billingPlan = v;
      (jsonbWrites.billing ||= []).push({ path: ["plan"], value: v });
      continue;
    }
    if (k === "billing.status") {
      colWrites.billingStatus = v;
      (jsonbWrites.billing ||= []).push({ path: ["status"], value: v });
      continue;
    }
    if (k === "billing.stripeCustomerId" || k === "stripeCustomerId") {
      colWrites.stripeCustomerId = v;
      (jsonbWrites.billing ||= []).push({ path: ["stripeCustomerId"], value: v });
      continue;
    }
    // Dot-path: route to its container.
    const dot = k.indexOf(".");
    if (dot > 0) {
      const top = k.slice(0, dot);
      const rest = k.slice(dot + 1);
      const bucket = SHOP_JSONB_CONTAINERS[top] ?? "settings";
      (jsonbWrites[bucket] ||= []).push({
        path: bucket === top ? rest.split(".") : [top, ...rest.split(".")],
        value: v,
      });
      continue;
    }
    // Bare top-level non-promoted key: store as a whole-jsonb replace.
    if (k in SHOP_JSONB_CONTAINERS) {
      const bucket = SHOP_JSONB_CONTAINERS[k];
      (jsonbWrites[bucket] ||= []).push({
        path: bucket === k ? [] : [k],
        value: v,
      });
      continue;
    }
    // Fallback: dump into `settings.<key>`.
    (jsonbWrites.settings ||= []).push({ path: [k], value: v });
  }

  // Build the SQL `SET` list. We do plain column writes first, then
  // sequential `jsonb_set` chains for each touched container.
  await db.transaction(async (tx) => {
    if (Object.keys(colWrites).length > 0) {
      await tx
        .update(shops)
        .set(colWrites as Partial<typeof shops.$inferInsert>)
        .where(eq(shops.mosShopId, id));
    }
    for (const [bucket, writes] of Object.entries(jsonbWrites)) {
      // Build chained jsonb_set on the existing column.
      const columnName = BUCKET_TO_COLUMN[bucket] ?? "settings";
      let expr = sql`COALESCE(${sql.identifier(columnName)}, '{}'::jsonb)`;
      for (const w of writes) {
        if (w.path.length === 0) {
          // whole-container replace
          expr = sql`${JSON.stringify(w.value)}::jsonb`;
        } else {
          const pathLit = `{${w.path.map((p) => p.replace(/"/g, '\\"')).join(",")}}`;
          expr = sql`jsonb_set(${expr}, ${pathLit}::text[], ${JSON.stringify(w.value)}::jsonb, true)`;
        }
      }
      const colName = sql.identifier(columnName);
      await tx.execute(
        sql`UPDATE shops SET ${colName} = ${expr}, updated_at = now() WHERE mos_shop_id = ${id}`,
      );
    }
  });

  // Drizzle doesn't surface matched/modified separately for postgres-js
  // updates here, so we approximate from existence.
  const exists = await db.select({ id: shops.mosShopId }).from(shops).where(eq(shops.mosShopId, id)).limit(1);
  return { matchedCount: exists.length, modifiedCount: exists.length };
}

/**
 * Mirror a Mongo `shops.insertOne(doc)` into PG. Known columns are
 * promoted; the `billing.plan` / `billing.status` / stripe-customer-id
 * indexed columns are derived from the `billing` subdoc; everything
 * else lands in the `settings` catch-all (which `shopRowToDoc` spreads
 * back to top-level on read, so legacy flat reads keep working).
 * `onConflictDoNothing` keeps the insert idempotent across retries.
 */
export async function insertShop(doc: Record<string, unknown>): Promise<void> {
  const db = getDb();
  const now = new Date();
  const {
    shopId,
    _id,
    id: legacyId,
    name,
    locationIdentifier,
    enterpriseId,
    enabledFeatures,
    billing,
    stripeCustomerId,
    settings,
    sticker,
    metadata,
    createdAt,
    updatedAt,
    ...rest
  } = doc as Record<string, any>;
  const id = Number(shopId);
  if (!Number.isFinite(id)) return;
  const mergedSettings = { ...((settings as Json) ?? {}), ...rest };
  await db
    .insert(shops)
    .values({
      mosShopId: id,
      legacyId: typeof legacyId === "number" ? legacyId : null,
      name: name ?? null,
      locationIdentifier: locationIdentifier ?? null,
      enterpriseId: enterpriseId != null ? String(enterpriseId) : null,
      enabledFeatures: (enabledFeatures ?? null) as unknown as Json,
      billing: (billing ?? null) as unknown as Json,
      billingPlan: (billing?.plan as string | undefined) ?? null,
      billingStatus: (billing?.status as string | undefined) ?? null,
      stripeCustomerId:
        (stripeCustomerId as string | undefined) ??
        (billing?.stripeCustomerId as string | undefined) ??
        null,
      settings: (Object.keys(mergedSettings).length ? mergedSettings : null) as unknown as Json,
      sticker: (sticker ?? null) as unknown as Json,
      metadata: (metadata ?? null) as unknown as Json,
      createdAt: (createdAt as Date | undefined) ?? now,
      updatedAt: (updatedAt as Date | undefined) ?? now,
    })
    .onConflictDoNothing({ target: shops.mosShopId });
}

/* -------------------------------------------------------------------------- */
/* users                                                                      */
/* -------------------------------------------------------------------------- */

function userRowToDoc(r: typeof users.$inferSelect | null): MongoShapedUser | null {
  if (!r) return null;
  return {
    _id: r.id, // string-typed; callers that String()ed it still work
    id: r.id,
    email: r.email,
    emailLower: r.emailLower,
    passwordHash: r.passwordHash ?? undefined,
    role: r.role,
    shopId: r.shopId ?? undefined,
    shopIds: (r.shopIds as unknown[]) ?? [],
    isPlatformAdmin: r.isPlatformAdmin,
    mustChangePassword: r.mustChangePassword,
    extensionToken: r.extensionToken ?? undefined,
    extensionTokenCreatedAt: r.extensionTokenCreatedAt ?? undefined,
    profile: (r.profile as Json) ?? undefined,
    auditMeta: (r.auditMeta as Json) ?? undefined,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    ...((r.profile as Json) ?? {}),
  };
}

export async function findUserById(id: string) {
  const db = getDb();
  const rows = await db.select().from(users).where(eq(users.id, String(id))).limit(1);
  return userRowToDoc(rows[0] ?? null);
}

export async function findUserByEmailLower(emailLower: string) {
  const db = getDb();
  const rows = await db
    .select()
    .from(users)
    .where(eq(users.emailLower, emailLower.toLowerCase()))
    .limit(1);
  return userRowToDoc(rows[0] ?? null);
}

export async function findUserByExtensionToken(token: string) {
  const db = getDb();
  const rows = await db
    .select()
    .from(users)
    .where(eq(users.extensionToken, token))
    .limit(1);
  return userRowToDoc(rows[0] ?? null);
}

export async function listUsers(predicate: {
  isPlatformAdmin?: boolean;
  shopId?: number;
}): Promise<Array<ReturnType<typeof userRowToDoc>>> {
  const db = getDb();
  const conditions = [] as ReturnType<typeof eq>[];
  if (predicate.isPlatformAdmin !== undefined) {
    conditions.push(eq(users.isPlatformAdmin, predicate.isPlatformAdmin));
  }
  if (predicate.shopId !== undefined) {
    conditions.push(eq(users.shopId, predicate.shopId));
  }
  const rows = conditions.length
    ? await db.select().from(users).where(and(...conditions))
    : await db.select().from(users);
  return rows.map((r) => userRowToDoc(r));
}

export async function updateUserExtensionTokenTimestamp(
  userId: string,
  ts: Date,
): Promise<void> {
  const db = getDb();
  await db
    .update(users)
    .set({ extensionTokenCreatedAt: ts, updatedAt: new Date() })
    .where(eq(users.id, String(userId)));
}

/* -------------------------------------------------------------------------- */
/* sessions                                                                   */
/* -------------------------------------------------------------------------- */

export async function findActiveSessionByToken(
  token: string,
): Promise<MongoShapedSession | null> {
  const db = getDb();
  const rows = await db
    .select()
    .from(sessions)
    .where(and(eq(sessions.token, token), gt(sessions.expiresAt, new Date())))
    .limit(1);
  const r = rows[0];
  if (!r) return null;
  return {
    token: r.token,
    userId: r.userId,
    shopId: r.shopId ?? undefined,
    isImpersonation: r.isImpersonation,
    impersonatedBy: r.impersonatedBy ?? undefined,
    mustChangePassword: r.mustChangePassword,
    expiresAt: r.expiresAt,
    createdAt: r.createdAt,
  };
}

export async function insertSession(s: {
  token: string;
  userId: string;
  shopId?: number | null;
  isImpersonation?: boolean;
  impersonatedBy?: string | null;
  mustChangePassword?: boolean;
  expiresAt: Date;
}): Promise<void> {
  const db = getDb();
  await db.insert(sessions).values({
    token: s.token,
    userId: String(s.userId),
    shopId: s.shopId ?? null,
    isImpersonation: !!s.isImpersonation,
    impersonatedBy: s.impersonatedBy ?? null,
    mustChangePassword: !!s.mustChangePassword,
    expiresAt: s.expiresAt,
  });
}

export async function updateSessionByToken(
  token: string,
  set: Partial<{
    shopId: number;
    expiresAt: Date;
    isImpersonation: boolean;
    impersonatedBy: string | null;
    mustChangePassword: boolean;
  }>,
): Promise<void> {
  const db = getDb();
  await db.update(sessions).set(set).where(eq(sessions.token, token));
}

export async function deleteSessionByToken(token: string): Promise<void> {
  const db = getDb();
  await db.delete(sessions).where(eq(sessions.token, token));
}

export async function deleteSessionsByUserId(userId: string): Promise<void> {
  const db = getDb();
  await db.delete(sessions).where(eq(sessions.userId, String(userId)));
}

/**
 * Used by `change-password` to revoke every other session belonging
 * to the user (any session that isn't the one calling change-password).
 */
export async function deleteSessionsByUserIdExceptToken(
  userId: string,
  exceptToken: string,
): Promise<void> {
  const db = getDb();
  await db
    .delete(sessions)
    .where(
      and(
        eq(sessions.userId, String(userId)),
        ne(sessions.token, exceptToken),
      ),
    );
}

export async function deleteSessionsByShopId(shopId: number): Promise<void> {
  const db = getDb();
  await db.delete(sessions).where(eq(sessions.shopId, shopId));
}

/**
 * Clear the `mustChangePassword` gate on a single session (the one the
 * user just changed their password from) so subsequent middleware
 * checks let them through.
 */
export async function clearMustChangePasswordByToken(token: string): Promise<void> {
  const db = getDb();
  await db
    .update(sessions)
    .set({ mustChangePassword: false })
    .where(eq(sessions.token, token));
}

/**
 * Clear the `mustChangePassword` gate on every session for a given
 * user (used by `setup-shop` once the user finishes the first-time
 * password setup).
 */
/**
 * Clears the per-user `must_change_password` gate in PG. Used by the
 * change-password and setup-shop routes so the user isn't bounced back
 * into the change-password flow on their next request when PG is
 * canonical.
 */
export async function clearUserMustChangePassword(userId: string): Promise<void> {
  const db = getDb();
  await db
    .update(users)
    .set({ mustChangePassword: false, updatedAt: new Date() })
    .where(eq(users.id, String(userId)));
}

/**
 * Mirrors a user-password update into PG. The `mustChangePassword` flag
 * matters for `getSession()` gating; loose audit fields
 * (passwordChangedAt, passwordResetByAdminAt, passwordResetByAdminEmail)
 * are stashed into the `audit_meta` jsonb so we don't have to widen the
 * users table for every audit field Mongo carried.
 */
export async function updateUserPassword(
  userId: string,
  fields: {
    passwordHash: string;
    mustChangePassword?: boolean;
    passwordChangedAt?: Date | null;
    passwordResetByAdminAt?: Date | null;
    passwordResetByAdminEmail?: string | null;
  },
): Promise<void> {
  const db = getDb();
  const auditPatch: Record<string, unknown> = {};
  if (fields.passwordChangedAt !== undefined) {
    auditPatch.passwordChangedAt = fields.passwordChangedAt;
  }
  if (fields.passwordResetByAdminAt !== undefined) {
    auditPatch.passwordResetByAdminAt = fields.passwordResetByAdminAt;
  }
  if (fields.passwordResetByAdminEmail !== undefined) {
    auditPatch.passwordResetByAdminEmail = fields.passwordResetByAdminEmail;
  }
  const set: Record<string, unknown> = {
    passwordHash: fields.passwordHash,
    updatedAt: new Date(),
  };
  if (fields.mustChangePassword !== undefined) {
    set.mustChangePassword = fields.mustChangePassword;
  }
  if (Object.keys(auditPatch).length > 0) {
    set.auditMeta = sql`COALESCE(${users.auditMeta}, '{}'::jsonb) || ${JSON.stringify(auditPatch)}::jsonb`;
  }
  await db
    .update(users)
    .set(set)
    .where(eq(users.id, String(userId)));
}

export async function clearMustChangePasswordByUserId(userId: string): Promise<void> {
  const db = getDb();
  await db
    .update(sessions)
    .set({ mustChangePassword: false })
    .where(eq(sessions.userId, String(userId)));
}

/* -------------------------------------------------------------------------- */
/* user create — dual-write for the signup-completion routes                  */
/* (`auth/setup-complete`, `auth/complete-setup`). Existing users created    */
/* before the cutover land via the periodic backfill; this helper covers     */
/* freshly-issued users so the very next `getSession()` PG read can find    */
/* them.                                                                      */
/* -------------------------------------------------------------------------- */

export async function insertUser(u: {
  id: string;
  email: string;
  emailLower?: string;
  passwordHash?: string;
  role?: string;
  shopId?: number | null;
  shopIds?: unknown[];
  isPlatformAdmin?: boolean;
  mustChangePassword?: boolean;
  extensionToken?: string | null;
  profile?: Json | null;
  auditMeta?: Json | null;
  createdAt?: Date;
  updatedAt?: Date;
}): Promise<void> {
  const db = getDb();
  const now = new Date();
  await db
    .insert(users)
    .values({
      id: String(u.id),
      email: u.email,
      emailLower: (u.emailLower || u.email).toLowerCase(),
      passwordHash: u.passwordHash ?? null,
      role: u.role ?? "owner",
      shopId: u.shopId ?? null,
      shopIds: (u.shopIds ?? []) as unknown as Json,
      isPlatformAdmin: !!u.isPlatformAdmin,
      mustChangePassword: !!u.mustChangePassword,
      extensionToken: u.extensionToken ?? null,
      profile: (u.profile ?? null) as unknown as Json,
      auditMeta: (u.auditMeta ?? null) as unknown as Json,
      createdAt: u.createdAt ?? now,
      updatedAt: u.updatedAt ?? now,
    })
    .onConflictDoNothing({ target: users.id });
}

const USER_TOP_LEVEL = new Set([
  "email",
  "emailLower",
  "passwordHash",
  "role",
  "shopId",
  "shopIds",
  "isPlatformAdmin",
  "mustChangePassword",
  "extensionToken",
  // Whole-column jsonb replace (used by e.g. the enrollment approval
  // route to rewrite the profile blob after clearing pending status).
  "profile",
]);

/**
 * Mirror a Mongo `users.updateOne({_id}, {$set})` into PG. Known
 * columns are promoted to their column (and `email` keeps `emailLower`
 * in sync); every other loose key (audit fields like `updatedBy`)
 * lands in the `audit_meta` jsonb so the table doesn't have to widen
 * for each audit field Mongo carried. `userId` is the Mongo `_id`
 * stringified — the PG `users.id` is that hex string.
 */
export async function updateUserFields(
  userId: string,
  set: Record<string, unknown>,
): Promise<void> {
  const db = getDb();
  const colWrites: Record<string, unknown> = { updatedAt: new Date() };
  const auditWrites: Array<{ path: string[]; value: unknown }> = [];
  for (const [k, v] of Object.entries(set)) {
    if (k === "updatedAt") {
      colWrites.updatedAt = v;
      continue;
    }
    if (USER_TOP_LEVEL.has(k)) {
      colWrites[k] = v;
      if (k === "email" && typeof v === "string") {
        colWrites.emailLower = v.toLowerCase();
      }
      continue;
    }
    const dot = k.indexOf(".");
    auditWrites.push({
      path: dot > 0 ? k.split(".") : [k],
      value: v,
    });
  }
  await db.transaction(async (tx) => {
    await tx
      .update(users)
      .set(colWrites as Partial<typeof users.$inferInsert>)
      .where(eq(users.id, String(userId)));
    if (auditWrites.length > 0) {
      let expr = sql`COALESCE(audit_meta, '{}'::jsonb)`;
      for (const w of auditWrites) {
        const pathLit = `{${w.path.map((p) => p.replace(/"/g, '\\"')).join(",")}}`;
        expr = sql`jsonb_set(${expr}, ${pathLit}::text[], ${JSON.stringify(w.value)}::jsonb, true)`;
      }
      await tx.execute(
        sql`UPDATE users SET audit_meta = ${expr}, updated_at = now() WHERE id = ${String(userId)}`,
      );
    }
  });
}

/** Mirror a Mongo `users.deleteOne({_id})` into PG (cascades sessions). */
export async function deleteUserById(userId: string): Promise<void> {
  const db = getDb();
  await db.delete(users).where(eq(users.id, String(userId)));
}

/* -------------------------------------------------------------------------- */
/* enterprise_accounts                                                        */
/* -------------------------------------------------------------------------- */

function enterpriseRowToDoc(
  r: typeof enterpriseAccounts.$inferSelect | null,
): MongoShapedEnterprise | null {
  if (!r) return null;
  return {
    _id: r.id,
    id: r.id,
    name: r.name,
    shopIds: (r.shopIds as unknown[]) ?? [],
    sharedMappings: (r.sharedMappings as Json) ?? undefined,
    sharedIntegrations: (r.sharedIntegrations as Json) ?? undefined,
    featureSettings: (r.featureSettings as Json) ?? undefined,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

export async function findEnterpriseById(id: string) {
  const db = getDb();
  const rows = await db
    .select()
    .from(enterpriseAccounts)
    .where(eq(enterpriseAccounts.id, String(id)))
    .limit(1);
  return enterpriseRowToDoc(rows[0] ?? null);
}

export async function findEnterpriseByShopId(shopId: number) {
  const db = getDb();
  // shopIds is a jsonb array of mixed string/number ids — match either.
  const rows = await db.execute(
    sql`SELECT * FROM enterprise_accounts WHERE shop_ids @> ${JSON.stringify([Number(shopId)])}::jsonb OR shop_ids @> ${JSON.stringify([String(shopId)])}::jsonb LIMIT 1`,
  );
  const r = (rows as unknown as Array<typeof enterpriseAccounts.$inferSelect>)[0];
  return enterpriseRowToDoc(r ?? null);
}

export async function updateEnterpriseFeatureSettings(
  enterpriseId: string,
  featureSettings: Json,
): Promise<void> {
  const db = getDb();
  await db
    .update(enterpriseAccounts)
    .set({ featureSettings, updatedAt: new Date() })
    .where(eq(enterpriseAccounts.id, String(enterpriseId)));
}

/* -------------------------------------------------------------------------- */
/* shop_features                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Returns the per-shop feature state in the same Mongo-shaped doc the
 * existing callers expect (`enabledFeatures: string[]`,
 * `featureSettings: { [key]: ... }`, `subscriptions: [...]`). Internally
 * this is reconstructed from the per-(shop_id, feature_key) rows.
 */
export async function findShopFeaturesByShopId(shopId: number) {
  const db = getDb();
  const rows = await db
    .select()
    .from(shopFeatures)
    .where(eq(shopFeatures.shopId, shopId));
  if (rows.length === 0) return null;
  const enabledFeatures: string[] = [];
  const featureSettings: Record<string, Json> = {};
  const subscriptions: unknown[] = [];
  let createdAt = rows[0].createdAt;
  let updatedAt = rows[0].updatedAt;
  for (const r of rows) {
    if (r.enabled) enabledFeatures.push(r.featureKey);
    if (r.settings != null) featureSettings[r.featureKey] = r.settings as Json;
    if (r.subscription != null) subscriptions.push(r.subscription);
    if (r.createdAt < createdAt) createdAt = r.createdAt;
    if (r.updatedAt > updatedAt) updatedAt = r.updatedAt;
  }
  return {
    shopId,
    enabledFeatures,
    featureSettings,
    subscriptions,
    createdAt,
    updatedAt,
  };
}

/**
 * Replace the full enabled-feature set for a shop. Any features
 * previously enabled but not in `featureIds` are flipped to `enabled=false`
 * (we keep the row to preserve settings/subscription history).
 */
export async function setShopFeaturesEnabled(
  shopId: number,
  featureIds: string[],
): Promise<void> {
  const db = getDb();
  const now = new Date();
  // postgres-js rejects JS Date instances when bound as parameters in raw
  // SQL — see the comment in lib/data/repositories/api-keys.ts
  // (countApiUsageInWindow). Serialize to an ISO timestamp string for the
  // raw UPDATE; the typed insert below uses drizzle's column metadata which
  // already handles Date correctly.
  await db.execute(sql`
    UPDATE shop_features
    SET enabled = false, updated_at = ${now.toISOString()}
    WHERE shop_id = ${shopId} AND feature_key <> ALL(${featureIds}::text[])
  `);
  for (const fk of featureIds) {
    await db
      .insert(shopFeatures)
      .values({ shopId, featureKey: fk, enabled: true })
      .onConflictDoUpdate({
        target: [shopFeatures.shopId, shopFeatures.featureKey],
        set: { enabled: true, updatedAt: now },
      });
  }
}

export async function addShopFeatureEnabled(shopId: number, featureId: string): Promise<void> {
  const db = getDb();
  await db
    .insert(shopFeatures)
    .values({ shopId, featureKey: featureId, enabled: true })
    .onConflictDoUpdate({
      target: [shopFeatures.shopId, shopFeatures.featureKey],
      set: { enabled: true, updatedAt: new Date() },
    });
}

export async function removeShopFeatureEnabled(shopId: number, featureId: string): Promise<void> {
  const db = getDb();
  await db
    .update(shopFeatures)
    .set({ enabled: false, updatedAt: new Date() })
    .where(
      and(
        eq(shopFeatures.shopId, shopId),
        eq(shopFeatures.featureKey, featureId),
      ),
    );
}

export async function setShopFeatureSettings(
  shopId: number,
  featureId: string,
  settings: Json,
): Promise<void> {
  const db = getDb();
  await db
    .insert(shopFeatures)
    .values({ shopId, featureKey: featureId, settings })
    .onConflictDoUpdate({
      target: [shopFeatures.shopId, shopFeatures.featureKey],
      set: { settings, updatedAt: new Date() },
    });
}

/* -------------------------------------------------------------------------- */
/* platform_admins / platform_settings / platform_plans                       */
/* -------------------------------------------------------------------------- */

export async function listPlatformAdminEmails(): Promise<string[]> {
  // Platform admin status today lives on the `users.is_platform_admin`
  // boolean. The `platform_admins` table is reserved for the dedicated
  // /admin-login surface; super-admin email enumeration uses `users`.
  const db = getDb();
  const rows = await db
    .select({ email: users.emailLower })
    .from(users)
    .where(eq(users.isPlatformAdmin, true));
  return rows.map((r) => r.email).filter(Boolean);
}

export async function getPlatformSetting(type: string): Promise<Json | null> {
  const db = getDb();
  const rows = await db
    .select()
    .from(platformSettings)
    .where(eq(platformSettings.type, type))
    .limit(1);
  return (rows[0]?.payload as Json) ?? null;
}

export async function upsertPlatformSetting(type: string, payload: Json): Promise<void> {
  const db = getDb();
  await db
    .insert(platformSettings)
    .values({ type, payload })
    .onConflictDoUpdate({
      target: platformSettings.type,
      set: { payload, updatedAt: new Date() },
    });
}

export async function listPlatformPlans() {
  const db = getDb();
  return db.select().from(platformPlans).where(eq(platformPlans.active, true));
}

/**
 * Mirror a Mongo `platform_plans.updateOne({slug}, {$set}, {upsert})`
 * into PG. The Mongo plan doc carries display fields (`monthlyPrice`,
 * `order`, `status`, `features`, ...); the full doc is preserved in the
 * `payload` jsonb while the hot columns (`name`, `description`,
 * `pricePerMonth`, `sortOrder`, `active`) are promoted. Keyed on the
 * `slug` primary key.
 */
export async function upsertPlatformPlan(plan: {
  slug: string;
  name: string;
  description?: string | null;
  monthlyPrice?: number | null;
  order?: number | null;
  status?: string | null;
  [k: string]: unknown;
}): Promise<void> {
  const db = getDb();
  const now = new Date();
  const promoted = {
    name: plan.name,
    description: plan.description ?? null,
    pricePerMonth: typeof plan.monthlyPrice === "number" ? plan.monthlyPrice : null,
    payload: plan as unknown as Json,
    active: plan.status != null ? plan.status === "active" : true,
    sortOrder: typeof plan.order === "number" ? plan.order : 0,
    updatedAt: now,
  };
  await db
    .insert(platformPlans)
    .values({ slug: plan.slug, ...promoted })
    .onConflictDoUpdate({ target: platformPlans.slug, set: promoted });
}

/* -------------------------------------------------------------------------- */
/* Token tables                                                               */
/* -------------------------------------------------------------------------- */

export async function findPendingSignupByToken(token: string) {
  const db = getDb();
  const rows = await db
    .select()
    .from(pendingSignups)
    .where(and(eq(pendingSignups.token, token), gt(pendingSignups.expiresAt, new Date())))
    .limit(1);
  return rows[0] ?? null;
}

export async function findSetupTokenByToken(token: string) {
  const db = getDb();
  const rows = await db
    .select()
    .from(setupTokens)
    .where(and(eq(setupTokens.token, token), gt(setupTokens.expiresAt, new Date())))
    .limit(1);
  return rows[0] ?? null;
}

export async function findPasswordResetTokenByToken(token: string) {
  const db = getDb();
  const rows = await db
    .select()
    .from(passwordResetTokens)
    .where(and(eq(passwordResetTokens.token, token), gt(passwordResetTokens.expiresAt, new Date())))
    .limit(1);
  return rows[0] ?? null;
}

/* -------------------------------------------------------------------------- */
/* Billing                                                                    */
/* -------------------------------------------------------------------------- */

export async function getBillingSettingsForShop(shopId: number): Promise<Json | null> {
  const db = getDb();
  const rows = await db
    .select()
    .from(billingSettings)
    .where(eq(billingSettings.shopId, shopId))
    .limit(1);
  return (rows[0]?.payload as Json) ?? null;
}

export async function upsertBillingSettingsForShop(shopId: number, payload: Json): Promise<void> {
  const db = getDb();
  await db
    .insert(billingSettings)
    .values({ shopId, payload })
    .onConflictDoUpdate({
      target: billingSettings.shopId,
      set: { payload, updatedAt: new Date() },
    });
}

export async function insertBillingStatusLog(entry: {
  shopId?: number;
  fromStatus?: string;
  toStatus?: string;
  reason?: string;
  actor?: string;
  payload?: Json;
}): Promise<void> {
  const db = getDb();
  await db.insert(billingStatusLog).values({
    shopId: entry.shopId,
    fromStatus: entry.fromStatus,
    toStatus: entry.toStatus,
    reason: entry.reason,
    actor: entry.actor,
    payload: entry.payload,
  });
}

/* -------------------------------------------------------------------------- */
/* Stripe webhook idempotency                                                 */
/* -------------------------------------------------------------------------- */

export async function findStripeEventById(id: string) {
  const db = getDb();
  const rows = await db.select().from(stripeEvents).where(eq(stripeEvents.id, id)).limit(1);
  return rows[0] ?? null;
}

export async function recordStripeEvent(event: {
  id: string;
  type?: string;
  livemode?: boolean;
  apiVersion?: string;
  payload?: Json;
}): Promise<{ inserted: boolean }> {
  const db = getDb();
  const r = await db
    .insert(stripeEvents)
    .values({
      id: event.id,
      type: event.type,
      livemode: event.livemode,
      apiVersion: event.apiVersion,
      payload: event.payload,
    })
    .onConflictDoNothing({ target: stripeEvents.id })
    .returning({ id: stripeEvents.id });
  return { inserted: r.length > 0 };
}

export async function markStripeEventProcessed(id: string): Promise<void> {
  const db = getDb();
  await db
    .update(stripeEvents)
    .set({ processedAt: new Date() })
    .where(eq(stripeEvents.id, id));
}

export async function recordStripeWebhookEvent(event: {
  id: string;
  type?: string;
  payload?: Json;
}): Promise<{ inserted: boolean }> {
  const db = getDb();
  const r = await db
    .insert(stripeWebhookEvents)
    .values({ id: event.id, type: event.type, payload: event.payload })
    .onConflictDoNothing({ target: stripeWebhookEvents.id })
    .returning({ id: stripeWebhookEvents.id });
  return { inserted: r.length > 0 };
}
