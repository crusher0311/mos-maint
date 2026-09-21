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
    updateShopById: __deps.updateShopById,
    isIdentityPgCanonical: __deps.isIdentityPgCanonical,
    updatePgShopFields: __deps.updatePgShopFields,
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
  __deps.reserveAutoflowDashboardUpdate = async () => "offline-intent";
  __deps.finishAutoflowDashboardUpdate = async () => {};

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
  __deps.updateShopById = async (_shopId: any, update: any) => {
    mongoWrites.push(update);
    return { matchedCount: 1, modifiedCount: 1 };
  };
  __deps.getDb = async () =>
    ({
      collection: () => ({
        updateOne: async (...args: any[]) => {
          mongoWrites.push({ dashboard: args });
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
      malformedRejected = error instanceof InvalidAutoflowWorkflowMappingError;
    }
    delete shops[0].autoflow.workflowMapping;
    ok("malformed stored mappings fail explicitly", malformedRejected);

    await saveAutoflowWorkflow(432, {
      active: ["Checkin"],
      closed: ["Close"],
      excluded: ["Appointment"],
    });
    ok(
      "Mongo-mode save writes only workflow mapping and not sibling settings",
      mongoWrites.some(
        (write) =>
          write.$set?.["autoflow.workflowMapping"]?.active?.[0] === "Checkin" &&
          !("autoflow" in (write.$set || {})),
      ),
    );
    await resetAutoflowWorkflow(432);
    ok(
      "Mongo-mode reset removes only workflow mapping",
      mongoWrites.some((write) => write.$unset?.["autoflow.workflowMapping"] === ""),
    );

    __deps.isIdentityPgCanonical = () => true;
    __deps.updatePgShopFields = async (shopId: any, fields: any) => {
      pgWrites.push({ shopId, fields });
      return { matchedCount: 1, modifiedCount: 1 };
    };
    await saveAutoflowWorkflow(432, {
      active: ["Checkin"],
      closed: ["Close"],
      excluded: [],
    });
    ok(
      "PG-mode save uses a nested field update",
      pgWrites.some(
        (write) =>
          write.shopId === 432 &&
          write.fields["autoflow.workflowMapping"]?.active?.[0] === "Checkin",
      ),
    );
  } finally {
    __deps.listAllShops = original.listAllShops;
    __deps.findShopByShopId = original.findShopByShopId;
    __deps.updateShopById = original.updateShopById;
    __deps.isIdentityPgCanonical = original.isIdentityPgCanonical;
    __deps.updatePgShopFields = original.updatePgShopFields;
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
