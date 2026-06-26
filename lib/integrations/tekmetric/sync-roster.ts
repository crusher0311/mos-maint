/**
 * Tekmetric roster sync — Task #632.
 *
 * Periodically mirrors a shop's *upcoming* appointments (forward window only)
 * and *current* employee roster into the normalized PG layer so the
 * Settings → Integrations "Data Status" panel can show a real count + freshness
 * for Appointments and Employees instead of "Not synced to MOS".
 *
 * Deliberately self-contained:
 *   - Writes directly to PG via drizzle `getDb()` with `onConflictDoUpdate` on
 *     the `(shop_id, source_id)` unique index, so a re-run UPDATEs in place
 *     (idempotent) and `updated_at` always reflects the last sync — which is
 *     exactly what the panel's freshness badge reads.
 *   - Does NOT touch the WO-centric `SupabaseDualWriter` or the Mongo
 *     dual-write machinery: there is no historical backfill and no Mongo legacy
 *     for these two entities, so that weight isn't needed.
 *   - After a *fully successful* fetch it prunes rows no longer present
 *     upstream (past/cancelled appointments that fell out of the forward
 *     window, employees removed from the roster) so the count stays "current".
 *     Pruning is skipped on a partial/failed fetch to avoid wiping good rows.
 *
 * `shopId` here is the MOS shop id (the integer `shop_id` stored in the
 * normalized tables). `tekmetricShopId` is the Tekmetric-side shop id used as
 * the `shop=` query param against the Tekmetric API.
 */
import { and, eq, notInArray } from "drizzle-orm";
import { getDb } from "@/lib/db/drizzle";
import {
  normalizedAppointments,
  normalizedEmployees,
} from "@/lib/db/schema/normalized";
import { getAppointments, listEmployees } from "./api";
import type { TekmetricAppointment, TekmetricEmployee } from "./types";

// Forward window for "upcoming" appointments. We start slightly in the past so
// in-progress / same-day appointments aren't missed, and look ~90 days ahead.
const APPOINTMENT_LOOKBACK_HOURS = 12;
const APPOINTMENT_LOOKAHEAD_DAYS = 90;
const PAGE_SIZE = 100; // Tekmetric hard-caps page size at 100.
const MAX_PAGES = 50; // Safety cap (≤ 5000 rows/entity/shop) — rosters are small.

export interface RosterSyncResult {
  shopId: number;
  tekmetricShopId: number;
  appointments: { fetched: number; pruned: number; complete: boolean };
  employees: { fetched: number; pruned: number; complete: boolean };
  errors: string[];
}

function toDate(value?: string | null): Date | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function fullName(first?: string | null, last?: string | null): string | null {
  const name = [first, last].filter(Boolean).join(" ").trim();
  return name.length > 0 ? name : null;
}

/**
 * Fetch every page of a Tekmetric paginated endpoint, stopping at the reported
 * last page or the safety cap. Returns the accumulated content plus whether the
 * full set was retrieved (used to gate pruning).
 */
async function fetchAllPages<T>(
  fetchPage: (page: number) => Promise<{ content?: T[]; last?: boolean }>,
): Promise<{ items: T[]; complete: boolean }> {
  const items: T[] = [];
  let page = 0;
  let complete = false;
  for (; page < MAX_PAGES; page++) {
    const res = await fetchPage(page);
    const content = res?.content ?? [];
    items.push(...content);
    if (res?.last || content.length === 0) {
      complete = true;
      break;
    }
  }
  return { items, complete };
}

async function syncAppointments(
  shopId: number,
  tekmetricShopId: number,
  enterpriseId: string | null,
): Promise<{ fetched: number; pruned: number; complete: boolean }> {
  const now = new Date();
  const start = new Date(now.getTime() - APPOINTMENT_LOOKBACK_HOURS * 3600_000);
  const end = new Date(
    now.getTime() + APPOINTMENT_LOOKAHEAD_DAYS * 24 * 3600_000,
  );

  const { items, complete } = await fetchAllPages<TekmetricAppointment>(
    (page) =>
      getAppointments(tekmetricShopId, {
        startTime: start.toISOString(),
        endTime: end.toISOString(),
        page,
        size: PAGE_SIZE,
      }),
  );

  const db = getDb();
  const seen: string[] = [];

  for (const appt of items) {
    const sourceId = String(appt.id);
    seen.push(sourceId);

    const provenance = {
      sourceSystem: "tekmetric",
      sourceIds: [
        {
          system: "tekmetric",
          idType: "appointmentId",
          idValue: sourceId,
          isPrimary: true,
        },
      ],
      lastSyncedAt: now.toISOString(),
    };

    const row = {
      enterpriseId,
      shopId,
      provenance,
      sourceId,
      customerId: appt.customerId != null ? String(appt.customerId) : null,
      vehicleId: appt.vehicleId != null ? String(appt.vehicleId) : null,
      repairOrderId:
        appt.repairOrderId != null ? String(appt.repairOrderId) : null,
      status: appt.status ?? null,
      appointmentType: appt.appointmentType ?? appt.type ?? null,
      scheduledDate: toDate(appt.startTime),
      endDate: toDate(appt.endTime),
      title: appt.title ?? null,
      description: appt.note ?? appt.notes ?? null,
      color: appt.color ?? null,
      rawData: appt as unknown,
      updatedAt: now,
    };

    await db
      .insert(normalizedAppointments)
      .values(row as typeof normalizedAppointments.$inferInsert)
      .onConflictDoUpdate({
        target: [
          normalizedAppointments.shopId,
          normalizedAppointments.sourceId,
        ],
        set: {
          provenance,
          customerId: row.customerId,
          vehicleId: row.vehicleId,
          repairOrderId: row.repairOrderId,
          status: row.status,
          appointmentType: row.appointmentType,
          scheduledDate: row.scheduledDate,
          endDate: row.endDate,
          title: row.title,
          description: row.description,
          color: row.color,
          rawData: row.rawData,
          updatedAt: now,
        } as Partial<typeof normalizedAppointments.$inferInsert>,
      });
  }

  // Prune appointments that fell out of the forward window (past/cancelled),
  // but only when we know we saw the full upstream set this run.
  let pruned = 0;
  if (complete) {
    const result =
      seen.length > 0
        ? await db
            .delete(normalizedAppointments)
            .where(
              and(
                eq(normalizedAppointments.shopId, shopId),
                notInArray(normalizedAppointments.sourceId, seen),
              ),
            )
        : await db
            .delete(normalizedAppointments)
            .where(eq(normalizedAppointments.shopId, shopId));
    pruned = (result as { count?: number })?.count ?? 0;
  }

  return { fetched: items.length, pruned, complete };
}

async function syncEmployees(
  shopId: number,
  tekmetricShopId: number,
  enterpriseId: string | null,
): Promise<{ fetched: number; pruned: number; complete: boolean }> {
  const now = new Date();

  const { items, complete } = await fetchAllPages<TekmetricEmployee>((page) =>
    listEmployees(tekmetricShopId, { page, size: PAGE_SIZE }),
  );

  // "Current roster only" — drop anything Tekmetric marks deleted.
  const active = items.filter((e) => !e.deletedDate);

  const db = getDb();
  const seen: string[] = [];

  for (const emp of active) {
    const sourceId = String(emp.id);
    seen.push(sourceId);

    const provenance = {
      sourceSystem: "tekmetric",
      sourceIds: [
        {
          system: "tekmetric",
          idType: "employeeId",
          idValue: sourceId,
          isPrimary: true,
        },
      ],
      lastSyncedAt: now.toISOString(),
    };

    const row = {
      enterpriseId,
      shopId,
      provenance,
      sourceId,
      firstName: emp.firstName ?? null,
      lastName: emp.lastName ?? null,
      fullName: fullName(emp.firstName, emp.lastName),
      email: emp.email ?? null,
      phone: emp.phone ?? null,
      role: emp.role ?? emp.type ?? null,
      isActive: emp.active !== false,
      rawData: emp as unknown,
      updatedAt: now,
    };

    await db
      .insert(normalizedEmployees)
      .values(row as typeof normalizedEmployees.$inferInsert)
      .onConflictDoUpdate({
        target: [normalizedEmployees.shopId, normalizedEmployees.sourceId],
        set: {
          provenance,
          firstName: row.firstName,
          lastName: row.lastName,
          fullName: row.fullName,
          email: row.email,
          phone: row.phone,
          role: row.role,
          isActive: row.isActive,
          rawData: row.rawData,
          updatedAt: now,
        } as Partial<typeof normalizedEmployees.$inferInsert>,
      });
  }

  let pruned = 0;
  if (complete) {
    const result =
      seen.length > 0
        ? await db
            .delete(normalizedEmployees)
            .where(
              and(
                eq(normalizedEmployees.shopId, shopId),
                notInArray(normalizedEmployees.sourceId, seen),
              ),
            )
        : await db
            .delete(normalizedEmployees)
            .where(eq(normalizedEmployees.shopId, shopId));
    pruned = (result as { count?: number })?.count ?? 0;
  }

  return { fetched: active.length, pruned, complete };
}

/**
 * Sync one shop's upcoming appointments + current employee roster. Each entity
 * is wrapped independently so a failure on one doesn't sink the other, and the
 * whole thing never throws — callers (the cron) get a result with `errors`.
 */
export async function syncTekmetricRoster(
  shopId: number,
  tekmetricShopId: number,
  enterpriseId: string | null = null,
): Promise<RosterSyncResult> {
  const result: RosterSyncResult = {
    shopId,
    tekmetricShopId,
    appointments: { fetched: 0, pruned: 0, complete: false },
    employees: { fetched: 0, pruned: 0, complete: false },
    errors: [],
  };

  try {
    result.appointments = await syncAppointments(
      shopId,
      tekmetricShopId,
      enterpriseId,
    );
  } catch (err) {
    result.errors.push(
      `appointments: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  try {
    result.employees = await syncEmployees(
      shopId,
      tekmetricShopId,
      enterpriseId,
    );
  } catch (err) {
    result.errors.push(
      `employees: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  return result;
}
