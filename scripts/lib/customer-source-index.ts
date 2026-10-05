/** Matches ingestCustomer's shop-scoped provenance.sourceIds $elemMatch.
 * SourceId uses `system` and `idValue`, not `sourceSystem` and `id`.
 * No automatic startup migration: the operator script applies this explicitly.
 */
export const CUSTOMER_SOURCE_INDEX = {
  name: "customer_shop_source_identity",
  key: {
    shopId: 1,
    "provenance.sourceIds.system": 1,
    "provenance.sourceIds.idValue": 1,
  },
} as const;

type IndexDescription = {
  name?: string;
  key: Record<string, unknown>;
  hidden?: boolean;
  sparse?: boolean;
  partialFilterExpression?: unknown;
  collation?: { locale?: string };
};

export function findCustomerSourceIndex(indexes: IndexDescription[]): string | undefined {
  const wanted = Object.entries(CUSTOMER_SOURCE_INDEX.key);
  return indexes.find(index => {
    if (index.hidden || index.sparse || index.partialFilterExpression ||
        (index.collation && index.collation.locale !== "simple")) return false;
    const keys = Object.entries(index.key);
    return wanted.every(([field, direction], i) =>
      keys[i]?.[0] === field && keys[i]?.[1] === direction);
  })?.name;
}

export function planCustomerSourceIndex(indexes: IndexDescription[]) {
  const existing = findCustomerSourceIndex(indexes);
  if (existing) return { action: "exists" as const, name: existing };
  if (indexes.some(index => index.name === CUSTOMER_SOURCE_INDEX.name)) {
    throw new Error("Customer source index name conflicts; refusing to replace an existing index");
  }
  return { action: "create" as const, name: CUSTOMER_SOURCE_INDEX.name };
}