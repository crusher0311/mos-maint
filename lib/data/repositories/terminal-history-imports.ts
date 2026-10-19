import type { Db } from "mongodb";

export const HISTORY_SUMMARY_LIMITS = { campaigns: 5, shops: 200, receipts: 2000, queryMs: 1500 };
const terminal = ["needs-attention", "completed", "expired", "stopped", "cancelled"];
const count = (v: unknown) => typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : 0;
const date = (v: unknown) => {
  const n = v instanceof Date || typeof v === "string" ? new Date(v).getTime() : NaN;
  return Number.isFinite(n) ? new Date(n).toISOString() : null;
};
const prefix = (id: string) => ({ $regex: `^${id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:` });

/** Only projected bookkeeping is read. No archived pages, provider calls or writes. */
export async function readTerminalHistoryImports(db: Pick<Db, "collection">) {
  const limits = HISTORY_SUMMARY_LIMITS;
  const jobs = db.collection("operator_history_import_jobs");
  const campaigns = await jobs.find({
    mode: "missing_history_only", shops: { $exists: true }, status: { $in: terminal },
  }, {
    projection: { _id: 1, status: 1, unresolved: 1, endedAt: 1 },
    maxTimeMS: limits.queryMs, hint: "_id_",
  }).sort({ _id: -1 }).limit(limits.campaigns + 1).toArray();
  const rows = [];
  // Serial, capped fanout: at most five campaigns and two metadata queries each.
  for (const campaign of campaigns.slice(0, limits.campaigns)) {
    if (typeof campaign._id !== "string") continue;
    const id: string = campaign._id;
    const shops = await jobs.find({ _id: prefix(`${id}:shop`) } as any, {
      projection: { _id: 0, shopId: 1, unresolved: 1, heldDays: { $slice: 32 } },
      maxTimeMS: limits.queryMs, hint: "_id_",
    }).sort({ _id: 1 }).limit(limits.shops + 1).toArray();
    const receipts = await db.collection("operator_history_import_receipts").find(
      { _id: prefix(id) } as any,
      { projection: { _id: 0, status: 1 }, maxTimeMS: limits.queryMs, hint: "_id_" },
    ).sort({ _id: 1 }).limit(limits.receipts + 1).toArray();
    const outcomes = { imported: 0, verifiedPresent: 0, ambiguous: 0, indexReview: 0, thin: 0, unknown: 0 };
    for (const receipt of receipts.slice(0, limits.receipts)) {
      switch (receipt.status) {
        case "imported": outcomes.imported++; break;
        case "present": outcomes.verifiedPresent++; break;
        case "processing": case "prior-ambiguous": outcomes.ambiguous++; break;
        case "existing-needs-index-review": outcomes.indexReview++; break;
        case "thin": outcomes.thin++; break;
        default: outcomes.unknown++;
      }
    }
    rows.push({
      campaignId: id, status: String(campaign.status), endedAt: date(campaign.endedAt),
      recordedUnresolved: count(campaign.unresolved),
      outcomes, receiptsSampled: Math.min(receipts.length, limits.receipts),
      receiptsTruncated: receipts.length > limits.receipts,
      shopsTruncated: shops.length > limits.shops,
      shops: shops.slice(0, limits.shops).map(shop => ({
        shopId: count(shop.shopId), recordedUnresolved: count(shop.unresolved),
        heldDays: (Array.isArray(shop.heldDays) ? shop.heldDays : [])
          .slice(0, 31).filter((d: unknown): d is string => typeof d === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d)),
        heldDaysTruncated: Array.isArray(shop.heldDays) && shop.heldDays.length > 31,
      })),
    });
  }
  return { campaigns: rows, campaignsTruncated: campaigns.length > limits.campaigns, limits };
}

export type TerminalHistorySummary = Awaited<ReturnType<typeof readTerminalHistoryImports>>;
