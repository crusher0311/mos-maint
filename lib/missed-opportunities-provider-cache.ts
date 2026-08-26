export const PROVIDER_CACHE_ENRICHMENT_BUDGET_MS = 5_000;

type ProtractorSourceId = {
  system?: unknown;
  idType?: unknown;
  idValue?: unknown;
};

export function protractorSourceIdsByType(value: unknown): {
  all: string[];
  invoiceIds: string[];
  workOrderIds: string[];
} {
  const sourceIds: ProtractorSourceId[] = Array.isArray((value as any)?.sourceIds)
    ? (value as any).sourceIds
    : [];
  const invoiceIds = new Set<string>();
  const workOrderIds = new Set<string>();
  for (const sourceId of sourceIds) {
    if (sourceId?.system !== "protractor") continue;
    const id = String(sourceId.idValue || "").trim();
    if (!id) continue;
    if (sourceId.idType === "invoice_id") invoiceIds.add(id);
    if (sourceId.idType === "work_order_id") workOrderIds.add(id);
  }
  return {
    all: Array.from(new Set([...invoiceIds, ...workOrderIds])),
    invoiceIds: Array.from(invoiceIds),
    workOrderIds: Array.from(workOrderIds),
  };
}

export async function withinProviderCacheBudget<T>(
  work: () => Promise<T>,
  fallback: T,
  budgetMs: number = PROVIDER_CACHE_ENRICHMENT_BUDGET_MS,
): Promise<{ value: T; timedOut: boolean }> {
  if (budgetMs <= 0) return { value: fallback, timedOut: true };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<{ value: T; timedOut: boolean }>((resolve) => {
    timer = setTimeout(
      () => resolve({ value: fallback, timedOut: true }),
      Math.max(1, budgetMs),
    );
  });
  try {
    return await Promise.race([
      work().then((value) => ({ value, timedOut: false })),
      timeout,
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}