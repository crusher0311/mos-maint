import "server-only";
import { getDb } from "@/lib/mongo";
import { eq, sql, type SQL } from "drizzle-orm";
import {
  normalizedCustomers,
  normalizedVehicles,
  normalizedWorkOrders,
  normalizedServiceJobs,
  normalizedAppointments,
  normalizedEmployees,
} from "@/lib/db/schema/normalized";
import {
  getLatestResyncRequest,
  type ResyncStatus,
} from "@/lib/resync-requests";

// "Data Status" — a client-facing read model that proves a shop's synced
// data is complete and continuously kept fresh (task #629). It aggregates
// the normalized Postgres tables that already back the sync-health view and
// pairs them with the shop's connected provider so a client (or a platform
// admin looking at a specific shop) can confirm at a glance that backfill +
// webhooks + crons are keeping things current.
//
// Counts/dates come from the normalized PG tables (mirroring the sync-health
// aggregation approach) rather than scanning Mongo. Each per-entity query is
// bounded by a timeout so a slow aggregate degrades to an "unknown" card
// instead of blocking the whole panel.

export type ConnectedProvider =
  | "tekmetric"
  | "protractor"
  | "shopware"
  | "shopmonkey";

export type FreshnessState = "fresh" | "aging" | "stale" | "unknown";

export type EntityKey =
  | "customers"
  | "vehicles"
  | "workOrders"
  | "serviceJobs"
  | "appointments"
  | "employees";

export interface DataStatusEntity {
  key: EntityKey;
  label: string;
  // `available: false` means this entity is not synced into MOS for the
  // connected provider — the UI renders a clear "Not synced" marker rather
  // than a misleading zero.
  available: boolean;
  // Present only when `available` is true.
  count: number | null;
  oldest: string | null;
  newest: string | null;
  lastUpdated: string | null;
  freshness: FreshnessState;
  // Short human note for unavailable / unknown states.
  note?: string | null;
}

export interface DataStatusResponse {
  shopId: number;
  connection: {
    connected: boolean;
    provider: ConnectedProvider | null;
    providerLabel: string | null;
    lastSyncAt: string | null;
  };
  entities: DataStatusEntity[];
  // Customer-requested re-sync state. `available` is true only when the
  // connected provider supports a full backfill re-trigger (Tekmetric /
  // Protractor / Shop-Ware). Reflects the latest request so the UI can show
  // "scheduled for tonight" instead of offering the button again.
  resync: {
    available: boolean;
    status: ResyncStatus | null;
    requestedAt: string | null;
    scheduledFor: string | null;
    processedAt: string | null;
  };
  generatedAt: string;
}

const PROVIDER_LABELS: Record<ConnectedProvider, string> = {
  tekmetric: "Tekmetric",
  protractor: "Protractor",
  shopware: "Shop-Ware",
  shopmonkey: "Shopmonkey",
};

// Which providers' source systems expose appointment / employee feeds.
// Only Tekmetric and Protractor have an explicit appointment + employee
// API surface in our adapter layer; Shop-Ware and Shopmonkey embed
// employee identity inside repair orders but expose no standalone feed.
// We only LIST a card for an entity the source actually provides — and
// because MOS does not yet persist appointments/employees in the
// normalized layer, those cards render as "not synced" rather than zeros.
const PROVIDER_CAPABILITIES: Record<
  ConnectedProvider,
  { appointments: boolean; employees: boolean }
> = {
  tekmetric: { appointments: true, employees: true },
  protractor: { appointments: true, employees: true },
  shopware: { appointments: false, employees: false },
  shopmonkey: { appointments: false, employees: false },
};

// Per-entity aggregate query timeout. Kept short so a heavy shop degrades to
// an "unknown" card instead of hanging the settings page.
const QUERY_TIMEOUT_MS = 7000;

function toIso(v: unknown): string | null {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(v as string);
  return Number.isFinite(d.getTime()) ? d.toISOString() : null;
}

// Freshness legend (task #629): Today / <1 day = fresh, 2–3 days = aging,
// 4+ days or missing = stale. Driven by the most-recent signal we have —
// the greater of the newest record date and the last-updated timestamp.
export function computeFreshness(
  newest: string | null,
  lastUpdated: string | null,
): FreshnessState {
  const candidates = [newest, lastUpdated]
    .map((v) => (v ? new Date(v).getTime() : NaN))
    .filter((n) => Number.isFinite(n)) as number[];
  if (candidates.length === 0) return "stale";
  const mostRecent = Math.max(...candidates);
  const ageDays = (Date.now() - mostRecent) / (24 * 60 * 60 * 1000);
  if (ageDays < 2) return "fresh";
  if (ageDays < 4) return "aging";
  return "stale";
}

function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((resolve) => setTimeout(() => resolve(fallback), ms)),
  ]);
}

type CoreTable =
  | typeof normalizedCustomers
  | typeof normalizedVehicles
  | typeof normalizedWorkOrders
  | typeof normalizedServiceJobs
  | typeof normalizedAppointments
  | typeof normalizedEmployees;

interface AggregateResult {
  count: number;
  oldest: string | null;
  newest: string | null;
  lastUpdated: string | null;
}

// Aggregate count + oldest/newest record date + last-updated for one
// normalized table, scoped to the shop. Uses the shopId index that exists
// on every normalized table. Returns null on timeout/error so the caller
// can render an "unknown" card.
//
// `oldest`/`newest` describe how far back the shop's real history goes, so
// they're driven by the entity's actual business date (e.g. a repair
// order's closed date) when one is supplied via `recordDate`. Without it
// they fall back to `createdAt`, which is only the row's MOS import
// timestamp — meaningful as "first synced", NOT as history depth. The
// `recordDate` expression should COALESCE down to `createdAt` so rows that
// lack a business date (e.g. an open RO) still contribute a value.
// `lastUpdated` always tracks `updatedAt` (the sync/webhook freshness
// signal) regardless of the record-date source.
async function aggregateEntity(
  table: CoreTable,
  shopId: number,
  recordDate?: SQL<unknown>,
): Promise<AggregateResult | null> {
  try {
    const { getDb: getPg } = await import("@/lib/db/drizzle");
    const db = getPg();

    // Run count, last-updated and the oldest/newest span as separate queries
    // rather than one combined aggregate. Postgres only uses an index to
    // answer min()/max() when the query contains *nothing but* index-backed
    // min/max aggregates — adding count(*) or a max() over a different column
    // disables that optimization and forces a full per-shop heap scan (30s+
    // on large shops, which trips QUERY_TIMEOUT_MS and shows "Checking…").
    // Split out, each part is served by its own (shop_id, …) index:
    //   • count(*)            → shop_id index
    //   • max(updatedAt)      → (shop_id, updated_at) index
    //   • min/max(recordDate) → (shop_id, <date>) index
    const countP = db
      .select({ count: sql<number>`count(*)::int` })
      .from(table)
      .where(eq(table.shopId, shopId))
      .then((rows) => rows[0]?.count ?? 0);

    const freshP = db
      .select({ lastUpdated: sql<Date | null>`max(${table.updatedAt})` })
      .from(table)
      .where(eq(table.shopId, shopId))
      .then((rows) => rows[0]?.lastUpdated ?? null);

    // Only compute the history span when the caller supplies a business date
    // (work/repair orders, service jobs). Customers and vehicles have no real
    // per-record date, so the panel borrows the repair-order span for them
    // (see withHistorySpan) — computing their createdAt min/max here would
    // only surface the MOS import timestamp and waste a scan.
    const spanP: Promise<{ oldest: Date | null; newest: Date | null }> =
      recordDate
        ? db
            .select({
              oldest: sql<Date | null>`min(${recordDate})`,
              newest: sql<Date | null>`max(${recordDate})`,
            })
            .from(table)
            .where(eq(table.shopId, shopId))
            .then((rows) => rows[0] ?? { oldest: null, newest: null })
        : Promise.resolve({ oldest: null, newest: null });

    const combined = Promise.all([countP, spanP, freshP]).then(
      ([count, span, lastUpdated]) => ({
        count: Number(count ?? 0),
        oldest: toIso(span.oldest),
        newest: toIso(span.newest),
        lastUpdated: toIso(lastUpdated),
      }),
    );

    const row = await withTimeout(combined, QUERY_TIMEOUT_MS, null);
    if (!row) return null;
    return row;
  } catch (err) {
    console.warn(
      `[DataStatus] aggregate failed for shop ${shopId}:`,
      (err as Error)?.message ?? err,
    );
    return null;
  }
}

function buildCoreEntity(
  key: EntityKey,
  label: string,
  result: AggregateResult | null,
  // Optional freshness signal that overrides `result.newest` when deciding
  // the badge. Needed for entities whose displayed `oldest/newest` is a
  // borrowed span (e.g. customers/vehicles mirroring the repair-order
  // history): the span must NOT drive freshness — only the entity's own
  // sync recency should. When omitted, the displayed `newest` is used.
  freshnessNewest?: string | null,
): DataStatusEntity {
  if (!result) {
    return {
      key,
      label,
      available: true,
      count: null,
      oldest: null,
      newest: null,
      lastUpdated: null,
      freshness: "unknown",
      note: "Counts are taking longer than usual to load.",
    };
  }
  const freshnessSignal =
    freshnessNewest !== undefined ? freshnessNewest : result.newest;
  return {
    key,
    label,
    available: true,
    count: result.count,
    oldest: result.oldest,
    newest: result.newest,
    lastUpdated: result.lastUpdated,
    freshness: computeFreshness(freshnessSignal, result.lastUpdated),
  };
}

function detectProvider(shop: any): {
  provider: ConnectedProvider | null;
  lastSyncAt: string | null;
} {
  if (!shop) return { provider: null, lastSyncAt: null };

  const configured: Record<ConnectedProvider, boolean> = {
    tekmetric: Boolean(
      shop.tekmetric?.shopId ||
        shop.tekmetric?.configured ||
        shop.tekmetricShopId,
    ),
    protractor: Boolean(
      shop.protractor?.configured ||
        shop.protractor?.connectionId ||
        shop.protractor?.apiKey ||
        shop.protractorConnectionId ||
        shop.protractorApiKey,
    ),
    shopware: Boolean(shop.shopware?.tenantId),
    shopmonkey: Boolean(shop.shopmonkey?.apiKey),
  };

  const lastSyncByProvider: Record<ConnectedProvider, string | null> = {
    tekmetric: toIso(shop.tekmetric?.lastSync ?? shop.tekmetric?.lastSyncAt),
    protractor: toIso(
      shop.protractor?.lastSyncAt ?? shop.protractor?.lastSync,
    ),
    shopware: toIso(shop.shopware?.lastSyncAt),
    shopmonkey: toIso(shop.shopmonkey?.lastSyncAt),
  };

  // An explicit `integrationProvider` on the shop wins: some connected shops
  // (e.g. Tekmetric) store their live config there with no nested
  // `*.configured` flag, so relying only on nested flags falsely reports
  // "not connected". This mirrors detectBackfillProvider so the panel's
  // connection state and the re-sync trigger always agree.
  const ip = shop.integrationProvider as string | undefined;
  if (ip && Object.prototype.hasOwnProperty.call(PROVIDER_LABELS, ip)) {
    const p = ip as ConnectedProvider;
    return { provider: p, lastSyncAt: lastSyncByProvider[p] };
  }

  // Honor the saved provider preference when it points to a configured
  // system, otherwise fall back to detection order.
  const pref = shop.smsProvider as string | undefined;
  if (
    pref &&
    pref !== "standalone" &&
    configured[pref as ConnectedProvider]
  ) {
    const p = pref as ConnectedProvider;
    return { provider: p, lastSyncAt: lastSyncByProvider[p] };
  }

  const order: ConnectedProvider[] = [
    "tekmetric",
    "protractor",
    "shopware",
    "shopmonkey",
  ];
  for (const p of order) {
    if (configured[p]) {
      return { provider: p, lastSyncAt: lastSyncByProvider[p] };
    }
  }
  return { provider: null, lastSyncAt: null };
}

export async function computeDataStatus(
  shopId: number,
): Promise<DataStatusResponse> {
  const db = await getDb();
  const shop = await db.collection("shops").findOne(
    { shopId: { $in: [shopId, String(shopId)] } },
    {
      projection: {
        integrationProvider: 1,
        smsProvider: 1,
        tekmetric: 1,
        tekmetricShopId: 1,
        protractor: 1,
        protractorConnectionId: 1,
        protractorApiKey: 1,
        shopware: 1,
        shopmonkey: 1,
      },
    },
  );

  const { provider, lastSyncAt } = detectProvider(shop);

  // Repair/work orders and service jobs carry a real business date, so the
  // panel reports true history depth from it rather than the MOS import
  // timestamp. COALESCE down to createdAt so open/in-progress records (which
  // have no closed/completed date yet) still contribute a value. Customers
  // and vehicles have no per-record business date in the synced data (the
  // source date fields come back empty), so they fall back to createdAt.
  const workOrderDate = sql<unknown>`coalesce(${normalizedWorkOrders.closedDate}, ${normalizedWorkOrders.completedDate}, ${normalizedWorkOrders.createdAt})`;
  const serviceJobDate = sql<unknown>`coalesce(${normalizedServiceJobs.completedAt}, ${normalizedServiceJobs.createdAt})`;

  const [customers, vehicles, workOrders, serviceJobs] = await Promise.all([
    aggregateEntity(normalizedCustomers, shopId),
    aggregateEntity(normalizedVehicles, shopId),
    aggregateEntity(normalizedWorkOrders, shopId, workOrderDate),
    aggregateEntity(normalizedServiceJobs, shopId, serviceJobDate),
  ]);

  // Customers and vehicles have no per-record business date in the synced
  // data (the source date fields come back empty), so the panel mirrors the
  // repair-order history span onto them — i.e. "records span <oldest RO> –
  // <newest RO>". Their own count and lastUpdated (sync freshness) are kept;
  // only the oldest/newest span is borrowed. If the work-order aggregate
  // failed/returned no dates, leave their original values untouched.
  const withHistorySpan = (
    result: AggregateResult | null,
  ): AggregateResult | null => {
    if (!result || !workOrders) return result;
    if (!workOrders.oldest && !workOrders.newest) return result;
    return { ...result, oldest: workOrders.oldest, newest: workOrders.newest };
  };
  const customersSpanned = withHistorySpan(customers);
  const vehiclesSpanned = withHistorySpan(vehicles);

  const woLabel =
    provider === "protractor" ? "Work Orders" : "Repair Orders";

  const entities: DataStatusEntity[] = [
    buildCoreEntity("customers", "Customers", customersSpanned, customers?.newest ?? null),
    buildCoreEntity("vehicles", "Vehicles", vehiclesSpanned, vehicles?.newest ?? null),
    buildCoreEntity("workOrders", woLabel, workOrders),
    buildCoreEntity("serviceJobs", "Service Jobs", serviceJobs),
  ];

  // Appointments / Employees are listed only when the connected source
  // exposes them. They are synced into the normalized layer only for
  // providers MOS actually pulls them from via the roster sync cron —
  // Tekmetric (lib/integrations/tekmetric/sync-roster.ts) and Protractor
  // (lib/integrations/protractor/sync-roster.ts). For other capable
  // providers there is no sync path yet, so they still render an explicit
  // "not synced" marker rather than zeros.
  const caps = provider ? PROVIDER_CAPABILITIES[provider] : null;
  const rosterSynced = provider === "tekmetric" || provider === "protractor";

  const notSyncedEntity = (
    key: EntityKey,
    label: string,
  ): DataStatusEntity => ({
    key,
    label,
    available: false,
    count: null,
    oldest: null,
    newest: null,
    lastUpdated: null,
    freshness: "unknown",
    note: "Not synced to MOS",
  });

  if (caps?.appointments) {
    if (rosterSynced) {
      // Appointments carry a forward-looking scheduled date, so it drives the
      // displayed oldest/newest span. Freshness must NOT come from that span
      // (those dates are in the future → always "fresh"); pass an explicit
      // null so only the row's own sync recency (lastUpdated) decides it.
      const appointments = await aggregateEntity(
        normalizedAppointments,
        shopId,
        sql<unknown>`${normalizedAppointments.scheduledDate}`,
      );
      entities.push(
        buildCoreEntity("appointments", "Appointments", appointments, null),
      );
    } else {
      entities.push(notSyncedEntity("appointments", "Appointments"));
    }
  }
  if (caps?.employees) {
    if (rosterSynced) {
      // Employees have no business date — the panel shows count + sync
      // freshness only (no history span), so no recordDate is supplied and
      // freshness is driven purely by lastUpdated.
      const employees = await aggregateEntity(normalizedEmployees, shopId);
      entities.push(
        buildCoreEntity("employees", "Employees", employees, null),
      );
    } else {
      entities.push(notSyncedEntity("employees", "Employees"));
    }
  }

  // Re-sync is only offered for providers with a full-backfill path
  // (Tekmetric / Protractor / Shop-Ware). Shopmonkey and standalone shops
  // can't be re-triggered this way, so the UI hides the button.
  const canResync =
    provider === "tekmetric" ||
    provider === "protractor" ||
    provider === "shopware";

  let resync: DataStatusResponse["resync"] = {
    available: canResync,
    status: null,
    requestedAt: null,
    scheduledFor: null,
    processedAt: null,
  };
  if (canResync) {
    try {
      const latest = await getLatestResyncRequest(db, shopId);
      if (latest) {
        resync = {
          available: true,
          status: latest.status as ResyncStatus,
          requestedAt: toIso(latest.requestedAt),
          scheduledFor: toIso(latest.scheduledFor),
          processedAt: toIso(latest.processedAt),
        };
      }
    } catch (err) {
      console.warn(
        `[DataStatus] resync lookup failed for shop ${shopId}:`,
        (err as Error)?.message ?? err,
      );
    }
  }

  return {
    shopId,
    connection: {
      connected: provider !== null,
      provider,
      providerLabel: provider ? PROVIDER_LABELS[provider] : null,
      lastSyncAt,
    },
    entities,
    resync,
    generatedAt: new Date().toISOString(),
  };
}
