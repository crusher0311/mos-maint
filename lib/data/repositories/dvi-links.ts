// Task #860: repositories for DVI share-link ingestion.
//
// Two collections:
//   dvi_links          — link registry: one doc per detected share link
//                        (dedup key = provider + normalized URL), fetch/parse
//                        status, and the parsed inspection record.
//   dvi_link_snapshots — raw response snapshots keyed by link + fetch time
//                        (gzipped), so a provider page-format change never
//                        loses data.
import { gzipSync, gunzipSync } from "node:zlib";
import type { Collection, Document, ObjectId } from "mongodb";
import { Binary } from "mongodb";
import { getDb } from "@/lib/data/db";
import type {
  DviFetchOutcome,
  DviLinkProvider,
  DviParseStatus,
  ParsedDviReport,
} from "@/lib/dvi-links/types";
import { normalizeDviLinkKey } from "@/lib/dvi-links/extract";

const LINKS_COLLECTION = "dvi_links";
const SNAPSHOTS_COLLECTION = "dvi_link_snapshots";

/** Terminal fetch statuses — no further fetch attempts. */
export const TERMINAL_FETCH_STATUSES: ReadonlyArray<string> = [
  "ok",
  "expired",
  "media",
];

/** Error/blocked links are retried up to this many times, then marked expired. */
export const MAX_FETCH_ATTEMPTS = 3;

export interface DviLinkDoc extends Document {
  _id?: ObjectId;
  provider: DviLinkProvider;
  url: string;
  /** Dedup key: host + path + query (lowercased host). */
  urlKey: string;
  shopId: string; // stored as string, matching repo convention
  vin?: string | null; // VIN from the source work order (uppercased)
  workOrderNumber?: string | null;
  sourceProvider?: string | null; // SMS the link came from ("protractor")
  discoveredAt: Date;
  fetchStatus: "pending" | DviFetchOutcome;
  fetchAttempts: number;
  lastFetchAt?: Date | null;
  lastFetchHttpStatus?: number | null;
  lastFetchError?: string | null;
  finalUrl?: string | null;
  mediaUrl?: string | null;
  parseStatus: DviParseStatus;
  parseError?: string | null;
  parsedAt?: Date | null;
  report?: ParsedDviReport | null;
  updatedAt: Date;
  createdAt: Date;
}

export interface DviLinkSnapshotDoc extends Document {
  linkId: ObjectId;
  provider: DviLinkProvider;
  url: string;
  finalUrl?: string | null;
  fetchedAt: Date;
  httpStatus?: number | null;
  contentType?: string | null;
  bytes: number;
  encoding: "gzip";
  body: Binary;
}

async function linksCollection(): Promise<Collection<DviLinkDoc>> {
  const db = await getDb();
  return db.collection<DviLinkDoc>(LINKS_COLLECTION);
}

async function snapshotsCollection(): Promise<Collection<DviLinkSnapshotDoc>> {
  const db = await getDb();
  return db.collection<DviLinkSnapshotDoc>(SNAPSHOTS_COLLECTION);
}

export interface RegisterDviLinkInput {
  provider: DviLinkProvider;
  url: string;
  shopId: string;
  vin?: string | null;
  workOrderNumber?: string | null;
  sourceProvider?: string | null;
}

/**
 * Registers a detected link (idempotent per shop + urlKey). Returns true
 * when the link is new.
 */
export async function registerDviLink(
  input: RegisterDviLinkInput,
): Promise<boolean> {
  const col = await linksCollection();
  const now = new Date();
  const urlKey = normalizeDviLinkKey(input.url);
  const res = await col.updateOne(
    { shopId: input.shopId, urlKey },
    {
      $set: {
        updatedAt: now,
        ...(input.vin ? { vin: input.vin.toUpperCase() } : {}),
        ...(input.workOrderNumber
          ? { workOrderNumber: String(input.workOrderNumber) }
          : {}),
      },
      $setOnInsert: {
        provider: input.provider,
        url: input.url,
        urlKey,
        shopId: input.shopId,
        sourceProvider: input.sourceProvider ?? null,
        discoveredAt: now,
        fetchStatus: "pending",
        fetchAttempts: 0,
        parseStatus: "pending",
        createdAt: now,
      },
    },
    { upsert: true },
  );
  return res.upsertedCount > 0;
}

/** Links awaiting fetch (pending, or retryable error/blocked under the attempt cap). */
export async function findFetchableDviLinks(limit: number): Promise<DviLinkDoc[]> {
  const col = await linksCollection();
  return col
    .find({
      $or: [
        { fetchStatus: "pending" },
        {
          fetchStatus: { $in: ["error", "blocked"] },
          fetchAttempts: { $lt: MAX_FETCH_ATTEMPTS },
        },
      ],
    })
    .sort({ discoveredAt: 1 })
    .limit(limit)
    .toArray();
}

export interface RecordFetchOutcomeInput {
  linkId: ObjectId;
  outcome: DviFetchOutcome;
  httpStatus?: number | null;
  error?: string | null;
  finalUrl?: string | null;
  mediaUrl?: string | null;
}

export async function recordDviLinkFetchOutcome(
  input: RecordFetchOutcomeInput,
): Promise<void> {
  const col = await linksCollection();
  const now = new Date();
  const doc = await col.findOne({ _id: input.linkId }, { projection: { fetchAttempts: 1 } });
  const attempts = (doc?.fetchAttempts ?? 0) + 1;
  // After MAX_FETCH_ATTEMPTS failed tries, record the terminal state loudly
  // instead of retrying forever (links expire — task spec).
  const exhausted =
    (input.outcome === "error" || input.outcome === "blocked") &&
    attempts >= MAX_FETCH_ATTEMPTS;
  await col.updateOne(
    { _id: input.linkId },
    {
      $set: {
        fetchStatus: exhausted ? "expired" : input.outcome,
        lastFetchAt: now,
        lastFetchHttpStatus: input.httpStatus ?? null,
        lastFetchError: exhausted
          ? `${input.error ?? "fetch failed"} (gave up after ${attempts} attempts)`
          : (input.error ?? null),
        finalUrl: input.finalUrl ?? null,
        ...(input.mediaUrl ? { mediaUrl: input.mediaUrl } : {}),
        ...(input.outcome === "media" ? { parseStatus: "na" as const } : {}),
        ...(input.outcome === "expired" || exhausted
          ? { parseStatus: "na" as const }
          : {}),
        updatedAt: now,
      },
      $inc: { fetchAttempts: 1 },
    },
  );
}

export async function recordDviLinkParseResult(
  linkId: ObjectId,
  result:
    | { ok: true; report: ParsedDviReport }
    | { ok: false; error: string },
): Promise<void> {
  const col = await linksCollection();
  const now = new Date();
  if (result.ok) {
    const vin = result.report.vin ?? null;
    await col.updateOne(
      { _id: linkId },
      {
        $set: {
          parseStatus: "parsed",
          parseError: null,
          parsedAt: now,
          report: result.report,
          ...(vin ? { vin } : {}),
          ...(result.report.roNumber
            ? { workOrderNumber: String(result.report.roNumber) }
            : {}),
          updatedAt: now,
        },
      },
    );
  } else {
    await col.updateOne(
      { _id: linkId },
      {
        $set: {
          parseStatus: "failed",
          parseError: result.error,
          parsedAt: now,
          updatedAt: now,
        },
      },
    );
  }
}

export async function saveDviLinkSnapshot(input: {
  linkId: ObjectId;
  provider: DviLinkProvider;
  url: string;
  finalUrl?: string | null;
  httpStatus?: number | null;
  contentType?: string | null;
  body: string;
}): Promise<void> {
  const col = await snapshotsCollection();
  const gz = gzipSync(Buffer.from(input.body, "utf8"));
  await col.insertOne({
    linkId: input.linkId,
    provider: input.provider,
    url: input.url,
    finalUrl: input.finalUrl ?? null,
    fetchedAt: new Date(),
    httpStatus: input.httpStatus ?? null,
    contentType: input.contentType ?? null,
    bytes: gz.length,
    encoding: "gzip",
    body: new Binary(gz),
  } as DviLinkSnapshotDoc);
}

export function decodeDviLinkSnapshot(doc: DviLinkSnapshotDoc): string {
  const buf = Buffer.isBuffer(doc.body)
    ? doc.body
    : Buffer.from(doc.body.buffer);
  return gunzipSync(buf).toString("utf8");
}

/** Parsed reports for a shop + VIN, newest inspection first. */
export async function findParsedDviReportsByVin(
  shopId: string,
  vin: string,
  limit = 5,
): Promise<DviLinkDoc[]> {
  const col = await linksCollection();
  return col
    .find({
      shopId,
      vin: vin.toUpperCase(),
      parseStatus: "parsed",
      report: { $ne: null },
    })
    .sort({ parsedAt: -1 })
    .limit(limit)
    .toArray();
}

export interface DviProviderHealthRow {
  provider: DviLinkProvider;
  discovered: number;
  pending: number;
  fetchedOk: number;
  media: number;
  expired: number;
  blocked: number;
  error: number;
  parsed: number;
  parseFailed: number;
  lastDiscoveredAt: Date | null;
  lastParsedAt: Date | null;
}

/** Per-provider ingestion health counters for the platform-admin page. */
export async function aggregateDviLinkHealth(): Promise<DviProviderHealthRow[]> {
  const col = await linksCollection();
  const rows = await col
    .aggregate([
      {
        $group: {
          _id: "$provider",
          discovered: { $sum: 1 },
          pending: {
            $sum: { $cond: [{ $eq: ["$fetchStatus", "pending"] }, 1, 0] },
          },
          fetchedOk: { $sum: { $cond: [{ $eq: ["$fetchStatus", "ok"] }, 1, 0] } },
          media: { $sum: { $cond: [{ $eq: ["$fetchStatus", "media"] }, 1, 0] } },
          expired: {
            $sum: { $cond: [{ $eq: ["$fetchStatus", "expired"] }, 1, 0] },
          },
          blocked: {
            $sum: { $cond: [{ $eq: ["$fetchStatus", "blocked"] }, 1, 0] },
          },
          error: { $sum: { $cond: [{ $eq: ["$fetchStatus", "error"] }, 1, 0] } },
          parsed: {
            $sum: { $cond: [{ $eq: ["$parseStatus", "parsed"] }, 1, 0] },
          },
          parseFailed: {
            $sum: { $cond: [{ $eq: ["$parseStatus", "failed"] }, 1, 0] },
          },
          lastDiscoveredAt: { $max: "$discoveredAt" },
          lastParsedAt: { $max: "$parsedAt" },
        },
      },
      { $sort: { discovered: -1 } },
    ])
    .toArray();
  return rows.map((r: any) => ({
    provider: r._id,
    discovered: r.discovered,
    pending: r.pending,
    fetchedOk: r.fetchedOk,
    media: r.media,
    expired: r.expired,
    blocked: r.blocked,
    error: r.error,
    parsed: r.parsed,
    parseFailed: r.parseFailed,
    lastDiscoveredAt: r.lastDiscoveredAt ?? null,
    lastParsedAt: r.lastParsedAt ?? null,
  }));
}

/** Recent failures for the admin page (parse failures + fetch errors). */
export async function findRecentDviLinkFailures(limit = 50): Promise<DviLinkDoc[]> {
  const col = await linksCollection();
  return col
    .find({
      $or: [
        { parseStatus: "failed" },
        { fetchStatus: { $in: ["error", "blocked"] } },
      ],
    })
    .sort({ updatedAt: -1 })
    .limit(limit)
    .project<DviLinkDoc>({ report: 0 })
    .toArray();
}

/** Recent links for the admin page listing. */
export async function findRecentDviLinks(limit = 100): Promise<DviLinkDoc[]> {
  const col = await linksCollection();
  return col
    .find({})
    .sort({ discoveredAt: -1 })
    .limit(limit)
    .project<DviLinkDoc>({ "report.items": 0 })
    .toArray();
}

/** Ensures indexes (called from the operator sweep script, not at runtime). */
export async function ensureDviLinkIndexes(): Promise<void> {
  const links = await linksCollection();
  await links.createIndex({ shopId: 1, urlKey: 1 }, { unique: true });
  await links.createIndex({ fetchStatus: 1, discoveredAt: 1 });
  await links.createIndex({ shopId: 1, vin: 1, parseStatus: 1 });
  await links.createIndex({ provider: 1, updatedAt: -1 });
  const snaps = await snapshotsCollection();
  await snaps.createIndex({ linkId: 1, fetchedAt: -1 });
}
