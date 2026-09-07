import assert from "node:assert/strict";

async function main() {
  const {
    __deps,
    AppFueledMappingValidationError,
    validateAuthoritativeMapping,
  } = await import("../lib/data/repositories/appfueled-shop-mappings");

  let directLookupCount = 0;
  let providerLookupCount = 0;

  __deps.getShopById = async (shopId: number) => {
    directLookupCount += 1;
    return shopId === 50
      ? { shopId: 50, integrationProvider: "protractor" } as any
      : null;
  };
  __deps.findShopBySmsIdDetailed = async (externalShopId: string, options: any) => {
    providerLookupCount += 1;
    assert.equal(options.isPlatformAdmin, true);
    assert.equal(options.providerHintIsAuthoritative, true);
    if (externalShopId === "provider-50" && options.providerHint === "protractor") {
      return {
        status: "resolved",
        mosShopId: 50,
        provider: "protractor",
        shopDoc: { shopId: 50, integrationProvider: "protractor" },
      } as any;
    }
    return { status: "not_found" } as any;
  };

  await validateAuthoritativeMapping({
    externalShopId: "50",
    mosShopId: 50,
    provider: "protractor",
  });
  assert.equal(directLookupCount, 1, "exact MOS shop IDs use the direct shop lookup");
  assert.equal(providerLookupCount, 0, "exact MOS shop IDs bypass provider identifier resolution");

  await assert.rejects(
    validateAuthoritativeMapping({
      externalShopId: "50",
      mosShopId: 50,
      provider: "tekmetric",
    }),
    (error: unknown) =>
      error instanceof AppFueledMappingValidationError
      && /configured for protractor, not tekmetric/.test(error.message),
  );

  await assert.rejects(
    validateAuthoritativeMapping({
      externalShopId: "51",
      mosShopId: 51,
      provider: "protractor",
    }),
    (error: unknown) =>
      error instanceof AppFueledMappingValidationError
      && /MOS shop 51 was not found/.test(error.message),
  );

  await validateAuthoritativeMapping({
    externalShopId: "provider-50",
    mosShopId: 50,
    provider: "protractor",
  });
  assert.equal(providerLookupCount, 1, "provider-issued IDs retain authoritative provider validation");

  await assert.rejects(
    validateAuthoritativeMapping({
      externalShopId: "050",
      mosShopId: 50,
      provider: "protractor",
    }),
    (error: unknown) =>
      error instanceof AppFueledMappingValidationError
      && /not configured on the canonical provider/.test(error.message),
  );
  assert.equal(
    providerLookupCount,
    2,
    "non-canonical numeric strings cannot masquerade as direct MOS shop IDs",
  );
}

main()
  .then(() => console.log("appfueled shop mappings smoke tests passed"))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });