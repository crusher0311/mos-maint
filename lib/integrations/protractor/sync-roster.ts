/**
 * Protractor roster sync — Task #635.
 *
 * Mirrors lib/integrations/tekmetric/sync-roster.ts for Protractor-connected
 * shops: periodically refreshes a shop's *upcoming* appointments (forward
 * window only) and *current* employee roster into the same normalized PG tables
 * so the Settings → Integrations "Data Status" panel shows a real count +
 * freshness for Appointments and Employees instead of "Not synced to MOS".
 *
 * Same design contract as the Tekmetric version:
 *   - Writes directly to PG via drizzle `getDb()` with `onConflictDoUpdate` on
 *     the `(shop_id, source_id)` unique index, so a re-run UPDATEs in place
 *     (idempotent) and `updated_at` always reflects the last sync — which is
 *     exactly what the panel's freshness badge reads.
 *   - Does NOT touch the WO-centric dual-write machinery: there is no historical
 *     backfill and no Mongo legacy for these two entities.
 *   - After a *fully successful* fetch it prunes rows no longer present upstream
 *     (past/cancelled appointments that fell out of the forward window,
 *     employees removed from the roster). Pruning is skipped on a partial/failed
 *     fetch so good rows are never wiped.
 *
 * Protractor specifics vs Tekmetric:
 *   - Appointments are WorkOrders of `Type === "Appointment"` (see
 *     getProtractorAppointments). Their natural id is the WorkOrder `ID` (GUID).
 *   - The provider's date filtering on `/WorkOrder` isn't reliable, so the
 *     forward window is enforced client-side by `ScheduledTime`.
 *   - Employees come from the `/Employee` resource; field naming varies, so the
 *     normalization here is defensive.
 *
 * `shopId` is the MOS shop id (the integer `shop_id` stored in the normalized
 * tables) which is also the id Protractor's adapter resolves config from.
 */
import { and, eq, notInArray } from "drizzle-orm";
import { getDb } from "@/lib/db/drizzle";
import {
  normalizedAppointments,
  normalizedEmployees,
} from "@/lib/db/schema/normalized";
import {
  getProtractorAppointments,
  getProtractorEmployees,
  type ProtractorEmployee,
} from "./client";
import type { ProtractorWorkOrder } from "./client";

// Forward window for "upcoming" appointments. Start slightly in the past so
// in-progress / same-day appointments aren't missed, and look ~90 days ahead.
const APPOINTMENT_LOOKBACK_HOURS = 12;
const APPOINTMENT_LOOKAHEAD_DAYS = 90;
const PAGE_SIZE = 100;
const MAX_PAGES = 50; // Safety cap (≤ 5000 rows/entity/shop) — rosters are small.

export interface ProtractorRosterSyncResult {
  shopId: number;
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

async function syncAppointments(
  shopId: number,
  enterpriseId: string | null,
): Promise<{ fetched: number; pruned: number; complete: boolean }> {
  const now = new Date();
  const start = new Date(now.getTime() - APPOINTMENT_LOOKBACK_HOURS * 3600_000);
  const end = new Date(
    now.getTime() + APPOINTMENT_LOOKAHEAD_DAYS * 24 * 3600_000,
  );

  // Page through all appointments. Protractor's `/WorkOrder` date filtering is
  // unreliable, so we pass the window AND filter client-side by ScheduledTime.
  const items: ProtractorWorkOrder[] = [];
  let complete = false;
  for (let page = 0; page < MAX_PAGES; page++) {
    const res = await getProtractorAppointments(shopId, {
      startDate: start.toISOString(),
      endDate: end.toISOString(),
      skip: page * PAGE_SIZE,
      top: PAGE_SIZE,
    });
    if (!res.ok) {
      throw new Error(res.error || "Failed to fetch Protractor appointments");
    }
    const content = res.appointments ?? [];
    items.push(...content);
    if (content.length < PAGE_SIZE) {
      complete = true;
      break;
    }
  }

  // Enforce the forward window client-side: keep only appointments whose
  // scheduled time falls within [start, end]. Drop ones without a date.
  const upcoming = items.filter((wo) => {
    const d = toDate(wo.ScheduledTime);
    return d !== null && d.getTime() >= start.getTime() && d.getTime() <= end.getTime();
  });

  const db = getDb();
  const seen: string[] = [];

  for (const wo of upcoming) {
    const sourceId = String(wo.ID);
    seen.push(sourceId);

    const provenance = {
      sourceSystem: "protractor",
      sourceIds: [
        {
          system: "protractor",
          idType: "appointmentId",
          idValue: sourceId,
          isPrimary: true,
        },
      ],
      lastSyncedAt: now.toISOString(),
    };

    const customerId = wo.Contact?.ID ?? wo.ContactID ?? null;
    const vehicleId = wo.ServiceItem?.ID ?? wo.ServiceItemID ?? null;

    const row = {
      enterpriseId,
      shopId,
      provenance,
      sourceId,
      appointmentNumber:
        wo.WorkOrderNumber != null ? String(wo.WorkOrderNumber) : null,
      customerId: customerId != null ? String(customerId) : null,
      vehicleId: vehicleId != null ? String(vehicleId) : null,
      repairOrderId: null,
      status: wo.Status ?? wo.WorkflowStage ?? null,
      appointmentType: wo.Type ?? null,
      scheduledDate: toDate(wo.ScheduledTime),
      endDate: toDate(wo.PromisedTime),
      title: null,
      description: null,
      color: null,
      rawData: wo as unknown,
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
          appointmentNumber: row.appointmentNumber,
          customerId: row.customerId,
          vehicleId: row.vehicleId,
          repairOrderId: row.repairOrderId,
          status: row.status,
          appointmentType: row.appointmentType,
          scheduledDate: row.scheduledDate,
          endDate: row.endDate,
          rawData: row.rawData,
          updatedAt: now,
        } as Partial<typeof normalizedAppointments.$inferInsert>,
      });
  }

  // Prune appointments that fell out of the forward window (past/cancelled),
  // but only when we know we saw the full upstream set this run. A shop has a
  // single connected provider, so deleting by (shopId, NOT IN seen) — same as
  // the Tekmetric sync — only ever removes this provider's stale rows.
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

  return { fetched: upcoming.length, pruned, complete };
}

function isActiveEmployee(emp: ProtractorEmployee): boolean {
  if (emp.Active === false || emp.IsActive === false) return false;
  if (typeof emp.Status === "string" && emp.Status.toLowerCase() === "inactive") {
    return false;
  }
  return true;
}

async function syncEmployees(
  shopId: number,
  enterpriseId: string | null,
): Promise<{ fetched: number; pruned: number; complete: boolean }> {
  const now = new Date();

  const items: ProtractorEmployee[] = [];
  let complete = false;
  for (let page = 0; page < MAX_PAGES; page++) {
    const res = await getProtractorEmployees(shopId, {
      skip: page * PAGE_SIZE,
      top: PAGE_SIZE,
    });
    if (!res.ok) {
      throw new Error(res.error || "Failed to fetch Protractor employees");
    }
    const content = res.employees ?? [];
    items.push(...content);
    if (content.length < PAGE_SIZE) {
      complete = true;
      break;
    }
  }

  // "Current roster only" — drop anything marked inactive.
  const active = items.filter(isActiveEmployee);

  const db = getDb();
  const seen: string[] = [];

  for (const emp of active) {
    const sourceId = String(emp.ID);
    if (!sourceId || sourceId === "undefined") continue;
    seen.push(sourceId);

    const firstName = emp.Name?.FirstName ?? emp.FirstName ?? null;
    const lastName = emp.Name?.LastName ?? emp.LastName ?? null;
    const role = emp.Role ?? emp.Type ?? emp.Position ?? null;

    const provenance = {
      sourceSystem: "protractor",
      sourceIds: [
        {
          system: "protractor",
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
      firstName,
      lastName,
      fullName: fullName(firstName, lastName) ?? emp.FileAs ?? null,
      email: emp.Email ?? emp.EmailAddress ?? null,
      phone: emp.Phone ?? emp.Phone1 ?? null,
      role,
      isActive: true,
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
 * Sync one Protractor shop's upcoming appointments + current employee roster.
 * Each entity is wrapped independently so a failure on one doesn't sink the
 * other, and the whole thing never throws — callers (the cron) get a result
 * with `errors`.
 */
export async function syncProtractorRoster(
  shopId: number,
  enterpriseId: string | null = null,
): Promise<ProtractorRosterSyncResult> {
  const result: ProtractorRosterSyncResult = {
    shopId,
    appointments: { fetched: 0, pruned: 0, complete: false },
    employees: { fetched: 0, pruned: 0, complete: false },
    errors: [],
  };

  try {
    result.appointments = await syncAppointments(shopId, enterpriseId);
  } catch (err) {
    result.errors.push(
      `appointments: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  try {
    result.employees = await syncEmployees(shopId, enterpriseId);
  } catch (err) {
    result.errors.push(
      `employees: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  return result;
}
