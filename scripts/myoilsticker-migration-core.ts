/**
 * Core loop for the MyOilSticker → mos.tools migration (task #1181), with
 * ALL side effects injected so the reconcile/resume semantics can be
 * regression-tested (see tests/myoilsticker-migration-resume.smoke.ts).
 *
 * Guarantees:
 *   • Idempotent: created/linked records are tagged `legacyOilStickerId`.
 *   • Resume reconciles EACH target store independently. A legacy user whose
 *     Mongo docs exist but whose PG mirror write failed (e.g. crash between
 *     the Mongo insert and pgInsertUser) is NOT skipped — on rerun the PG
 *     shop/user rows (or collision-link metadata) are replayed. PG inserts
 *     are ON CONFLICT DO NOTHING and the collision update is a plain SET, so
 *     replaying against a healthy PG is a no-op.
 */

import {
  SOURCE_TAG,
  looksLikeBcrypt,
  s,
  buildShopDoc,
  buildLegacyMeta,
  buildCustomGroup,
  type LegacyUser,
} from "./myoilsticker-migration-mapping";

export interface MigrationDeps {
  /** Mongo `test` db handle (legacy platform). */
  legacyDb: any;
  /** Mongo mos-maintenance-mvp db handle. */
  mosDb: any;
  getNextShopId(): Promise<number>;
  /** dualWritePgIdentity-compatible wrapper (no-op when PG mode is off). */
  dualWrite(label: string, fn: () => Promise<unknown>): Promise<void>;
  pgInsertShop(doc: Record<string, any>): Promise<void>;
  pgInsertUser(u: Record<string, any>): Promise<void>;
  pgUpdateUserFields(id: string, set: Record<string, unknown>): Promise<void>;
  /** Returns a bcrypt hash of a random unguessable secret. */
  hashRandomPassword(): Promise<string>;
  /** Returns a new Mongo ObjectId (injected so tests can use strings). */
  newUserId(): any;
  log?: (msg: string) => void;
}

export interface MigrationOptions {
  write: boolean;
  limit?: number;
  collisionMode?: "link" | "skip";
  now?: Date;
}

function pgUserFromDoc(userDoc: Record<string, any>) {
  return {
    id: String(userDoc._id),
    email: String(userDoc.email),
    emailLower: String(userDoc.emailLower ?? userDoc.email).toLowerCase(),
    passwordHash: userDoc.passwordHash,
    role: userDoc.role ?? "owner",
    shopId: userDoc.shopId,
    shopIds: userDoc.shopIds ?? [],
    mustChangePassword: !!userDoc.mustChangePassword,
  };
}

export async function runMigration(deps: MigrationDeps, opts: MigrationOptions) {
  const write = opts.write;
  const limit = opts.limit ?? Infinity;
  const collisionMode = opts.collisionMode ?? "link";
  const now = opts.now ?? new Date();
  const log = deps.log ?? (() => {});
  const legacy = deps.legacyDb;
  const mos = deps.mosDb;

  const legacyUsers: LegacyUser[] = await legacy
    .collection("users")
    .find({})
    .sort({ _id: 1 })
    .toArray();
  const customGroups = await legacy.collection("customgroups").find({}).toArray();
  const groupsByUser = new Map<string, any[]>();
  for (const g of customGroups) {
    const k = String(g.user_id);
    (groupsByUser.get(k) ?? groupsByUser.set(k, []).get(k)!).push(g);
  }
  const oildataCount = await legacy.collection("oildatas").estimatedDocumentCount();
  const legacyIdSet = new Set(legacyUsers.map((u) => String(u._id)));
  const orphanGroups = customGroups.filter((g: any) => !legacyIdSet.has(String(g.user_id)));

  // Existing mos users: by legacy tag (resume) and by email (collisions).
  const mosUsers = await mos
    .collection("users")
    .find(
      {},
      {
        projection: {
          _id: 1,
          email: 1,
          emailLower: 1,
          shopId: 1,
          role: 1,
          legacyOilStickerId: 1,
          legacyMigrationCreated: 1,
        },
      },
    )
    .toArray();
  const migratedByLegacyId = new Map<string, any>();
  for (const m of mosUsers) {
    if (m.legacyOilStickerId) migratedByLegacyId.set(String(m.legacyOilStickerId), m);
  }
  const mosByEmail = new Map<string, any>();
  for (const m of mosUsers) {
    const e = String(m.emailLower ?? m.email ?? "").toLowerCase().trim();
    if (e && !mosByEmail.has(e)) mosByEmail.set(e, m);
  }

  const report = {
    mode: write ? "apply" : "dry-run",
    startedAt: new Date().toISOString(),
    totals: { legacyUsers: legacyUsers.length, mosUsersExisting: mosUsers.length },
    creates: [] as any[],
    collisions: [] as any[],
    skippedAlreadyMigrated: [] as string[],
    pgReconciled: [] as string[],
    frozenDisabled: [] as string[],
    unverifiedImported: 0,
    badHash: [] as string[],
    customGroupsMigrated: 0,
    customGroupsOrphaned: orphanGroups.map((g: any) => ({
      name: s(g.name),
      legacyGroupId: String(g._id),
      userId: String(g.user_id),
      note: "references a deleted legacy user — not migrated",
    })),
    oildatas: {
      count: oildataCount,
      note: "NOT migrated (out of scope). Linkage key: test.oildatas.user_id → test.users._id; after migration, join via mos users.legacyOilStickerId.",
    },
    notMigratedFields: [
      "targetPwd (scraped SMS password — sensitive, dropped)",
      "targetUser (scraped SMS login username — sensitive, dropped)",
      "cookieInfo / cookieExpire (scraped session cookies — dropped)",
      "tokenInfo / tokenExpire (scraped tokens — dropped)",
      "apiKey (legacy platform API key — not valid on mos.tools, dropped)",
      "__v (mongoose internal)",
    ],
  };

  let processed = 0;

  for (const u of legacyUsers) {
    if (processed >= limit) break;
    processed++;
    const legacyId = String(u._id);
    const email = String(u.email ?? "").toLowerCase().trim();

    // ---------------- resume path: Mongo done, reconcile PG ----------------
    const tagged = migratedByLegacyId.get(legacyId);
    if (tagged) {
      report.skippedAlreadyMigrated.push(email);
      if (write) {
        // Mongo is complete for this record, but a previous run may have
        // died before (or during) the PG mirror writes. Replay them —
        // idempotent against a healthy PG — so a partial run can never
        // strand a customer without a PG identity row.
        if (tagged.legacyMigrationCreated) {
          const fullUser = await mos.collection("users").findOne({ _id: tagged._id });
          const shopDoc = await mos
            .collection("shops")
            .findOne({ legacyOilStickerId: legacyId });
          if (shopDoc) {
            await deps.dualWrite("shops.insert(migrate-mos-reconcile)", () =>
              deps.pgInsertShop(shopDoc),
            );
          }
          if (fullUser) {
            await deps.dualWrite("users.insert(migrate-mos-reconcile)", () =>
              deps.pgInsertUser(pgUserFromDoc(fullUser)),
            );
          }
        } else {
          // Collision-linked user: replay the PG tag update.
          await deps.dualWrite("users.update(migrate-mos-link-reconcile)", () =>
            deps.pgUpdateUserFields(String(tagged._id), {
              legacyOilStickerId: legacyId,
              legacySource: SOURCE_TAG,
            }),
          );
        }
        report.pgReconciled.push(email);
      }
      continue;
    }

    // ---------------- collision: email already exists on mos ---------------
    const existing = email ? mosByEmail.get(email) : null;
    if (existing) {
      const linkGroups = groupsByUser.get(legacyId) ?? [];
      report.collisions.push({
        email,
        legacyId,
        mosUserId: String(existing._id),
        mosShopId: existing.shopId ?? null,
        decision: collisionMode === "link" ? "link (tag only, no changes)" : "skip",
        customGroups: linkGroups.length,
      });
      if (collisionMode === "link") report.customGroupsMigrated += linkGroups.length;
      if (write && collisionMode === "link") {
        const meta: Record<string, unknown> = buildLegacyMeta(u);
        if (linkGroups.length) {
          // Custom make-groups ride along as metadata on the linked user
          // (their existing shop is not modified by the migration).
          meta.legacyCustomGroups = linkGroups.map(buildCustomGroup);
        }
        await mos.collection("users").updateOne(
          { _id: existing._id },
          {
            $set: {
              legacyOilStickerId: legacyId,
              legacySource: SOURCE_TAG,
              legacyMyOilSticker: meta,
              updatedAt: now,
            },
          },
        );
        // If this PG write fails, the Mongo tag above makes the rerun take
        // the resume path, which replays exactly this update.
        await deps.dualWrite("users.update(migrate-mos-link)", () =>
          deps.pgUpdateUserFields(String(existing._id), {
            legacyOilStickerId: legacyId,
            legacySource: SOURCE_TAG,
          }),
        );
      }
      continue;
    }

    // ---------------- fresh create: shop + owner user ----------------------
    const frozen = u.isFrozen === true;
    const hashOk = looksLikeBcrypt(u.password);
    if (!hashOk) report.badHash.push(email);
    if (!u.isEmailVerified) report.unverifiedImported++;

    const shopDoc = buildShopDoc(u, now);
    const groups = groupsByUser.get(legacyId) ?? [];
    if (groups.length) {
      shopDoc.legacyCustomGroups = groups.map(buildCustomGroup);
      report.customGroupsMigrated += groups.length;
    }

    // Frozen (or hashless) accounts are imported DISABLED: random hash +
    // forced reset. Everyone else keeps their legacy bcrypt hash.
    const disabled = frozen || !hashOk;
    const passwordHash = disabled ? await deps.hashRandomPassword() : String(u.password);
    if (frozen) report.frozenDisabled.push(email);

    report.creates.push({
      email,
      legacyId,
      shopName: shopDoc.name,
      frozen,
      unverified: !u.isEmailVerified,
      disabledLogin: disabled,
      customGroups: groups.length,
    });

    if (!write) continue;

    // Crash-safe resume: if a previous run inserted the shop but died before
    // inserting the user (the resume key), reuse that shop instead of
    // allocating a second one. PG inserts are onConflictDoNothing, so
    // replaying them is safe.
    const leftoverShop = await mos
      .collection("shops")
      .findOne({ legacyOilStickerId: legacyId }, { projection: { shopId: 1 } });
    const shopId = leftoverShop?.shopId ?? (await deps.getNextShopId());
    shopDoc.shopId = shopId;
    if (leftoverShop) {
      log(`  resuming: reusing shop ${shopId} for ${email}`);
    } else {
      await mos.collection("shops").insertOne(shopDoc);
    }
    await deps.dualWrite("shops.insert(migrate-mos)", () => deps.pgInsertShop(shopDoc));

    const userId = deps.newUserId();
    const userDoc: Record<string, any> = {
      _id: userId,
      email,
      emailLower: email,
      name: `${s(u.firstName) ?? ""} ${s(u.lastName) ?? ""}`.trim() || email.split("@")[0],
      phone: s(u.phoneNumber),
      passwordHash,
      role: "owner",
      shopId,
      shopIds: [shopId],
      mustChangePassword: disabled,
      createdAt: u.createdAt instanceof Date ? u.createdAt : now,
      updatedAt: now,
      legacyOilStickerId: legacyId,
      legacySource: SOURCE_TAG,
      legacyMigrationCreated: true, // rollback selector — never set on linked users
      legacyMyOilSticker: buildLegacyMeta(u),
    };
    if (disabled) userDoc.legacyDisabledReason = frozen ? "isFrozen" : "no-usable-hash";
    await mos.collection("users").insertOne(userDoc);
    // If this PG write fails, the Mongo user above is tagged, so the rerun
    // takes the resume path and replays this insert (ON CONFLICT DO NOTHING).
    await deps.dualWrite("users.insert(migrate-mos)", () =>
      deps.pgInsertUser(pgUserFromDoc(userDoc)),
    );
    log(`  created shop ${shopId} + user ${email}`);
  }

  return report;
}

export type MigrationReport = Awaited<ReturnType<typeof runMigration>>;
