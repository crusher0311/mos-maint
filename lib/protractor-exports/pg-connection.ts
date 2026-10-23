import postgres from "postgres";
import type { ExportSql } from "./pg-store";

/** Export control state never uses DATAONE_DATABASE_URL or DATABASE_URL.
 * Raw-source and identity repositories deliberately keep their existing clients. */
export function exportDatabaseConfiguration(env: Record<string, string | undefined>) {
  const connection = env.PROTRACTOR_EXPORT_DATABASE_URL;
  const role = env.PROTRACTOR_EXPORT_DATABASE_ROLE;
  if (!connection || !role || !/^[a-z][a-z0-9_]{2,62}$/.test(role) ||
      ["postgres", "anon", "authenticated", "service_role"].includes(role))
    throw new Error("export_database_configuration_required");
  try {
    const url = new URL(connection);
    if (!["postgres:", "postgresql:"].includes(url.protocol) || !url.hostname ||
        !url.pathname || url.pathname === "/" || url.searchParams.has("options") ||
        decodeURIComponent(url.username).split(".")[0] !== role)
      throw new Error();
  } catch { throw new Error("export_database_configuration_invalid"); }
  return { connection, role };
}

/** Check the authenticated database role, not just the username in the URL.
 * No SET ROLE, implicit ownership, or inherited broad-role workaround. */
export async function assertExportRuntime(sql: ExportSql, expectedRole: string) {
  const rows = await sql.unsafe(`SELECT current_user AS role,session_user AS login,
    r.rolsuper OR r.rolbypassrls OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication AS elevated,
    EXISTS(SELECT 1 FROM pg_auth_members m WHERE m.member=r.oid) AS memberships,
    has_database_privilege(current_database(),'CREATE') AS database_create,
    EXISTS(SELECT 1 FROM pg_namespace n WHERE n.nspname='protractor_export'
      AND (n.nspowner=r.oid OR has_schema_privilege(n.oid,'CREATE'))) AS schema_create,
    EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='protractor_export' AND c.relowner=r.oid) AS owns_objects,
    EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='protractor_export' AND c.relname='schema_version'
      AND (has_table_privilege(c.oid,'INSERT') OR has_table_privilege(c.oid,'UPDATE')
        OR has_table_privilege(c.oid,'DELETE') OR has_table_privilege(c.oid,'TRUNCATE'))) AS marker_write
    ,EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='protractor_export' AND c.relkind='r'
      AND (has_table_privilege(c.oid,'TRUNCATE') OR has_table_privilege(c.oid,'TRIGGER')
        OR has_table_privilege(c.oid,'REFERENCES') OR has_table_privilege(c.oid,'SELECT WITH GRANT OPTION')
        OR has_table_privilege(c.oid,'INSERT WITH GRANT OPTION')
        OR has_table_privilege(c.oid,'UPDATE WITH GRANT OPTION')
        OR has_table_privilege(c.oid,'DELETE WITH GRANT OPTION'))) AS excess_grants
    FROM pg_roles r WHERE r.rolname=current_user`);
  const row = rows[0];
  if (!row || row.role !== expectedRole || row.login !== expectedRole ||
      row.elevated || row.memberships || row.database_create || row.schema_create ||
      row.owns_objects || row.marker_write || row.excess_grants)
    throw new Error("export_database_role_not_restricted");
}

export function createExportDatabase(
  env: Record<string, string | undefined>,
  factory: typeof postgres = postgres,
) {
  // Validate before creating a pool. No connection is made at module import.
  const { connection, role } = exportDatabaseConfiguration(env);
  const client = factory(connection, { max: 2, idle_timeout: 20, connect_timeout: 5,
    ssl: "require", onnotice: () => {},
    connection: { application_name: "protractor-export-state",
      statement_timeout: 5000, lock_timeout: 1000 } });
  const sql: ExportSql = {
    unsafe: async (query, parameters = []) => {
      try {
        return await client.begin(async tx => {
          await tx.unsafe("SET LOCAL statement_timeout='5000ms'; SET LOCAL lock_timeout='1000ms'");
          await assertExportRuntime(tx, role);
          return tx.unsafe(query, parameters);
        });
      } catch (error) {
        if (error instanceof Error && error.message === "export_database_role_not_restricted") throw error;
        // Driver errors may include SQL parameters (payloads or encrypted secrets).
        throw new Error("export_database_unavailable");
      }
    },
  };
  return { sql, close: () => client.end({ timeout: 2 }) };
}

let database: ReturnType<typeof createExportDatabase> | undefined;
export const exportSql: ExportSql = {
  unsafe: (query, parameters) => (database ??= createExportDatabase(process.env)).sql.unsafe(query, parameters),
};
export async function closeExportDatabase() {
  const current = database; database = undefined;
  await current?.close();
}
