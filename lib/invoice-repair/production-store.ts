import "server-only";
import assert from "node:assert/strict";
import postgres from "postgres";
import { MongoClient } from "mongodb";
import { NativeInvoiceStore } from "@/scripts/invoice-native-dual-store";
import { instrumentPgClientForSlowQueries } from "../slow-query/tracker";

/** Trusted server configuration, never request JSON. Nothing reads env or
 * opens a connection on import. No defaults for target, credentials or consent. */
export interface ProductionRepairConfig {
  enabled: boolean;
  postgresUrl: string | {host: string; port: number; database: string; username: string};
  mongoUri: string;
  mongoDatabase: string;
  expectedPostgresDatabase: string;
  expectedPostgresRole: string;
  installationKey: string;
}

/** Dedicated maintenance connection: ordinary guarded clients would deadlock
 * against the repair's own fence. Every engine phase verifies this binding,
 * then requires drained admissions, reviewed writers, evidence and grants.
 * No installation/migration/approval is performed here. */
export async function openProductionRepairStore(config: ProductionRepairConfig) {
  assert.equal(config?.enabled, true, "Production invoice repair disabled");
  config = Object.freeze({...config});
  assert.ok(config.postgresUrl && config.mongoUri && config.mongoDatabase);
  assert.ok(config.expectedPostgresDatabase && config.expectedPostgresRole);
  assert.match(config.installationKey, /^[a-f0-9]{64}$/);
  const options = {max: 1, connect_timeout: 5,
    idle_timeout: 5, onnotice: () => {}, connection: {application_name: "invoice-repair-maintenance"}};
  let sql: ReturnType<typeof postgres>;
  try {
    sql = instrumentPgClientForSlowQueries(typeof config.postgresUrl === "string"
      ? postgres(config.postgresUrl, options) : postgres({...config.postgresUrl, ...options}));
  } catch { throw Error("Invalid invoice repair connection configuration"); }
  let mongo: MongoClient;
  try {
    mongo = new MongoClient(config.mongoUri, {retryWrites: false, maxPoolSize: 1,
      serverSelectionTimeoutMS: 5000, connectTimeoutMS: 5000, socketTimeoutMS: 10000,
      readPreference: "primary", readConcern: {level: "majority"}});
  } catch {
    await sql.end({timeout: 2}).catch(() => {});
    throw Error("Invalid invoice repair connection configuration");
  }
  const db = mongo.db(config.mongoDatabase);
  async function guard(tx: any) {
    await tx.unsafe("SET LOCAL statement_timeout='10s'");
    await tx.unsafe("SET LOCAL lock_timeout='2s'");
    await tx.unsafe("SET LOCAL idle_in_transaction_session_timeout='30s'");
    const [target] = await tx.unsafe("SELECT current_database() db, current_user role");
    assert.equal(target.db, config.expectedPostgresDatabase, "Unexpected PostgreSQL database");
    assert.equal(target.role, config.expectedPostgresRole, "Unexpected PostgreSQL role");
    const rows = await tx.unsafe("SELECT installation_key FROM invoice_repair_installation WHERE id=1 AND protocol=1");
    assert.equal(rows.length, 1, "Repair installation missing");
    assert.equal(rows[0].installation_key, config.installationKey, "PostgreSQL installation mismatch");
    const binding = await db.collection("invoice_repair_installation").findOne({_id: "coordinator" as any});
    assert.equal(binding?.installationKey, config.installationKey, "Mongo installation mismatch");
  }
  const close = async () => { await Promise.all([mongo.close(), sql.end({timeout: 2})]); };
  try {
    await sql.begin("read only", async tx => { await guard(tx); });
    return {store: new NativeInvoiceStore(sql, db, guard), close};
  } catch {
    await close().catch(() => {});
    // Driver errors may include hosts or connection details. Never surface them.
    throw Error("Invoice repair connection or installation verification failed");
  }
}
