import { getDb, getMongoClient } from '@/lib/mongo';
import {
  acquireAutoflowAliasClaim,
  AutoflowAtomicClaimConflictError,
  autoflowIdentifierVariants,
  buildAutoflowClaimQuery,
  classifyAutoflowIdentifierClaims,
  isAutoflowV4ShopNumber,
  normalizeAutoflowIdentifier,
  releaseAutoflowAliasClaim,
  withAutoflowClaimTransaction,
} from '@/lib/autoflow-identity';

export type ResolvedShopLookup = {
  status: 'resolved';
  mosShopId: number;
  shopDoc: any;
  provider: 'tekmetric' | 'protractor' | 'shopware' | 'autoflow' | 'shopmonkey';
};

export type ShopLookupOutcome =
  | ResolvedShopLookup
  | {
      status: 'conflict';
      provider: ResolvedShopLookup["provider"];
      identifier: string;
      conflictType: 'canonical' | 'alias';
      shopIds: Array<string | number>;
    }
  | {
      status: 'access_denied' | 'not_found';
      provider?: 'autoflow';
      identifier?: string;
      ownerShopId?: string | number;
    };

export type ShopLookupResult = ResolvedShopLookup | null;

/**
 * Test seam: tests can override `__deps.getDb` to swap in a fake DB and
 * `__deps.discoverShopmonkeyIds` to stub the Shopmonkey `/location` call.
 * Production callers go through the real getDb()/discoverIdsFromKey() unchanged.
 */
export const __deps: {
  getDb: typeof getDb;
  getMongoClient: typeof getMongoClient;
  discoverShopmonkeyIds: (
    apiKey: string,
  ) => Promise<{ companyId: string | null; locationId: string | null }>;
} = {
  getDb,
  getMongoClient,
  discoverShopmonkeyIds: async (apiKey: string) => {
    const { discoverIdsFromKey } = await import(
      "@/lib/integrations/shopmonkey/auth"
    );
    return discoverIdsFromKey(apiKey);
  },
};

function isShopAccessible(
  shop: any,
  userShopIds: number[],
  isPlatformAdmin: boolean,
) {
  if (isPlatformAdmin) return true;
  if (userShopIds.length === 0) return false;
  return userShopIds.some((id) => String(id) === String(shop?.shopId));
}

function resolvedShop(
  shopDoc: any,
  providerOverride?: ResolvedShopLookup["provider"],
): ResolvedShopLookup {
  const provider = providerOverride || shopDoc.integrationProvider
    || (shopDoc.tekmetric?.shopId ? 'tekmetric'
      : shopDoc.protractor?.connectionId ? 'protractor'
      : shopDoc.shopware?.tenantId ? 'shopware'
      : shopDoc.shopmonkey?.apiKey ? 'shopmonkey'
      : shopDoc.autoflow?.domain
        || shopDoc.autoflow?.subdomain
        || shopDoc.autoflow?.shopId
        || shopDoc.autoflowDomain ? 'autoflow'
      : 'tekmetric') as ResolvedShopLookup['provider'];

  return {
    status: 'resolved',
    mosShopId: Number(shopDoc.shopId),
    shopDoc,
    provider,
  };
}

async function recordUnresolvedAutoflowIdentifier(
  db: any,
  identifier: string,
  details: {
    reason: string;
    candidateShopIds: Array<string | number>;
    candidateCount: number;
  },
) {
  const normalizedIdentifier =
    normalizeAutoflowIdentifier(identifier) || identifier;
  try {
    await db.collection("autoflow_unresolved_numbers").updateOne(
      { number: normalizedIdentifier },
      {
        $set: {
          lastSeenAt: new Date(),
          candidateShopIds: details.candidateShopIds.slice(0, 25),
          candidateCount: details.candidateCount,
          reason: details.reason,
        },
        $setOnInsert: {
          number: normalizedIdentifier,
          firstSeenAt: new Date(),
          resolvedShopId: null,
        },
        $inc: { seenCount: 1 },
      },
      { upsert: true },
    );
  } catch (err: any) {
    console.warn(
      `[Shop Lookup] Failed to record unresolved AutoFlow identifier "${identifier}":`,
      err?.message || err,
    );
  }
}

export async function findShopBySmsIdDetailed(
  smsShopId: string,
  options: {
    userShopIds?: number[];
    isPlatformAdmin?: boolean;
    providerHint?: string;
    providerHintIsAuthoritative?: boolean;
  } = {}
): Promise<ShopLookupOutcome> {
  const db = await __deps.getDb();
  const { userShopIds = [], isPlatformAdmin = false } = options;
  const providerHint = String(options.providerHint || "")
    .trim()
    .toLowerCase()
    .replace(/^shop[-_]ware$/, "shopware") || undefined;
  const authoritativeProvider =
    options.providerHintIsAuthoritative === true
      ? providerHint as ResolvedShopLookup["provider"] | undefined
      : undefined;

  // Server-managed mappings must resolve against exact canonical provider
  // fields only. Keep this path before the extension compatibility resolver so
  // it cannot discover, learn, record, or fall through to any alternate ID.
  if (authoritativeProvider) {
    let clauses: any[] = [];
    if (authoritativeProvider === "autoflow") {
      const variants = autoflowIdentifierVariants(smsShopId);
      clauses = [
        { "autoflow.domain": { $in: variants } },
        { "autoflow.subdomain": { $in: variants } },
        { "autoflow.shopId": { $in: variants } },
        { autoflowDomain: { $in: variants } },
      ];
    } else if (authoritativeProvider === "tekmetric") {
      const raw = String(smsShopId).trim();
      if (/^(0|[1-9]\d*)$/.test(raw)) {
        const numeric = Number(raw);
        const variants: Array<string | number> = [raw];
        if (Number.isSafeInteger(numeric) && String(numeric) === raw) {
          variants.push(numeric);
        }
        clauses = [
          { "tekmetric.shopId": { $in: variants } },
          { tekmetricShopId: { $in: variants } },
        ];
      }
    } else if (authoritativeProvider === "protractor") {
      clauses = [
        { "protractor.connectionId": smsShopId },
        { protractorConnectionId: smsShopId },
      ];
    } else if (authoritativeProvider === "shopware") {
      clauses = [
        { "shopware.tenantSubdomain": smsShopId },
        { "shopware.tenantId": smsShopId },
      ];
    } else if (authoritativeProvider === "shopmonkey") {
      clauses = [
        { "shopmonkey.locationId": smsShopId },
        { "shopmonkey.companyId": smsShopId },
      ];
    }

    const matches = clauses.length === 0
      ? []
      : await db.collection("shops")
          .find(
            { $or: clauses },
            authoritativeProvider === "autoflow"
              ? { collation: { locale: "en", strength: 2 } }
              : undefined,
          )
          .limit(2)
          .toArray();
    if (matches.length > 1) {
      return {
        status: "conflict",
        provider: authoritativeProvider,
        identifier: authoritativeProvider === "autoflow"
          ? normalizeAutoflowIdentifier(smsShopId)
          : String(smsShopId),
        conflictType: "canonical",
        shopIds: matches.map((candidate: any) => candidate.shopId),
      };
    }
    const owner = matches[0];
    if (!owner) {
      return {
        status: "not_found",
        ...(authoritativeProvider === "autoflow"
          ? {
              provider: "autoflow" as const,
              identifier: normalizeAutoflowIdentifier(smsShopId),
            }
          : {}),
      };
    }
    if (!isShopAccessible(owner, userShopIds, isPlatformAdmin)) {
      return {
        status: "access_denied",
        ...(authoritativeProvider === "autoflow"
          ? {
              provider: "autoflow" as const,
              identifier: normalizeAutoflowIdentifier(smsShopId),
              ownerShopId: owner.shopId,
            }
          : {}),
      };
    }
    return resolvedShop(owner, authoritativeProvider);
  }

  const shouldResolveAutoflow =
    providerHint === 'autoflow'
    || !authoritativeProvider;
  
  const tekShopIdNum = parseInt(smsShopId);
  const tekShopIdStr = String(smsShopId);

  // AutoFlow identifiers (a v3 subdomain or a v4 shop NUMBER) must only ever
  // match AutoFlow fields. A v4 slug is frequently numeric, so matching it
  // against the generic `shopId` / `tekmetric.shopId` clauses below could
  // resolve it to a completely unrelated shop (wrong-shop context/data). When
  // the caller tells us this is an AutoFlow page, restrict the query to
  // AutoFlow fields only.
  // AutoFlow canonical identity must be resolved across ALL shops before user
  // access is applied. Otherwise an inaccessible canonical owner can be hidden
  // by the scope filter and a polluted alias on an accessible shop can win.
  if (shouldResolveAutoflow) {
    const claimDocs = await db.collection("shops")
      .find(buildAutoflowClaimQuery(smsShopId), {
        collation: { locale: "en", strength: 2 },
      })
      .toArray();
    const claims = classifyAutoflowIdentifierClaims(claimDocs, smsShopId);
    const canonicalOwners = claims.canonicalClaims;
    const aliasOwners = claims.aliasClaims;

    if (canonicalOwners.length > 1) {
      const shopIds = canonicalOwners.map((item) => item.shopId);
      await recordUnresolvedAutoflowIdentifier(db, smsShopId, {
        reason: 'canonical_conflict',
        candidateShopIds: shopIds,
        candidateCount: shopIds.length,
      });
      console.warn(
        `[Shop Lookup] AutoFlow canonical conflict for "${smsShopId}" across shops ${shopIds.join(', ')}; refusing to guess`,
      );
      return {
        status: 'conflict',
        provider: 'autoflow',
        identifier: normalizeAutoflowIdentifier(smsShopId),
        conflictType: 'canonical',
        shopIds,
      };
    }

    if (canonicalOwners.length === 1) {
      const owner = claimDocs.find(
        (doc: any) => String(doc.shopId) === String(canonicalOwners[0].shopId),
      );
      if (!isShopAccessible(owner, userShopIds, isPlatformAdmin)) {
        console.warn(
          `[Shop Lookup] AutoFlow canonical owner ${canonicalOwners[0].shopId} for "${smsShopId}" is outside the user's scope; refusing alias fallback`,
        );
        return {
          status: 'access_denied',
          provider: 'autoflow',
          identifier: claims.identifier,
          ownerShopId: canonicalOwners[0].shopId,
        };
      }
      return resolvedShop(owner);
    }

    if ((providerHint === 'autoflow' || !providerHint) && aliasOwners.length > 1) {
      const shopIds = aliasOwners.map((item) => item.shopId);
      await recordUnresolvedAutoflowIdentifier(db, smsShopId, {
        reason: 'duplicate_alias',
        candidateShopIds: shopIds,
        candidateCount: shopIds.length,
      });
      console.warn(
        `[Shop Lookup] AutoFlow alias conflict for "${smsShopId}" across shops ${shopIds.join(', ')}; refusing to guess`,
      );
      return {
        status: 'conflict',
        provider: 'autoflow',
        identifier: claims.identifier,
        conflictType: 'alias',
        shopIds,
      };
    }

    if ((providerHint === 'autoflow' || !providerHint) && aliasOwners.length === 1) {
      const owner = claimDocs.find(
        (doc: any) => String(doc.shopId) === String(aliasOwners[0].shopId),
      );
      if (!isShopAccessible(owner, userShopIds, isPlatformAdmin)) {
        return {
          status: 'access_denied',
          provider: 'autoflow',
          identifier: claims.identifier,
          ownerShopId: aliasOwners[0].shopId,
        };
      }
      return resolvedShop(owner);
    }

    if (
      (providerHint === 'autoflow' || !providerHint)
      && !isPlatformAdmin
      && userShopIds.length === 0
    ) {
      return {
        status: 'access_denied',
        provider: 'autoflow',
        identifier: claims.identifier,
      };
    }
  }

  const allProviderClauses = [
      ...(isNaN(tekShopIdNum) ? [] : [{ shopId: tekShopIdNum }]),
      { "tekmetric.shopId": tekShopIdNum },
      { "tekmetric.shopId": tekShopIdStr },
      { tekmetricShopId: tekShopIdNum },
      { tekmetricShopId: tekShopIdStr },
      { "protractor.connectionId": smsShopId },
      { protractorConnectionId: smsShopId },
      { "shopware.tenantSubdomain": smsShopId },
      { "shopware.tenantId": smsShopId },
      { "shopmonkey.locationId": smsShopId },
      { "shopmonkey.companyId": smsShopId },
  ];
  const shopQuery: any = {
    $or: allProviderClauses,
  };
  
  if (!isPlatformAdmin && userShopIds.length > 0) {
    const shopIdVariants: (string | number)[] = [];
    for (const id of userShopIds) {
      const str = String(id);
      const num = Number(id);
      if (!shopIdVariants.includes(str)) shopIdVariants.push(str);
      if (Number.isFinite(num) && !shopIdVariants.includes(num)) shopIdVariants.push(num);
    }
    shopQuery.shopId = { $in: shopIdVariants };
  }
  
  let shopDoc = providerHint === "autoflow"
    ? null
    : await db.collection("shops").findOne(shopQuery);
  
  if (!shopDoc) {
    console.log(`[Shop Lookup] No match for smsShopId=${smsShopId}, userShopIds=${JSON.stringify(userShopIds)}, isPlatformAdmin=${isPlatformAdmin}, providerHint=${providerHint || 'none'}`);
    const anyShop = providerHint === 'autoflow' ? null : await db.collection("shops").findOne({
      $or: [
        { "tekmetric.shopId": tekShopIdNum },
        { "tekmetric.shopId": tekShopIdStr },
        { tekmetricShopId: tekShopIdNum },
        { tekmetricShopId: tekShopIdStr },
        { "protractor.connectionId": smsShopId },
        { protractorConnectionId: smsShopId },
        { "shopware.tenantSubdomain": smsShopId },
        { "shopware.tenantId": smsShopId },
      ]
    }, { projection: { shopId: 1, name: 1, integrationProvider: 1 } });
    if (anyShop) {
      console.log(`[Shop Lookup] Shop exists (shopId=${anyShop.shopId}, name=${anyShop.name}) but user lacks access. shopId type=${typeof anyShop.shopId}`);
    } else {
      console.log(`[Shop Lookup] No shop configured with SMS ID ${smsShopId} in any provider field`);
    }
  }
  
  if (!shopDoc && providerHint === 'shopware') {
    const swFallbackQuery: any = {
      "shopware.tenantId": { $exists: true },
    };
    if (!isPlatformAdmin && userShopIds.length > 0) {
      const shopIdVariants = userShopIds.flatMap(id => [id, String(id)]);
      swFallbackQuery.shopId = { $in: shopIdVariants };
    }
    const candidates = await db.collection("shops").find(swFallbackQuery).toArray();
    
    if (candidates.length === 1) {
      shopDoc = candidates[0];
      console.log(`[Shop Lookup] Shop-Ware fallback: single match shop ${shopDoc.shopId} for subdomain "${smsShopId}" — saving for future lookups`);
      await db.collection("shops").updateOne(
        { _id: shopDoc._id },
        { $set: { "shopware.tenantSubdomain": smsShopId } }
      );
    } else if (candidates.length > 1) {
      console.warn(`[Shop Lookup] Shop-Ware fallback: ${candidates.length} candidate shops for subdomain "${smsShopId}" — cannot auto-associate. Shops: ${candidates.map(s => s.shopId).join(', ')}`);
    }
  }

  // AutoFlow auto-learn (v3 -> v4 migration). AutoFlow is mid framework upgrade
  // and most shops are reachable via BOTH a v3 per-shop subdomain
  // (harrells-nc87.autotext.me) AND a v4 shared host with the shop NUMBER in the
  // path (app.autoflow.com/shop/<number>). That v4 number is a different
  // identifier and often isn't stored, so the lookup above misses on v4 URLs.
  // When we can confidently pin the single AutoFlow shop this user is working
  // in, learn the identifier so every future lookup (this and other routes)
  // resolves instantly. Mirrors the Shop-Ware fallback: only auto-associate on
  // a SINGLE candidate so we never link the wrong shop. Non-admins are scoped
  // to their own shops; platform admins (unscoped) won't auto-learn when many
  // AutoFlow shops exist, which is the safe outcome.
  // Only numeric v4 shop numbers may be learned. Learning arbitrary slugs is
  // what allowed canonical v3 identities such as "harrells-nc87" to poison
  // unrelated shops.
  const looksLikeAutoflowV4Number = isAutoflowV4ShopNumber(smsShopId);
  if (!shopDoc && providerHint === 'autoflow' && looksLikeAutoflowV4Number) {
    const afFallbackQuery: any = {
      $or: [
        { "autoflow.domain": { $exists: true } },
        { "autoflow.subdomain": { $exists: true } },
        { "autoflow.shopId": { $exists: true } },
        { "autoflow.configured": true },
        { autoflowDomain: { $exists: true } },
      ],
    };
    if (!isPlatformAdmin && userShopIds.length > 0) {
      const shopIdVariants = userShopIds.flatMap(id => [id, String(id)]);
      afFallbackQuery.shopId = { $in: shopIdVariants };
    }
    const candidates = await db.collection("shops").find(afFallbackQuery).toArray();

    if (candidates.length === 1) {
      // Re-check global ownership immediately before writing. This closes the
      // normal stale-read window and ensures an out-of-scope canonical or alias
      // can never be overwritten by learning into the user's sole candidate.
      const latestClaimDocs = await db.collection("shops")
        .find(buildAutoflowClaimQuery(smsShopId), {
          collation: { locale: "en", strength: 2 },
        })
        .toArray();
      const latestClaims = classifyAutoflowIdentifierClaims(
        latestClaimDocs,
        smsShopId,
      );
      if (
        latestClaims.canonicalClaims.length === 0
        && latestClaims.aliasClaims.length === 0
      ) {
        shopDoc = candidates[0];
        try {
          const candidateShop = shopDoc;
          await withAutoflowClaimTransaction(
            () => __deps.getMongoClient(),
            async (session) => {
              const reservation = await acquireAutoflowAliasClaim(
                db,
                smsShopId,
                candidateShop.shopId,
                { source: "auto_learning" },
                session,
              );
              try {
                console.log(`[Shop Lookup] AutoFlow fallback: single shop ${candidateShop.shopId} for v4 number "${smsShopId}" — learning it for future lookups`);
                const update = await db.collection("shops").updateOne(
                  { _id: candidateShop._id },
                  { $addToSet: { "autoflow.shopNumbers": smsShopId } },
                  session ? { session } : undefined,
                );
                if (update.matchedCount !== 1) {
                  throw new Error(
                    `AutoFlow learning target ${candidateShop.shopId} disappeared`,
                  );
                }
              } catch (error) {
                if (!session && reservation.created) {
                  await releaseAutoflowAliasClaim(
                    db,
                    reservation.normalizedIdentifier,
                    candidateShop.shopId,
                  );
                }
                throw error;
              }
            },
          );
        } catch (error) {
          shopDoc = null;
          if (error instanceof AutoflowAtomicClaimConflictError) {
            await recordUnresolvedAutoflowIdentifier(db, smsShopId, {
              reason: 'atomic_claim_conflict',
              candidateShopIds:
                error.ownerShopId == null ? [] : [error.ownerShopId],
              candidateCount: error.ownerShopId == null ? 0 : 1,
            });
          } else {
            throw error;
          }
        }
      } else {
        const owners = [
          ...latestClaims.canonicalClaims,
          ...latestClaims.aliasClaims,
        ].map((item) => item.shopId);
        await recordUnresolvedAutoflowIdentifier(db, smsShopId, {
          reason: 'claim_appeared_during_learning',
          candidateShopIds: owners,
          candidateCount: owners.length,
        });
        console.warn(
          `[Shop Lookup] AutoFlow id "${smsShopId}" gained an owner before learning; refusing write`,
        );
      }
    } else if (candidates.length > 1) {
      console.warn(`[Shop Lookup] AutoFlow fallback: ${candidates.length} candidate shops for AutoFlow id "${smsShopId}" — cannot auto-associate. Shops: ${candidates.map(s => s.shopId).join(', ')}`);
    }

    // Task #884: record unresolved AutoFlow identifiers (typically v4 shop
    // NUMBERS) so a platform admin can manually attach them to the right shop
    // under /platform-admin/autoflow-numbers. We stay fail-closed — never
    // guess a shop — but the miss must not be invisible. Best-effort: a write
    // failure never breaks the lookup itself.
    if (!shopDoc) {
      const candidateShopIds = candidates
        .map((s: any) => s?.shopId)
        .filter((id: any) => id != null);
      await recordUnresolvedAutoflowIdentifier(db, smsShopId, {
        reason: candidates.length > 1 ? 'ambiguous_candidates' : 'unknown',
        candidateShopIds,
        candidateCount: candidates.length,
      });
    }
  }

  if (!shopDoc && providerHint === 'autoflow' && !looksLikeAutoflowV4Number) {
    await recordUnresolvedAutoflowIdentifier(db, smsShopId, {
      reason: 'unknown_non_numeric_identifier',
      candidateShopIds: [],
      candidateCount: 0,
    });
  }

  // Shopmonkey self-onboard (key present, ids missing). Shopmonkey is a
  // single-host SPA, so the content script reads the shop's company/location id
  // off the page (a 24-hex ObjectId). Shops connected with only an API key have
  // `shopmonkey.companyId`/`locationId` set to null, so the primary $or above
  // misses and we (correctly) fail closed. Here we derive each candidate key's
  // own ids from Shopmonkey `GET /location` (every key reports ONLY its own
  // location), persist them, and match against the on-page id. This is bounded
  // and self-terminating: we only touch shops that are keyed-but-unidded, and
  // once their ids are stored the primary $or resolves them directly. The
  // per-key id check disambiguates a user with several Shopmonkey shops (each
  // key returns a different id), and a genuine no-match still returns null.
  const looksLikeShopmonkeyId =
    typeof smsShopId === 'string' && /^[a-f0-9]{24}$/i.test(smsShopId.trim());
  const shopmonkeyContext =
    providerHint === 'shopmonkey' || (!providerHint && looksLikeShopmonkeyId);
  if (!shopDoc && shopmonkeyContext) {
    const smFallbackQuery: any = {
      'shopmonkey.apiKey': { $exists: true, $ne: null },
      $or: [
        { 'shopmonkey.companyId': { $in: [null, undefined] } },
        { 'shopmonkey.locationId': { $in: [null, undefined] } },
      ],
    };
    if (!isPlatformAdmin && userShopIds.length > 0) {
      const shopIdVariants = userShopIds.flatMap(id => [id, String(id)]);
      smFallbackQuery.shopId = { $in: shopIdVariants };
    }
    const candidates = await db.collection("shops").find(smFallbackQuery).toArray();

    for (const cand of candidates) {
      const apiKey = cand?.shopmonkey?.apiKey;
      if (!apiKey) continue;

      const { companyId, locationId } = await __deps.discoverShopmonkeyIds(apiKey);
      if (!companyId && !locationId) continue;

      // Persist only the ids we learned that aren't already stored, so future
      // lookups resolve through the primary $or instead of re-discovering.
      const set: Record<string, string> = {};
      if (companyId && !cand.shopmonkey?.companyId) set["shopmonkey.companyId"] = companyId;
      if (locationId && !cand.shopmonkey?.locationId) set["shopmonkey.locationId"] = locationId;
      if (Object.keys(set).length > 0) {
        await db.collection("shops").updateOne({ _id: cand._id }, { $set: set });
        cand.shopmonkey = {
          ...cand.shopmonkey,
          ...(companyId ? { companyId } : {}),
          ...(locationId ? { locationId } : {}),
        };
      }

      if (smsShopId === companyId || smsShopId === locationId) {
        shopDoc = cand;
        console.log(`[Shop Lookup] Shopmonkey self-heal: shop ${cand.shopId} matched on-page id "${smsShopId}" after discovering ids from its key`);
        break;
      }
    }
  }

  if (!shopDoc) {
    return {
      status: 'not_found',
      ...(providerHint === 'autoflow'
        ? {
            provider: 'autoflow' as const,
            identifier: normalizeAutoflowIdentifier(smsShopId),
          }
        : {}),
    };
  }

  return resolvedShop(
    shopDoc,
    options.providerHintIsAuthoritative === true
      ? providerHint as ResolvedShopLookup["provider"]
      : undefined,
  );
}

export async function findShopBySmsId(
  smsShopId: string,
  options: {
    userShopIds?: number[];
    isPlatformAdmin?: boolean;
    providerHint?: string;
    providerHintIsAuthoritative?: boolean;
  } = {},
): Promise<ShopLookupResult> {
  const outcome = await findShopBySmsIdDetailed(smsShopId, options);
  return outcome.status === 'resolved' ? outcome : null;
}
