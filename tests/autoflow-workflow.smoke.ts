/**
 * Offline coverage for AutoFlow workflow defaults, fail-closed status
 * classification, tenant-scoped observations, and storage-mode writes.
 *
 * Run with:
 *   npx tsx tests/autoflow-workflow.smoke.ts
 */
import {
  classifyAutoflowWorkflowStatus,
  defaultAutoflowWorkflowMapping,
  normalizeAutoflowWorkflowStatus,
  validateAutoflowWorkflowMapping,
} from "../lib/autoflow-workflow";
import {
  __deps,
  AutoflowWorkflowRevisionConflictError,
  getAutoflowWorkflowDetails,
  InvalidAutoflowWorkflowMappingError,
  listAutoflowWorkflowShops,
  resetAutoflowWorkflow,
  saveAutoflowWorkflow,
} from "../lib/data/repositories/autoflow-workflows";

let failed = 0;
function ok(name: string, condition: boolean) {
  if (condition) console.log(`  ✓ ${name}`);
  else {
    failed += 1;
    console.error(`  ✗ ${name}`);
  }
}

async function run() {
  console.log("autoflow workflow smoke");

  ok(
    "normalization changes only case and whitespace",
    normalizeAutoflowWorkflowStatus("  In   Progress ") === "in progress" &&
      normalizeAutoflowWorkflowStatus("Parts-Here") === "parts-here",
  );
  const defaults = defaultAutoflowWorkflowMapping();
  ok(
    "defaults retain the original six active stages and Close",
    defaults.active.length === 6 &&
      defaults.active.includes("CHECKED IN") &&
      defaults.active.includes("Authorized ready for work") &&
      defaults.closed.length === 1 &&
      defaults.closed[0] === "Close",
  );
  ok(
    "default unknown labels fail closed",
    classifyAutoflowWorkflowStatus("Appointment", null) === "unknown",
  );
  ok(
    "configured statuses are case and whitespace insensitive",
    classifyAutoflowWorkflowStatus("  PARTS   HERE ", {
      active: ["Parts Here"],
      closed: [],
      excluded: [],
    }) === "active",
  );
  let overlapRejected = false;
  try {
    validateAutoflowWorkflowMapping({
      active: ["Ready"],
      closed: [" ready "],
      excluded: [],
    });
  } catch {
    overlapRejected = true;
  }
  ok("a status cannot belong to two buckets", overlapRejected);

  const original = {
    listAllShops: __deps.listAllShops,
    findShopByShopId: __deps.findShopByShopId,
    isIdentityPgCanonical: __deps.isIdentityPgCanonical,
    replacePgWorkflowIfRevision: __deps.replacePgWorkflowIfRevision,
    listObservedAutoflowEvents: __deps.listObservedAutoflowEvents,
    listObservedAutoflowEventsMongo: __deps.listObservedAutoflowEventsMongo,
    getDb: __deps.getDb,
    reserveAutoflowDashboardUpdate: __deps.reserveAutoflowDashboardUpdate,
    finishAutoflowDashboardUpdate: __deps.finishAutoflowDashboardUpdate,
  };

  const shops: any[] = [
    {
      shopId: 432,
      name: "Grand Rapids Motorcar Service",
      autoflow: {
        domain: "grandrapidsmotorcar.autotext.me",
        apiKey: "redacted-test-key",
        settingsSibling: "must-survive",
      },
    },
    {
      shopId: 900,
      name: "Other AutoFlow",
      autoflow: { domain: "other.autotext.me", shopNumbers: ["615"] },
    },
    { shopId: 901, name: "No integration", preferences: {} },
  ];
  const eventRows: any[] = [
    {
      shopId: "432",
      provider: "autoflow",
      payload: { ticket: { status: "Checkin" } },
      receivedAt: new Date("2026-09-17T12:00:00Z"),
    },
    {
      shopId: "432",
      provider: "autoflow",
      payload: { ticket: { status: "Appointment" } },
      receivedAt: new Date("2026-09-17T11:00:00Z"),
    },
    {
      shopId: "900",
      provider: "autoflow",
      payload: { ticket: { status: "Wrong Tenant" } },
      receivedAt: new Date("2026-09-17T10:00:00Z"),
    },
  ];
  const mongoWrites: any[] = [];
  const pgWrites: any[] = [];
  let reservations = 0;
  let finishes = 0;
  let finishFailure: Error | null = null;
  __deps.reserveAutoflowDashboardUpdate = async () =>
    `offline-intent-${++reservations}`;
  __deps.finishAutoflowDashboardUpdate = async () => {
    finishes += 1;
    if (finishFailure) throw finishFailure;
  };

  __deps.listAllShops = async () => shops as any;
  __deps.findShopByShopId = async (shopId: any) =>
    shops.find((shop) => String(shop.shopId) === String(shopId)) as any;
  const metadataRows = eventRows.map((row) => ({
    shopId: row.shopId,
    status: row.payload?.ticket?.status || null,
    type: row.type || null,
    receivedAt: row.receivedAt,
    createdAt: row.createdAt || null,
  }));
  __deps.listObservedAutoflowEvents = async (shopId: any) =>
    metadataRows.filter((row) => String(row.shopId) === String(shopId)) as any;
  __deps.listObservedAutoflowEventsMongo = async () => [] as any;
  __deps.isIdentityPgCanonical = () => false;
  __deps.getDb = async () =>
    ({
      collection: (name: string) => ({
        updateOne: async (filter: any, update: any) => {
          if (name !== "shops") throw new Error(`unexpected collection ${name}`);
          mongoWrites.push({ filter, update });
          const idChoices = filter.$and[0].$or.map((item: any) => item.shopId);
          const shop = shops.find((item) => idChoices.some((id: any) => id === item.shopId));
          const revisionClause = filter.$and[1];
          const current = shop?.autoflow?.workflowRevision ?? 0;
          const revisionMatches = revisionClause.$or
            ? revisionClause.$or.some((item: any) => {
                const wanted = item["autoflow.workflowRevision"];
                const stored = shop?.autoflow?.workflowRevision;
                return wanted === 0 ? stored === 0 : wanted === null ? stored == null : false;
              })
            : current === revisionClause["autoflow.workflowRevision"];
          if (!shop || !revisionMatches) return { matchedCount: 0, modifiedCount: 0 };
          shop.autoflow.workflowMapping = update.$set["autoflow.workflowMapping"];
          shop.autoflow.workflowRevision = update.$set["autoflow.workflowRevision"];
          return { matchedCount: 1, modifiedCount: 1 };
        },
      }),
    }) as any;

  try {
    const listed = await listAutoflowWorkflowShops();
    ok(
      "connected shop list includes AutoFlow shops without aliases",
      listed.length === 2 && listed.some((shop) => shop.shopId === 432),
    );
    const details = await getAutoflowWorkflowDetails(432);
    ok(
      "observations are tenant-scoped metadata",
      details?.observed.length === 2 &&
        details.observed.some((item) => item.label === "Checkin") &&
        !details.observed.some((item) => item.label === "Wrong Tenant") &&
        details.observed.every((item) => !("payload" in item)),
    );

    shops[0].autoflow.workflowMapping = {
      active: ["Ready"],
      closed: [" ready "],
      excluded: [],
    };
    let malformedRejected = false;
    try {
      await getAutoflowWorkflowDetails(432);
    } catch (error) {
      malformedRejected = error instanceof InvalidAutoflowWorkflowMappingError &&
        error.revision === 0;
    }
    delete shops[0].autoflow.workflowMapping;
    ok("malformed stored mappings fail explicitly", malformedRejected);

    const firstMapping = {
      active: ["Checkin"],
      closed: ["Close"],
      excluded: ["Appointment"],
    };
    const [first, competing] = await Promise.allSettled([
      saveAutoflowWorkflow(432, firstMapping, 0),
      saveAutoflowWorkflow(432, {
        active: ["Estimate"],
        closed: ["Close"],
        excluded: [],
      }, 0),
    ]);
    ok(
      "two simultaneous Mongo saves at revision zero have exactly one winner",
      [first, competing].filter((result) => result.status === "fulfilled").length === 1 &&
        [first, competing].filter((result) =>
          result.status === "rejected" &&
          result.reason instanceof AutoflowWorkflowRevisionConflictError
        ).length === 1 &&
        shops[0].autoflow.workflowRevision === 1,
    );
    ok(
      "Mongo CAS preserves sibling AutoFlow integration configuration",
      shops[0].autoflow.apiKey === "redacted-test-key" &&
        shops[0].autoflow.settingsSibling === "must-survive" &&
        mongoWrites.some((write) =>
          write.update.$set["autoflow.workflowRevision"] === 1 &&
          !("autoflow" in write.update.$set)
        ),
    );
    ok(
      "stale CAS attempts still finish their write-ahead dashboard invalidations",
      reservations === 2 && finishes === 2,
    );

    const [reset, staleReset] = await Promise.allSettled([
      resetAutoflowWorkflow(432, 1),
      resetAutoflowWorkflow(432, 1),
    ]);
    ok(
      "reset races also have one winner and persist null at the next revision",
      [reset, staleReset].filter((result) => result.status === "fulfilled").length === 1 &&
        shops[0].autoflow.workflowMapping === null &&
        shops[0].autoflow.workflowRevision === 2,
    );

    const reloaded = await getAutoflowWorkflowDetails(432);
    const freshSave = await saveAutoflowWorkflow(
      432,
      firstMapping,
      reloaded!.revision,
    );
    ok(
      "reloading the fresh revision permits the next save",
      reloaded?.revision === 2 && freshSave.revision === 3 &&
        shops[0].autoflow.workflowRevision === 3,
    );

    const originalWarn = console.warn;
    console.warn = () => {};
    finishFailure = new Error("offline notification failure");
    const committedWithWarning = await saveAutoflowWorkflow(
      432,
      firstMapping,
      3,
    );
    finishFailure = null;
    console.warn = originalWarn;
    ok(
      "post-commit notification failure still returns the new revision and warning",
      committedWithWarning.revision === 4 &&
        typeof committedWithWarning.warning === "string" &&
        shops[0].autoflow.workflowRevision === 4,
    );

    finishFailure = new Error("offline notification failure after stale CAS");
    let staleError: unknown;
    console.warn = () => {};
    try {
      await saveAutoflowWorkflow(432, firstMapping, 3);
    } catch (error) {
      staleError = error;
    } finally {
      finishFailure = null;
      console.warn = originalWarn;
    }
    ok(
      "notification finish failures never swallow the original CAS conflict",
      staleError instanceof AutoflowWorkflowRevisionConflictError,
    );

    const otherSave = await saveAutoflowWorkflow(900, firstMapping, 0);
    ok(
      "shop revisions are independent",
      otherSave.revision === 1 && shops[0].autoflow.workflowRevision === 4 &&
        shops[1].autoflow.workflowRevision === 1,
    );
    ok(
      "Mongo CAS filter accepts the shop's numeric or legacy string identity",
      mongoWrites.every((write) => {
        const identities = write.filter.$and[0].$or.map((item: any) => item.shopId);
        return identities.some((id: any) => typeof id === "number") &&
          identities.some((id: any) => typeof id === "string");
      }),
    );

    delete shops[1].autoflow.workflowRevision;
    const absentLegacy = await getAutoflowWorkflowDetails(900);
    shops[1].autoflow.workflowRevision = null;
    const nullLegacy = await getAutoflowWorkflowDetails(900);
    ok(
      "absent and null legacy revisions read as zero",
      absentLegacy?.revision === 0 && nullLegacy?.revision === 0,
    );

    __deps.isIdentityPgCanonical = () => true;
    __deps.replacePgWorkflowIfRevision = async (shopId: any, mapping: any, expectedRevision: number) => {
      pgWrites.push({ shopId, mapping, expectedRevision });
      return { matchedCount: 1, modifiedCount: 1 };
    };
    await saveAutoflowWorkflow(432, {
      active: ["Checkin"],
      closed: ["Close"],
      excluded: [],
    }, 4);
    ok(
      "PG-mode save delegates mapping and expected revision to CAS helper",
      pgWrites.some(
        (write) =>
          write.shopId === 432 &&
          write.mapping.active?.[0] === "Checkin" &&
          write.expectedRevision === 4,
      ),
    );
  } finally {
    __deps.listAllShops = original.listAllShops;
    __deps.findShopByShopId = original.findShopByShopId;
    __deps.isIdentityPgCanonical = original.isIdentityPgCanonical;
    __deps.replacePgWorkflowIfRevision = original.replacePgWorkflowIfRevision;
    __deps.listObservedAutoflowEvents = original.listObservedAutoflowEvents;
    __deps.listObservedAutoflowEventsMongo = original.listObservedAutoflowEventsMongo;
    __deps.getDb = original.getDb;
    __deps.reserveAutoflowDashboardUpdate = original.reserveAutoflowDashboardUpdate;
    __deps.finishAutoflowDashboardUpdate = original.finishAutoflowDashboardUpdate;
  }

  if (failed > 0) process.exitCode = 1;
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
