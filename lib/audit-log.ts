import sql from "@/lib/db/postgres";

export type AuditAction = 
  | "impersonation"
  | "shop_unlock"
  | "shop_lock"
  | "user_password_reset"
  | "billing_override"
  | "feature_toggle"
  | "shop_settings_change"
  | "user_role_change"
  | "api_key_view"
  | "data_export";

export interface AuditLogEntry {
  id?: number;
  action: AuditAction;
  adminEmail: string;
  targetShopId?: number | string;
  targetShopName?: string;
  targetUserEmail?: string;
  details?: Record<string, unknown>;
  ipAddress?: string;
  userAgent?: string;
  createdAt: Date;
}

export async function logAdminAction(entry: Omit<AuditLogEntry, "createdAt" | "id">): Promise<void> {
  try {
    const targetType = entry.targetShopId ? "shop" : entry.targetUserEmail ? "user" : null;
    const targetId = entry.targetShopId ? String(entry.targetShopId) : entry.targetUserEmail || null;
    
    await sql`
      INSERT INTO admin_audit_logs (action, admin_email, target_type, target_id, details, ip_address, user_agent)
      VALUES (
        ${entry.action}, 
        ${entry.adminEmail}, 
        ${targetType}, 
        ${targetId}, 
        ${JSON.stringify(entry.details || {})}, 
        ${entry.ipAddress || null}, 
        ${entry.userAgent || null}
      )
    `;
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
    const conditions: string[] = [];
    const values: unknown[] = [];
    
    let query = sql`
      SELECT id, action, admin_email as "adminEmail", target_type, target_id, 
             details, ip_address as "ipAddress", user_agent as "userAgent", 
             created_at as "createdAt"
      FROM admin_audit_logs
      WHERE 1=1
    `;
    
    if (options.adminEmail) {
      query = sql`${query} AND admin_email = ${options.adminEmail}`;
    }
    if (options.action) {
      query = sql`${query} AND action = ${options.action}`;
    }
    if (options.targetShopId) {
      query = sql`${query} AND target_id = ${String(options.targetShopId)}`;
    }
    if (options.since) {
      query = sql`${query} AND created_at >= ${options.since}`;
    }
    
    query = sql`${query} ORDER BY created_at DESC LIMIT ${options.limit || 100}`;
    
    const logs = await query;
    
    return logs.map((row: Record<string, unknown>) => ({
      id: row.id as number,
      action: row.action as AuditAction,
      adminEmail: row.adminEmail as string,
      targetShopId: row.target_id as string,
      details: row.details as Record<string, unknown>,
      ipAddress: row.ipAddress as string,
      userAgent: row.userAgent as string,
      createdAt: row.createdAt as Date,
    }));
  } catch (err) {
    console.error("[Audit] Failed to get audit logs:", err);
    return [];
  }
}
