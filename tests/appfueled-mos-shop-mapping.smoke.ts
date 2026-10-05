import assert from "node:assert/strict";

// Offline only: all identity and mapping reads are replaced before import.
let target: any = { shopId: 37, integrationProvider: "tekmetric", tekmetric: { shopId: 9001 } };
let resolution: any = {
  status: "resolved", mosShopId: 37, provider: "tekmetric", shopDoc: target,
};
let rows: any[] = [];
let lookedUpId: string | undefined;
function stub(path: string, exports: unknown) {
  const filename = require.resolve(path);
  require.cache[filename] = { id: filename, filename, loaded: true, exports } as any;
}
stub("../lib/data/repositories/shops", {
  findShopByShopId: async (id: number) => {
    assert.equal(id, 37);
    return target;
  },
});
stub("../lib/extension-shop-lookup", {
  findShopBySmsIdDetailed: async (id: string, options: any) => {
    lookedUpId = id;
    assert.equal(options.providerHint, "tekmetric");
    assert.equal(options.providerHintIsAuthoritative, true);
    return resolution;
  },
});
stub("../lib/db/drizzle", {
  getDb: () => ({
    select: () => ({ from: () => ({ where: () => ({ limit: async () => rows }) }) }),
  }),
});

async function main() {
  const { validateAuthoritativeMapping, resolveActiveAppFueledMapping } =
    await import("../lib/data/repositories/appfueled-shop-mappings");
  const input = { externalShopId: "37", mosShopId: 37, provider: "tekmetric" as const };
  await validateAuthoritativeMapping(input);
  assert.equal(lookedUpId, "9001", "MOS ID is not used as the upstream provider ID");
  assert.equal(await resolveActiveAppFueledMapping("37"), null, "MOS ID alone grants no access");
  rows = [{ ...input, isActive: true }];
  assert.equal((await resolveActiveAppFueledMapping("37"))?.mosShopId, 37);
  await assert.rejects(validateAuthoritativeMapping({ ...input, externalShopId: "38" }), /authorized MOS/);
  await assert.rejects(validateAuthoritativeMapping({ ...input, externalShopId: "037" }), /authorized MOS/);
  await assert.rejects(validateAuthoritativeMapping({ ...input, provider: "protractor" }), /provider does not match/);
  target = null;
  await assert.rejects(validateAuthoritativeMapping(input), /does not exist/);
  target = { shopId: 37, integrationProvider: "tekmetric" };
  await assert.rejects(validateAuthoritativeMapping(input), /identity is not configured/);
  target.tekmetric = { shopId: 9001 };
  resolution = { status: "conflict" };
  await assert.rejects(validateAuthoritativeMapping(input), /ambiguous/);
  resolution = { status: "not_found" };
  await assert.rejects(validateAuthoritativeMapping(input), /not configured/);
  resolution = { status: "resolved", mosShopId: 38, provider: "tekmetric", shopDoc: target };
  await assert.rejects(validateAuthoritativeMapping(input), /not 37/);
  console.log("AppFueled MOS shop mapping: PASS");
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
