import native from "@/docs/reporting/jwt-701-september-1-native-identities.json";

export interface InvoicePreviewDeps {
  authorize(): Promise<unknown>;
  enterprise(): Promise<{ name: string; shopIds: unknown[] } | null>;
  relayMode(): string;
  interactive<T>(work: () => Promise<T>): Promise<T>;
  policy(): Promise<{ allowed: boolean; callbackOnly?: boolean; requireTimedTrial?: boolean; allowInteractive?: boolean }>;
  read(): Promise<{ ok: boolean; data?: { ItemCollection?: unknown }; error?: string }>;
}

export async function previewJwtInvoices(deps: InvoicePreviewDeps) {
  try { await deps.authorize(); } catch {
    return { status: 401, body: { ok: false, error: "Platform administrator sign-in required." } };
  }
  const blocked = (error: string, status = 409) => ({ status, body: { ok: false, error } });
  const enterprise = await deps.enterprise();
  if (enterprise?.name !== "JWT" || !enterprise.shopIds.some(id => Number(id) === 227)) {
    return blocked("JWT membership for location 701 could not be verified.");
  }
  if (deps.relayMode() !== "relay") return blocked("Approved relay transport is not active.");
  return deps.interactive(async () => {
    const policy = await deps.policy();
    if (!policy.allowed || ((policy.callbackOnly || policy.requireTimedTrial) && !policy.allowInteractive)) {
      return blocked("Current production policy does not permit this authenticated interactive read. No provider request was made.");
    }
    const result = await deps.read();
    if (!result.ok) return blocked("The shared adapter declined or failed the read. No repair was attempted.", 503);
    const records = result.data?.ItemCollection;
    if (!Array.isArray(records) || records.length > 25) return blocked("Unexpected invoice response. No repair was attempted.", 502);
    const numeric = (value: unknown) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0
      ? String(value) : typeof value === "string" && /^\d{1,20}$/.test(value) ? value : null;
    const rows = records.map((record: any) => {
      const workOrderNumber = numeric(record?.WorkOrderNumber);
      const invoiceNumber = numeric(record?.InvoiceNumber);
      const invoiceDate = typeof record?.InvoiceTime === "string" && /^\d{4}-\d{2}-\d{2}T/.test(record.InvoiceTime)
        ? record.InvoiceTime.slice(0, 10) : null;
      const type = ["Invoice", "CreditInvoice", "WorkOrder", "Appointment"].includes(record?.Type) ? record.Type : "unknown";
      const match = native.find(n => n.wo === workOrderNumber && n.invoice === invoiceNumber);
      // Object Type is not proof of invoice closure. Match the native identity
      // and date independently; this preview never certifies terminal status.
      const comparison = match && invoiceDate === "2026-09-01"
        ? `Native identity and date matched; stored snapshot: ${match.classification}. Closure not verified by this preview.`
        : "Unverified: identity or date does not match the September 1 native sample. Closure not verified by this preview.";
      return { workOrderNumber, invoiceNumber, invoiceDate, type, comparison };
    });
    return { status: 200, body: { ok: true, partial: true, rows, nativeCount: native.length, returnedCount: rows.length } };
  });
}
