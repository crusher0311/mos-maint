import type { BindingAdmission, BindingEvent, WorkflowInspection } from "./workflow-binding-contract";

/** Pure transaction body for the future repository. Caller must serialize this
 * with uniqueness checks across the shop; this is not a database adapter. */
export function applyBindingAdmission(
  records: readonly WorkflowInspection[], a: BindingAdmission,
): WorkflowInspection | null {
  const id = a.identity;
  const sameShop = records.filter(r => r.identity.shopId === id.shopId);
  const current = sameShop.find(r => r.identity.workflowVisitId === id.workflowVisitId);
  const receipt = current?.receipts.find(r => r.requestId === a.requestId);
  if (receipt) return receipt.digest === a.digest && receipt.actorId === a.actorId ? structuredClone(current!) : null;
  if (sameShop.some(r => r.receipts.some(x => x.requestId === a.requestId))) return null;
  if ((current?.revision ?? 0) !== a.expectedInspectionRevision || current?.closed) return null;
  if (id.provider === "manual" ? id.providerWorkOrderId !== null : !id.providerWorkOrderId) return null;
  if (current?.identity.providerWorkOrderId &&
      (current.identity.provider !== id.provider || current.identity.providerWorkOrderId !== id.providerWorkOrderId)) return null;
  const aliases = [...new Set([...(current?.aliases ?? []), ...a.aliases])].sort();
  if (aliases.includes(id.workflowVisitId)) return null;
  const keys = new Set([id.workflowVisitId, ...aliases]);
  for (const other of sameShop) {
    if (other === current) continue;
    if ([other.identity.workflowVisitId, ...other.aliases].some(key => keys.has(key))) return null;
    if (id.providerWorkOrderId && other.identity.provider === id.provider &&
        other.identity.providerWorkOrderId === id.providerWorkOrderId) return null;
  }
  if ((current?.events.length ?? 0) + 2 > 5000 || (current?.receipts.length ?? 0) >= 5000) return null;
  const revision = (current?.revision ?? 0) + 1;
  const event: BindingEvent = {
    version: 1, id: `${a.requestId}:binding`, actorId: a.actorId, source: "workflow-intake",
    at: a.at, correlationId: a.requestId, before: current?.identity ?? null, after: id,
    reason: current ? "ticket-confirmed" : "bind", aliases: [],
  };
  const newAliases = aliases.filter(alias => !current?.aliases.includes(alias));
  return structuredClone({
    identity: id, aliases, revision, closed: false, results: current?.results ?? {},
    receipts: [...(current?.receipts ?? []), { ...a, inspectionRevision: revision }],
    events: [...(current?.events ?? []), event, ...(newAliases.length
      ? [{ ...event, id: `${a.requestId}:aliases`, reason: "import-alias" as const, aliases: newAliases }] : [])],
  });
}
