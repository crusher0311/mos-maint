// Repository for the `audit_logs` and `admin_audit_logs` collections.
//
// Two separate collections live here because the legacy code already
// treats them as a tightly-coupled pair: route handlers write
// human-readable bulk-action records into `audit_logs`, while
// `lib/audit-log.ts` writes structured admin actions into
// `admin_audit_logs`. The repository provides a narrow API so callers
// don't need raw `getDb()`.
import type {
  Collection,
  Document,
  Filter,
  FindCursor,
  WithId,
} from "mongodb";
import { getDb } from "@/lib/data/db";

const AUDIT_LOGS = "audit_logs";
const ADMIN_AUDIT_LOGS = "admin_audit_logs";

export type AuditAction =
  | "impersonation"
  | "shop_unlock"
  | "shop_lock"
  | "user_password_reset"
  | "user_password_changed_after_force_reset"
  | "user_created"
  | "billing_override"
  | "feature_toggle"
  | "shop_settings_change"
  | "user_role_change"
  | "api_key_view"
  | "data_export"
  | "build_ro_from_vhi"
  | "billing_settings_change"
  | "dvi_best_practice_change";

export interface AdminAuditLogEntry {
  action: AuditAction;
  adminEmail: string;
  targetShopId?: number | string;
  targetShopName?: string;
  targetUserEmail?: string;
  details?: Record<string, any>;
  ipAddress?: string;
  userAgent?: string;
  createdAt: Date;
}

async function auditLogsCollection(): Promise<Collection<Document>> {
  const db = await getDb();
  return db.collection(AUDIT_LOGS);
}

async function adminAuditLogsCollection(): Promise<Collection<AdminAuditLogEntry>> {
  const db = await getDb();
  return db.collection<AdminAuditLogEntry>(ADMIN_AUDIT_LOGS);
}

/**
 * Insert one row into the legacy `audit_logs` collection. Stamps
 * `createdAt = new Date()` if the caller does not provide one.
 */
export async function insertAuditLog(
  entry: Record<string, unknown>,
): Promise<void> {
  const col = await auditLogsCollection();
  await col.insertOne({ createdAt: new Date(), ...entry });
}

/**
 * Insert one structured admin action into `admin_audit_logs`. Mirrors
 * the historic `logAdminAction` helper from `lib/audit-log.ts` —
 * swallows write errors so a logging failure can't break the caller.
 */
export async function logAdminAction(
  entry: Omit<AdminAuditLogEntry, "createdAt">,
): Promise<void> {
  try {
    const col = await adminAuditLogsCollection();
    await col.insertOne({ ...entry, createdAt: new Date() });
    console.log(
      `[Audit] ${entry.adminEmail} performed ${entry.action}${
        entry.targetShopId ? ` on shop ${entry.targetShopId}` : ""
      }`,
    );
  } catch (err) {
    console.error("[Audit] Failed to log admin action:", err);
  }
}

export interface AdminAuditLogFilter {
  adminEmail?: string;
  action?: AuditAction;
  targetShopId?: number | string;
  since?: Date;
  limit?: number;
  batchSize?: number;
}

function buildFilter(options: AdminAuditLogFilter): Filter<AdminAuditLogEntry> {
  const query: Filter<AdminAuditLogEntry> = {};
  if (options.adminEmail) query.adminEmail = options.adminEmail;
  if (options.action) query.action = options.action;
  if (options.targetShopId !== undefined) query.targetShopId = options.targetShopId;
  if (options.since) query.createdAt = { $gte: options.since };
  return query;
}

export async function getAdminAuditLogs(
  options: AdminAuditLogFilter,
): Promise<AdminAuditLogEntry[]> {
  try {
    const col = await adminAuditLogsCollection();
    const logs = await col
      .find(buildFilter(options))
      .sort({ createdAt: -1 })
      .limit(options.limit || 100)
      .toArray();
    return logs;
  } catch (err) {
    console.error("[Audit] Failed to get audit logs:", err);
    return [];
  }
}

export async function getAdminAuditLogsCursor(
  options: AdminAuditLogFilter,
): Promise<FindCursor<WithId<AdminAuditLogEntry>>> {
  const col = await adminAuditLogsCollection();
  return col
    .find(buildFilter(options))
    .sort({ createdAt: -1 })
    .batchSize(options.batchSize ?? 200);
}

/**
 * Run a single aggregation pipeline against `admin_audit_logs`. Used
 * by analytics endpoints that compute per-day/per-shop/per-actor
 * roll-ups that would explode the repository surface if expressed as
 * named functions for every variant.
 */
export async function aggregateAdminAuditLogs<T = Document>(
  pipeline: Document[],
): Promise<T[]> {
  const col = await adminAuditLogsCollection();
  return col.aggregate<T>(pipeline).toArray();
}

/**
 * Find recent rows in `admin_audit_logs` matching a typed filter,
 * sorted newest first. Limit defaults to 200 to mirror the analytics
 * caller that originally needed a raw `find`.
 */
export async function findRecentAdminAuditLogs(
  filter: Filter<AdminAuditLogEntry>,
  limit = 200,
): Promise<WithId<AdminAuditLogEntry>[]> {
  const col = await adminAuditLogsCollection();
  return col
    .find(filter)
    .sort({ createdAt: -1 })
    .limit(limit)
    .toArray();
}
