import {getDb, getMongoClient} from "../db";
import {requireThat} from "@/lib/shop-dispatch/model";
import {STAFF_SHEET_TEMPLATES} from "@/lib/auto-dvi/staff/model";
import {PILOT_SHOP} from "@/lib/auto-dvi/pilot/model";
import {configurationSchema} from "@/lib/auto-dvi/staff/access";
import {isIdentityPgCanonical} from "@/lib/db/wave4-write-mode";

const configId = `shop:${PILOT_SHOP}`;
const collections = ["workflow_staff_inspections", "workflow_staff_inspection_config",
  "workflow_staff_inspection_media.files", "workflow_staff_inspection_media.chunks",
  "workflow_dvi_pilot_rollouts"];
/** Operator-only; never called by a route or application startup. No destructive
 * cleanup, role mutation, billing change, enterprise override or TTL creation. */
export async function configureCarExpertsPilot(action: "plan" | "provision" | "activate" | "rollback", connection: string,
  allRecordsTestInstanceApproved = false) {
  requireThat(!isIdentityPgCanonical(), "Canonical PG identity mode requires a separately reviewed operator plan", 409);
  const db = await getDb();
  const shop = await db.collection("shops").findOne({shopId: PILOT_SHOP}, {maxTimeMS: 3000});
  const enterprise = await db.collection("enterprise_accounts").findOne({shopIds: {$in: [PILOT_SHOP, String(PILOT_SHOP)]}}, {maxTimeMS: 3000});
  requireThat(shop?.name === "CAR Experts Protractor" && shop.integrationProvider === "protractor", "Pilot shop identity changed", 409);
  requireThat(!enterprise && !shop.enterpriseId, "Enterprise governance requires separate approval; no local override", 409);
  const config = await db.collection("workflow_staff_inspection_config").findOne({_id: configId} as any, {maxTimeMS: 3000});
  for (const name of collections) {
    const info = await db.listCollections({name}).next();
    if (!info) continue;
    requireThat(info.type === "collection" && "options" in info && !info.options?.capped && !info.options?.timeseries, "Incompatible pilot collection", 409);
    const indexes = await db.collection(name).listIndexes().toArray();
    requireThat(indexes.some(i => i.key?._id === 1) && !indexes.some(i => i.expireAfterSeconds !== undefined), "Unsafe pilot indexes", 409);
  }
  if (config) {
    const {_id, ...raw} = config;
    const parsed = configurationSchema.parse(raw);
    requireThat(parsed.pilot?.connectionHash === connection, "Existing pilot configuration/connection needs operator reconciliation", 409);
  }
  if (action === "plan") return {shopId: PILOT_SHOP, configurationExists: !!config,
    staffEnabled: config?.enabledShopIds?.includes(PILOT_SHOP) === true, providerAdmissions: config?.pilot?.admissions === true,
    targetScope: config?.pilot?.targetScope ?? "synthetic_fixture",
    sheet: "manual-safety@1", retention: "until separately approved cleanup", rollbackOwner: "requesting operator"};
  if (action === "provision") {
    for (const name of collections) {
      if (!await db.listCollections({name}).hasNext()) await db.createCollection(name, {writeConcern: {w: "majority", j: true}});
    }
    await db.collection("workflow_staff_inspection_media.files").createIndex({filename: 1, uploadDate: 1});
    await db.collection("workflow_staff_inspection_media.chunks").createIndex({files_id: 1, n: 1}, {unique: true});
    if (!config) {
      const value = configurationSchema.parse({version: 1, enabledShopIds: [], sheets: STAFF_SHEET_TEMPLATES,
        defaultSheet: "manual-safety@1", rules: {}, individual: {},
        pilot: {admissions: false, connectionHash: connection, labels: {green: "OK", yellow: "Requires Future Attention", red: "Required"},
          labelEvidence: "synthetic_roundtrip_only"}});
      await db.collection("workflow_staff_inspection_config").insertOne({_id: configId, ...value} as any,
        {writeConcern: {w: "majority", j: true}, ignoreUndefined: true});
    }
  } else {
    requireThat(config, "Provision approved pilot storage/configuration first", 409);
    if (action === "activate") {
      requireThat(config.defaultSheet === "manual-safety@1" &&
        JSON.stringify(config.sheets) === JSON.stringify(STAFF_SHEET_TEMPLATES), "Approved sheet changed", 409);
      // Preserve unrelated per-shop flags. No global plan/tier modification.
      const {normalizeShopFeatureOverrides} = await import("@/lib/featureResolver");
      const flags = normalizeShopFeatureOverrides(shop.enabledFeatures);
      const filter = {shopId: PILOT_SHOP, ...(shop.enabledFeatures === undefined
        ? {enabledFeatures: {$exists: false}} : {enabledFeatures: shop.enabledFeatures})};
      const changed = await db.collection("shops").updateOne(filter, {$set: {enabledFeatures: {...flags, shop_workflow: true, auto_dvi: true}}},
        {writeConcern: {w: "majority", j: true}});
      requireThat(changed.matchedCount === 1, "Shop flags changed concurrently; stop and inspect", 409);
    }
    const updated = {...config, enabledShopIds: action === "activate" ? [PILOT_SHOP] : [],
      pilot: {...config.pilot, admissions: action === "activate",
        ...(action === "activate" && allRecordsTestInstanceApproved ? {targetScope: "shop_test_instance"} : {})}};
    const result = await db.collection("workflow_staff_inspection_config").replaceOne(config, updated,
      {writeConcern: {w: "majority", j: true}});
    requireThat(result.matchedCount === 1, "Pilot configuration changed concurrently; stop and inspect", 409);
  }
  await db.collection("workflow_dvi_pilot_rollouts").insertOne({shopId: PILOT_SHOP, action, at: new Date(),
    approvedSheet: "manual-safety@1",
    syntheticOnly: !(allRecordsTestInstanceApproved || config?.pilot?.targetScope === "shop_test_instance"),
    concurrencyCertified: false, terminationCertified: false,
    customerPublicationChanged: false, retention: "until separately approved cleanup", rollbackOwner: "requesting operator",
    note: "Operator command; serving UI/readback verification is a separate required rollout observation."},
  {writeConcern: {w: "majority", j: true}});
  return {shopId: PILOT_SHOP, action, servingRuntimeVerified: false, nativeReadbackDemonstrated: false};
}
export async function closePilotAdmin() { await (await getMongoClient()).close(); }
