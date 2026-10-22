import { createHash } from "node:crypto";
import { previewStoredEvidence } from "../../scripts/invoice-evidence-local-preview";

export const PARSER_VERSION = "stored-invoice-projection-1";
// Independent switches: shadow population must never select the customer reader.
// The old combined flag intentionally enables neither path.
export const builderEnabled = () => process.env.REPORTING_INVOICE_PROJECTION_BUILD_ENABLED === "true";
export const enabled = () => process.env.REPORTING_INVOICE_PROJECTION_READ_ENABLED === "true";
export const hash = (value: unknown): string =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
export const EMPTY_DIGEST = hash([]);
export const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
export const LIMITS = {
  documentBytes: 16 * 1024 * 1024, identityBytes: 32 * 1024 * 1024,
  copies: 100, documents: 1_000_000, identities: 100_000,
  tickMs: 15_000, tickSteps: 25, freshnessMs: 5 * 60_000,
} as const;
export type Query = (text: string, params?: any[]) => Promise<any[]>;
export type SourceDocument = {
  key: string; digest: string; identities: string[]; owner: string | null;
  ambiguous: boolean; raws: unknown[];
};
export interface SourceInventory {
  readonly channels: readonly string[];
  /** Exactly one document, keyset ordered; null is authoritative end of channel. */
  next(channel: string, shop: number, after: string | null): Promise<SourceDocument | null>;
  load(channel: string, shop: number, key: string): Promise<SourceDocument | null>;
}
export type Copy = { channel: string; key: string; digest: string; owner: string | null; ambiguous: boolean };
export type Review = {
  id: string; input_digest: string; inventory_digest: string; parser_version: string;
  disposition: "invoice" | "noninvoice"; expires_at: Date | string;
};
export function classify(shopId: number, identity: string, raws: unknown[], owners: string[],
  ambiguous: boolean, review: Review | null, holdCovered: boolean) {
  const unresolved = (reason: string) => ({
    classification: "unresolved", reason, invoiceDate: null, sold: null, presented: null,
  });
  if (!UUID.test(identity)) return unresolved("missing_identity");
  if (ambiguous || new Set(owners).size !== 1) return unresolved("ambiguous_or_missing_owner");
  if (!review) return unresolved("missing_or_stale_financial_owner_review");
  if (!holdCovered) return unresolved("missing_stale_or_held_coverage");
  if (review.disposition === "noninvoice") {
    // A reviewed classification is not permission to ignore final invoice evidence.
    if (!raws.length || !raws.every((r: any) => r && String(r.ID).toLowerCase() === identity &&
      r.Type === "WorkOrder" && Number(r.InvoiceNumber) === 0 && r.WorkflowStage !== "Invoice"))
      return unresolved("noninvoice_evidence_conflict");
    return { classification: "noninvoice", reason: "reviewed_noninvoice", invoiceDate: null, sold: null, presented: null };
  }
  const result = previewStoredEvidence({ shopId, sourceIds: [identity], copies: raws.map(raw => ({ shopId, raw })) });
  if (!result.evidence) return unresolved(result.reason);
  return { classification: "verified", reason: result.reason, invoiceDate: result.evidence.date,
    sold: result.evidence.sold, presented: result.evidence.presented };
}
