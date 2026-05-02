import type { Filter, FindCursor, WithId } from "mongodb";
import { getDb } from "./mongo";

export type AuditAction = 
  | "impersonation"
  | "shop_unlock"
  | "shop_lock"
  | "user_password_reset"
  | "user_password_changed_after_force_reset"
  | "billing_override"
  | "feature_toggle"
  | "shop_settings_change"
  | "user_role_change"
  | "api_key_view"
  | "data_export"
  | "build_ro_from_vhi"
  | "billing_settings_change";

export interface AuditLogEntry {
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

export async function logAdminAction(entry: Omit<AuditLogEntry, "createdAt">): Promise<void> {
  try {
    const db = await getDb();
    await db.collection("admin_audit_logs").insertOne({
      ...entry,
      createdAt: new Date()
    });
    console.log(`[Audit] ${entry.adminEmail} performed ${entry.action}${entry.targetShopId ? ` on shop ${entry.targetShopId}` : ""}`);
  } catch (err) {
    console.error("[Audit] Failed to log admin action:", err);
  }
}

export async function getAuditLogs(options: {
  adminEmail?: string;
  action?: AuditAction;
  targetShopId?: number | string;
  since?: Date;
  limit?: number;
}): Promise<AuditLogEntry[]> {
  try {
    const db = await getDb();
    const query: any = {};
    
    if (options.adminEmail) query.adminEmail = options.adminEmail;
    if (options.action) query.action = options.action;
    if (options.targetShopId) query.targetShopId = options.targetShopId;
    if (options.since) query.createdAt = { $gte: options.since };
    
    const logs = await db.collection("admin_audit_logs")
      .find(query)
      .sort({ createdAt: -1 })
      .limit(options.limit || 100)
      .toArray();
    
    return logs as unknown as AuditLogEntry[];
  } catch (err) {
    console.error("[Audit] Failed to get audit logs:", err);
    return [];
  }
}

export async function getAuditLogsCursor(options: {
  adminEmail?: string;
  action?: AuditAction;
  targetShopId?: number | string;
  since?: Date;
  batchSize?: number;
}): Promise<FindCursor<WithId<AuditLogEntry>>> {
  const db = await getDb();
  const query: Filter<AuditLogEntry> = {};

  if (options.adminEmail) query.adminEmail = options.adminEmail;
  if (options.action) query.action = options.action;
  if (options.targetShopId !== undefined) query.targetShopId = options.targetShopId;
  if (options.since) query.createdAt = { $gte: options.since };

  return db
    .collection<AuditLogEntry>("admin_audit_logs")
    .find(query)
    .sort({ createdAt: -1 })
    .batchSize(options.batchSize ?? 200);
}
