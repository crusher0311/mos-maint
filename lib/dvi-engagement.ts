/** Customer engagement, not inspection completion or recommendation provenance. */
export type DviEvidenceStatus = "positive" | "negative" | "unknown" | "unsupported";
export interface DviEvidence {
  status: DviEvidenceStatus;
  timestamp?: string;
  timestampKind?: "event" | "received";
  source?: string;
  context?: string;
}
export interface DviEngagement {
  sent: DviEvidence;
  viewed: DviEvidence;
}
export const unknownDviEngagement = (): DviEngagement => ({
  sent: { status: "unknown" },
  viewed: { status: "unknown" },
});

/** Require a timezone; never turn a date-only or local timestamp into an event time. */
export function evidenceTimestamp(value: unknown): string | undefined {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/i.test(value)) return;
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return;
  return new Date(ms).toISOString();
}

/** Only the live-verified inspection-view sentence; names are deliberately ignored. */
export function tekmetricInspectionViewRo(event: unknown, ro: any): string | undefined {
  if (typeof event !== "string") return;
  const match = event.match(/^.+ viewed their inspection for Repair Order #(\d+)$/i);
  if (!match || String(ro?.repairOrderNumber) !== match[1]) return;
  if (!Number.isSafeInteger(Number(ro?.id)) || Number(ro?.id) <= 0 ||
      !Number.isSafeInteger(Number(ro?.shopId)) || Number(ro?.shopId) <= 0) return;
  return String(ro.id);
}

export function tekmetricRoId(provenance: any): string | undefined {
  const ids = (Array.isArray(provenance?.sourceIds) ? provenance.sourceIds : [])
    .filter((s: any) => s?.system === "tekmetric" && s.idType === "repair_order_id")
    .map((s: any) => String(s.idValue));
  const unique = [...new Set<string>(ids)];
  return unique.length === 1 && /^\d+$/.test(unique[0]) ? unique[0] : undefined;
}

/** Dedicated fields are outside provider snapshots, so refreshes cannot erase them. */
export interface TekmetricDviRecord {
  workOrderId: string;
  dviInspectionSharedAt?: string;
  dviInspectionViewReceivedAt?: string;
  inspectionShareDate?: string;
}
export function engagementFromTekmetric(record?: TekmetricDviRecord): DviEngagement {
  const result = unknownDviEngagement();
  const sent = evidenceTimestamp(record?.dviInspectionSharedAt) ??
    evidenceTimestamp(record?.inspectionShareDate);
  const viewed = evidenceTimestamp(record?.dviInspectionViewReceivedAt);
  if (sent) result.sent = {
    status: "positive", timestamp: sent, timestampKind: "event",
    source: "Tekmetric API",
    context: "Tekmetric recorded inspection sharing (inspectionShareDate); this is not confirmation of SMS or email delivery.",
  };
  if (viewed) result.viewed = {
    status: "positive", timestamp: viewed, timestampKind: "received",
    source: "Tekmetric inspection-view webhook",
    context: "Time MOS received the inspection-view event, not the exact time the customer opened it.",
  };
  return result;
}

/** Old saved reports remain readable and do not infer evidence from legacy flags. */
export function normalizeDviEngagement(value: unknown): DviEngagement {
  const read = (entry: any): DviEvidence => {
    if (!entry || !["positive", "negative", "unknown", "unsupported"].includes(entry.status))
      return { status: "unknown" };
    // Negative / unsupported claims must carry authoritative source context.
    if ((entry.status === "negative" || entry.status === "unsupported") &&
        (!entry.source || !entry.context)) return { status: "unknown" };
    const timestamp = evidenceTimestamp(entry.timestamp);
    return {
      status: entry.status,
      ...(typeof entry.source === "string" ? { source: entry.source } : {}),
      ...(typeof entry.context === "string" ? { context: entry.context } : {}),
      ...(timestamp && ["event", "received"].includes(entry.timestampKind)
        ? { timestamp, timestampKind: entry.timestampKind } : {}),
    };
  };
  return { sent: read((value as any)?.sent), viewed: read((value as any)?.viewed) };
}
