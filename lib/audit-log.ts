// Thin re-export shim: real implementation lives in
// `lib/data/repositories/audit-logs.ts`. Kept so existing callers
// (`@/lib/audit-log`) continue to work without sweeping their imports.
export type {
  AuditAction,
  AdminAuditLogEntry as AuditLogEntry,
} from "@/lib/data/repositories/audit-logs";
export {
  logAdminAction,
  getAdminAuditLogs as getAuditLogs,
  getAdminAuditLogsCursor as getAuditLogsCursor,
} from "@/lib/data/repositories/audit-logs";
