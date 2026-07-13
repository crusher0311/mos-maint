// Task #860: DVI share-link ingestion orchestrator.
//
// SAFETY: every write path is gated behind DVI_LINK_INGEST_ENABLED
// (default OFF) because this environment's dev Mongo IS the production
// cluster. Detection hooks, the fetch cron, and the sweep script all
// bail out silently unless the flag is explicitly "true".
import type { ObjectId } from "mongodb";
import {
  registerDviLink,
  findFetchableDviLinks,
  recordDviLinkFetchOutcome,
  recordDviLinkParseResult,
  saveDviLinkSnapshot,
} from "@/lib/data/repositories/dvi-links";
import { extractDviLinks } from "./extract";
import { fetchDviLink } from "./fetcher";
import { providerDef } from "./registry";

export function isDviLinkIngestEnabled(): boolean {
  return process.env.DVI_LINK_INGEST_ENABLED === "true";
}

/** Polite pacing between outbound fetches (per process). */
const FETCH_SPACING_MS = 1_000;

export interface DetectInvoiceLinksInput {
  shopId: number | string;
  /** Raw Protractor invoice payload (list row or detail). */
  invoice: any;
}

/**
 * Scans one synced Protractor invoice for DVI share links and registers
 * them (idempotent). Returns how many NEW links were registered.
 */
export async function detectDviLinksFromProtractorInvoice(
  input: DetectInvoiceLinksInput,
): Promise<number> {
  if (!isDviLinkIngestEnabled()) return 0;
  const links = extractDviLinks(input.invoice);
  if (links.length === 0) return 0;
  const vin: string | null =
    input.invoice?.ServiceItem?.VIN ?? input.invoice?.ServiceItem?.Vin ?? null;
  const workOrderNumber =
    input.invoice?.InvoiceNumber ?? input.invoice?.WorkOrderNumber ?? null;
  let created = 0;
  for (const link of links) {
    try {
      const isNew = await registerDviLink({
        provider: link.provider,
        url: link.url,
        shopId: String(input.shopId),
        vin,
        workOrderNumber: workOrderNumber != null ? String(workOrderNumber) : null,
        sourceProvider: "protractor",
      });
      if (isNew) created++;
    } catch (e: any) {
      // Loud but non-fatal: link registration must never break a sync.
      console.warn(
        `[DviLinks] register failed for shop ${input.shopId} ${link.url}: ${e?.message || e}`,
      );
    }
  }
  if (created > 0) {
    console.log(
      `[DviLinks] shop ${input.shopId}: registered ${created} new DVI link(s) (WO ${workOrderNumber ?? "?"})`,
    );
  }
  return created;
}

export interface FetchPendingResult {
  processed: number;
  ok: number;
  parsed: number;
  media: number;
  expired: number;
  failed: number;
}

/**
 * Fetches + snapshots + parses pending links (used by the cron route and
 * the operator sweep script). Bounded by `limit`; paced politely.
 */
export async function fetchPendingDviLinks(
  limit = 25,
): Promise<FetchPendingResult> {
  const result: FetchPendingResult = {
    processed: 0,
    ok: 0,
    parsed: 0,
    media: 0,
    expired: 0,
    failed: 0,
  };
  if (!isDviLinkIngestEnabled()) return result;

  const pending = await findFetchableDviLinks(limit);
  for (const link of pending) {
    result.processed++;
    const linkId = link._id as ObjectId;
    const fetched = await fetchDviLink(link.url);

    await recordDviLinkFetchOutcome({
      linkId,
      outcome: fetched.outcome,
      httpStatus: fetched.httpStatus ?? null,
      error: fetched.error ?? null,
      finalUrl: fetched.finalUrl ?? null,
      mediaUrl: fetched.mediaUrl ?? null,
    });

    // Snapshot every body we received — even expired pages — so a provider
    // format change never loses data.
    if (fetched.body) {
      try {
        await saveDviLinkSnapshot({
          linkId,
          provider: link.provider,
          url: link.url,
          finalUrl: fetched.finalUrl ?? null,
          httpStatus: fetched.httpStatus ?? null,
          contentType: fetched.contentType ?? null,
          body: fetched.body,
        });
      } catch (e: any) {
        console.warn(
          `[DviLinks] snapshot save failed for ${link.url}: ${e?.message || e}`,
        );
      }
    }

    if (fetched.outcome === "media") {
      result.media++;
    } else if (fetched.outcome === "expired") {
      result.expired++;
      console.warn(
        `[DviLinks] ${link.provider} link expired: ${link.url} (${fetched.error ?? ""})`,
      );
    } else if (fetched.outcome === "ok" && fetched.body) {
      result.ok++;
      const def = providerDef(link.provider);
      if (def.parse) {
        const parsedResult = def.parse(fetched.body, fetched.finalUrl ?? link.url);
        if (parsedResult.ok && parsedResult.report) {
          // Backstop VIN from the source work order when the report lacks one.
          if (!parsedResult.report.vin && link.vin) {
            parsedResult.report.vin = link.vin;
          }
          await recordDviLinkParseResult(linkId, {
            ok: true,
            report: parsedResult.report,
          });
          result.parsed++;
        } else {
          await recordDviLinkParseResult(linkId, {
            ok: false,
            error: parsedResult.error ?? "unknown parse failure",
          });
          result.failed++;
          console.warn(
            `[DviLinks] PARSE FAILED (${link.provider}) ${link.url}: ${parsedResult.error}`,
          );
        }
      } else {
        await recordDviLinkParseResult(linkId, {
          ok: false,
          error: "no parser registered",
        });
      }
    } else {
      result.failed++;
      console.warn(
        `[DviLinks] fetch ${fetched.outcome} (${link.provider}) ${link.url}: ${fetched.error ?? ""}`,
      );
    }

    if (result.processed < pending.length) {
      await new Promise((r) => setTimeout(r, FETCH_SPACING_MS));
    }
  }

  if (result.processed > 0) {
    console.log(
      `[DviLinks] fetch pass: processed=${result.processed} ok=${result.ok} parsed=${result.parsed} media=${result.media} expired=${result.expired} failed=${result.failed}`,
    );
  }
  return result;
}
