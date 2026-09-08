/**
 * Postgres authority for AppFueled's vehicle-URL webhook.  This repository
 * deliberately has no cache: disabling or rotating a connection is visible to
 * the very next authentication/capture transaction.
 */
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { instrumentPgClientForSlowQueries } from "@/lib/slow-query/tracker";

const DB_DEADLINE_MS = 3_800;
const STATEMENT_TIMEOUT_MS = 3_200;
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const DEFAULT_RATE_LIMIT = 60;

export type ShopIdNamespace = "mos" | "provider";
export type DeliveryOutcome = "accepted" | "rejected";
export type ConnectionAction = "disable" | "rotate";

export interface AppFueledConnection {
  id: string; connectionId: string; mosShopId: number; incomingShopId: number;
  shopIdNamespace: ShopIdNamespace; namespaceConfirmation: string;
  allowedHosts: string[]; tokenHash: string; enabled: boolean;
  createdBy: string; updatedBy: string; createdAt: Date; updatedAt: Date;
  disabledAt: Date | null; disabledBy: string | null; rotatedAt: Date | null; rotatedBy: string | null;
  lastSuccessAt: Date | null; lastReceiptId: string | null;
}
export interface CreateConnectionInput {
  connectionId: string; mosShopId: number; incomingShopId: number;
  shopIdNamespace: ShopIdNamespace; namespaceConfirmation: string; allowedHosts: string[];
}
export interface CaptureDeliveryInput {
  connection: Pick<AppFueledConnection, "id" | "mosShopId">;
  tokenHash: string; correlationId: string; receivedAt: Date; vin: string | null;
  payload: Record<string, unknown>; outcome: DeliveryOutcome; reason: string;
  vehicleUrl: string | null; startedAt: number; ipHash: string; deadlineAt?: number;
}
export interface CaptureDeliveryResult {
  outcome: DeliveryOutcome; reason: string; status: number; receiptId: string;
}
export interface ReceiptFilters {
  shopId?: number; connectionId?: string; vin?: string; from?: Date; to?: Date;
  outcome?: DeliveryOutcome; page?: number;
}
export interface AppFueledReceipt {
  id: string; connectionId: string; mosShopId: number; correlationId: string; receivedAt: Date;
  vin: string | null; payload: Record<string, unknown>; outcome: DeliveryOutcome; reason: string;
  startedAt: Date; ipHash: string; durationMs: number; createdAt: Date;
}
export interface AppFueledVehicleUrl {
  connectionId: string; mosShopId: number; vin: string; vehicleUrl: string;
  lastReceivedAt: Date; sourceReceiptId: string; updatedAt: Date;
  receivedAt: Date; receiptId: string;
}

export class AppFueledDeadlineError extends Error {
  /**
   * Once a transaction has reached COMMIT, a client-side/network timeout
   * cannot distinguish rollback from a commit whose acknowledgement was lost.
   * Callers must return non-2xx and use the request correlation ID to inspect
   * or idempotently retry; they must not claim the receipt was rolled back.
   */
  readonly persistenceUnknown = true;
  constructor() { super("AppFueled database deadline exceeded"); this.name = "AppFueledDeadlineError"; }
}
export class ConnectionIdConflictError extends Error {
  statusCode = 409;
  constructor() { super("connectionId is already provisioned and cannot be rebound"); this.name = "ConnectionIdConflictError"; }
}

let client: ReturnType<typeof postgres> | null = null;
function getSql() {
  if (!client) {
    const url = process.env.DATAONE_DATABASE_URL || process.env.DATABASE_URL;
    if (!url) throw new Error("Missing DATAONE_DATABASE_URL or DATABASE_URL.");
    // Isolated, small pool prevents ingress contention from consuming the
    // application's general PG pool. Queries below set server-side deadlines.
    client = instrumentPgClientForSlowQueries(
      postgres(url, {
        max: 2,
        connect_timeout: 2,
        idle_timeout: 10,
        prepare: false,
        connection: {
          statement_timeout: STATEMENT_TIMEOUT_MS,
          idle_in_transaction_session_timeout: DB_DEADLINE_MS,
          application_name: "appfueled_url_events",
        },
      }),
    );
  }
  return client;
}
export const __deps = { getSql };

function deadline(input?: number) { return input ?? Date.now() + DB_DEADLINE_MS; }
function assertBefore(d: number) { if (Date.now() >= d) throw new AppFueledDeadlineError(); }
function elapsedMs(startedAt: number) {
  return Math.min(2_147_483_647, Math.max(0, Math.floor(Date.now() - startedAt)));
}
async function timed<T>(query: any, d: number): Promise<T> {
  const remaining = Math.max(1, d - Date.now());
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { try { query.cancel?.(); } finally { reject(new AppFueledDeadlineError()); } }, remaining);
  });
  try { return await Promise.race([query, timeout]); } finally { if (timer) clearTimeout(timer); }
}
function mapConnection(r: any): AppFueledConnection {
  return {
    id: r.id, connectionId: r.connection_id, mosShopId: Number(r.mos_shop_id), incomingShopId: Number(r.incoming_shop_id),
    shopIdNamespace: r.shop_id_namespace, namespaceConfirmation: r.namespace_confirmation,
    allowedHosts: Array.isArray(r.allowed_hosts) ? r.allowed_hosts : [], tokenHash: r.token_hash, enabled: r.enabled,
    createdBy: r.created_by, updatedBy: r.updated_by, createdAt: r.created_at, updatedAt: r.updated_at,
    disabledAt: r.disabled_at, disabledBy: r.disabled_by, rotatedAt: r.rotated_at, rotatedBy: r.rotated_by,
    lastSuccessAt: r.last_success_at, lastReceiptId: r.last_receipt_id,
  };
}
function validInput(input: CreateConnectionInput) {
  if (!input.connectionId || !Number.isSafeInteger(input.mosShopId) || input.mosShopId <= 0 ||
      !Number.isSafeInteger(input.incomingShopId) || input.incomingShopId <= 0 ||
      (input.shopIdNamespace !== "mos" && input.shopIdNamespace !== "provider") ||
      input.namespaceConfirmation.trim().length < 10 ||
      (input.shopIdNamespace === "mos" && input.incomingShopId !== input.mosShopId)) {
    throw new Error("Invalid AppFueled connection provisioning input");
  }
}

export async function createConnection(input: CreateConnectionInput, actor: string, tokenHash: string): Promise<AppFueledConnection> {
  validInput(input);
  if (!actor || !tokenHash) throw new Error("Actor and token hash are required");
  const d = deadline();
  try {
    const rows: any[] = await timed(__deps.getSql().unsafe(
      `INSERT INTO appfueled_url_connections
       (connection_id,mos_shop_id,incoming_shop_id,shop_id_namespace,namespace_confirmation,allowed_hosts,token_hash,created_by,updated_by)
       VALUES ($1,$2,$3,$4,$5,$6::text::jsonb,$7,$8,$8) RETURNING *`,
      [input.connectionId, input.mosShopId, input.incomingShopId, input.shopIdNamespace,
       input.namespaceConfirmation, JSON.stringify(input.allowedHosts), tokenHash, actor]), d);
    return mapConnection(rows[0]);
  } catch (error: any) {
    if (error?.code === "23505" &&
        (!error?.constraint_name || error.constraint_name === "appfueled_url_connections_connection_id_uq")) {
      throw new ConnectionIdConflictError();
    }
    if (error?.code === "23505" && error?.constraint_name === "appfueled_url_connections_token_hash_uq") {
      throw new Error("Generated AppFueled credential collided; generate a new credential");
    }
    throw error;
  }
}

export async function changeConnection(id: string, action: ConnectionAction, actor: string, tokenHash?: string): Promise<AppFueledConnection | null> {
  if (!actor || (action === "rotate" && !tokenHash)) throw new Error("Invalid connection change");
  const d = deadline();
  const query = action === "disable"
    ? __deps.getSql().unsafe(`UPDATE appfueled_url_connections SET enabled=false,updated_by=$2,updated_at=now(),disabled_by=$2,disabled_at=now() WHERE id=$1 RETURNING *`, [id, actor])
    : __deps.getSql().unsafe(`UPDATE appfueled_url_connections SET token_hash=$3,enabled=true,updated_by=$2,updated_at=now(),rotated_by=$2,rotated_at=now(),disabled_by=NULL,disabled_at=NULL WHERE id=$1 RETURNING *`, [id, actor, tokenHash!]);
  const rows: any[] = await timed(query, d);
  return rows[0] ? mapConnection(rows[0]) : null;
}

export async function listConnections(): Promise<AppFueledConnection[]> {
  const d = deadline();
  const rows: any[] = await timed(__deps.getSql().unsafe(`SELECT * FROM appfueled_url_connections ORDER BY created_at DESC`), d);
  return rows.map(mapConnection);
}

export async function authenticateAppFueledHook(tokenHash: string): Promise<AppFueledConnection | null> {
  const d = Math.min(deadline(), Date.now() + 1_500);
  const rows: any[] = await timed(__deps.getSql().unsafe(
    `SELECT * FROM appfueled_url_connections WHERE token_hash=$1 LIMIT 1`, [tokenHash]), d);
  return rows[0] ? mapConnection(rows[0]) : null; // disabled state is intentionally returned
}

export async function captureDelivery(input: CaptureDeliveryInput): Promise<CaptureDeliveryResult> {
  const d = deadline(input.deadlineAt);
  assertBefore(d);
  const sql: any = __deps.getSql();
  // `begin` rolls back when the callback throws. A transaction that was still
  // queued when the deadline passed fails its first assertion before writing.
  // Once COMMIT was sent, however, an acknowledgement timeout has UNKNOWN
  // persistence (Postgres may commit later); the stable correlation ID is the
  // inspection/idempotent-retry key and the caller must return non-2xx.
  const transaction = sql.begin(async (tx: any) => {
    const run = <T = any[]>(query: any) => timed<T>(query, d);
    assertBefore(d);
    await run(tx.unsafe(`SET LOCAL statement_timeout = '${STATEMENT_TIMEOUT_MS}ms'`));
    await run(tx.unsafe(`SET LOCAL lock_timeout = '1000ms'`));
    const connectionRows: any[] = await run(tx.unsafe(`SELECT * FROM appfueled_url_connections WHERE id=$1 FOR UPDATE`, [input.connection.id]));
    const c = connectionRows[0];
    if (!c) throw new Error("AppFueled connection no longer exists");
    const duplicate: any[] = await run(tx.unsafe(
      `SELECT id,outcome,reason FROM appfueled_url_receipts WHERE connection_id=$1 AND correlation_id=$2`,
      [c.id, input.correlationId]));
    if (duplicate[0]) return {
      outcome: duplicate[0].outcome,
      reason: duplicate[0].reason,
      status: duplicate[0].outcome === "accepted" ? 202 :
        duplicate[0].reason === "rate_limited" ? 429 :
        duplicate[0].reason === "token_rotated" ? 401 :
        duplicate[0].reason === "connection_disabled" ? 403 : 400,
      receiptId: duplicate[0].id,
    };

    let outcome = input.outcome, reason = input.reason, status = outcome === "accepted" ? 202 : 400;
    // A token authenticated just before rotation still gets a durable rejected
    // receipt here; the locked current value linearizes rotation vs capture.
    if (c.token_hash !== input.tokenHash) { outcome = "rejected"; reason = "token_rotated"; status = 401; }
    else if (!c.enabled) { outcome = "rejected"; reason = "connection_disabled"; status = 403; }
    else {
      const minute = Math.floor(input.receivedAt.getTime() / 60_000);
      const key = `${c.id}:${minute}`;
      const configured = Number(process.env.APPFUELED_URL_RATE_LIMIT);
      const limit = Number.isSafeInteger(configured) && configured >= 1
        ? Math.min(configured, 10_000)
        : DEFAULT_RATE_LIMIT;
      const bucket: any[] = await run(tx.unsafe(
        `INSERT INTO appfueled_url_rate_buckets(bucket_key,count,expires_at) VALUES($1,1,date_trunc('minute',now()) + interval '2 minutes')
         ON CONFLICT(bucket_key) DO UPDATE SET count=appfueled_url_rate_buckets.count+1
         RETURNING count`, [key]));
      if (Number(bucket[0].count) > limit) { outcome = "rejected"; reason = "rate_limited"; status = 429; }
    }
    assertBefore(d);
    const receiptId = randomUUID();
    const durationMs = elapsedMs(input.startedAt);
    await run(tx.unsafe(
      `INSERT INTO appfueled_url_receipts(id,connection_id,mos_shop_id,correlation_id,received_at,vin,payload,outcome,reason,vehicle_url,started_at,ip_hash,duration_ms)
       VALUES($1,$2,$3,$4,$5,$6,$7::text::jsonb,$8,$9,$10,$11,$12,$13)`,
      [receiptId, c.id, c.mos_shop_id, input.correlationId, input.receivedAt, input.vin,
       JSON.stringify(input.payload), outcome, reason, outcome === "accepted" ? input.vehicleUrl : null,
       new Date(input.startedAt), input.ipHash, durationMs]));
    if (outcome === "accepted" && input.vin && input.vehicleUrl) {
      await run(tx.unsafe(
        `INSERT INTO appfueled_vehicle_urls(connection_id,mos_shop_id,vin,vehicle_url,last_received_at,source_receipt_id)
         VALUES($1,$2,$3,$4,$5,$6)
         ON CONFLICT(connection_id,mos_shop_id,vin) DO UPDATE SET vehicle_url=EXCLUDED.vehicle_url,last_received_at=EXCLUDED.last_received_at,source_receipt_id=EXCLUDED.source_receipt_id,updated_at=now()
         WHERE (EXCLUDED.last_received_at,EXCLUDED.source_receipt_id) > (appfueled_vehicle_urls.last_received_at,appfueled_vehicle_urls.source_receipt_id)`,
        [c.id, c.mos_shop_id, input.vin, input.vehicleUrl, input.receivedAt, receiptId]));
      await run(tx.unsafe(
        `UPDATE appfueled_url_connections
         SET last_success_at=$2,last_receipt_id=$3,updated_at=now()
         WHERE id=$1 AND (last_success_at IS NULL OR ($2,$3) > (last_success_at,COALESCE(last_receipt_id,'00000000-0000-0000-0000-000000000000'::uuid)))`,
        [c.id, input.receivedAt, receiptId]));
    }
    // Refresh at the final SQL boundary so the persisted value represents
    // server elapsed time immediately before commit, not merely parse time.
    await run(tx.unsafe(
      `UPDATE appfueled_url_receipts SET duration_ms=$2 WHERE id=$1`,
      [receiptId, elapsedMs(input.startedAt)]));
    assertBefore(d); // checked immediately before postgres-js commits
    return { outcome, reason, status, receiptId };
  });
  // Bounds pool acquisition and response acknowledgement. If acquisition is
  // delayed, the callback's first assert prevents late writes. If execution
  // has started, each current statement is cancelled above. This timer cannot
  // revoke a COMMIT already sent: timeout means UNKNOWN persistence, never a
  // success response, and support can inspect the correlation ID.
  try {
    return await timed<CaptureDeliveryResult>(transaction, d);
  } catch (error) {
    // Correlation-only operational evidence: never log token/hash, URL,
    // payload, VIN, IP hash, SQL parameters, or raw database errors.
    console.warn("[AppFueledUrlEvents] storage_unavailable", {
      correlationId: input.correlationId,
      persistence: "unknown",
    });
    throw error;
  }
}

function filters(filters: ReceiptFilters, table: "r" | "v") {
  const clauses: string[] = []; const params: any[] = [];
  const add = (column: string, value: any) => { params.push(value); clauses.push(`${column}=$${params.length}`); };
  if (filters.shopId != null) add(`${table}.mos_shop_id`, filters.shopId);
  // Admin UI selects the immutable internal connection UUID while rows expose
  // the operator-facing exact provider connection identifier.
  if (filters.connectionId) add(`${table}.connection_id`, filters.connectionId);
  if (filters.vin) add(`${table}.vin`, filters.vin);
  if (filters.from) { params.push(filters.from); clauses.push(`${table}.${table === "r" ? "received_at" : "last_received_at"} >= $${params.length}`); }
  if (filters.to) { params.push(filters.to); clauses.push(`${table}.${table === "r" ? "received_at" : "last_received_at"} <= $${params.length}`); }
  if (table === "r" && filters.outcome) add("r.outcome", filters.outcome);
  return { where: clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "", params };
}
export async function listReceipts(filtersInput: ReceiptFilters = {}) {
  const page = Math.max(1, Math.floor(filtersInput.page ?? 1)), size = 100, f = filters(filtersInput, "r"), d = deadline();
  const rows: any[] = await timed(__deps.getSql().unsafe(
    `SELECT r.id,c.connection_id,r.mos_shop_id,r.correlation_id,r.received_at,r.vin,r.payload,r.outcome,r.reason,r.started_at,r.ip_hash,r.duration_ms,r.created_at
     FROM appfueled_url_receipts r JOIN appfueled_url_connections c ON c.id=r.connection_id
     ${f.where} ORDER BY r.received_at DESC,r.id DESC LIMIT ${size + 1} OFFSET ${(page - 1) * size}`, f.params), d);
  const hasMore = rows.length > size;
  return {
    receipts: rows.slice(0, size).map((r): AppFueledReceipt => ({
      id: r.id, connectionId: r.connection_id, mosShopId: Number(r.mos_shop_id),
      correlationId: r.correlation_id, receivedAt: r.received_at, vin: r.vin,
      payload: r.payload, outcome: r.outcome, reason: r.reason, startedAt: r.started_at,
      ipHash: r.ip_hash, durationMs: Number(r.duration_ms), createdAt: r.created_at,
    })),
    hasMore,
    page,
  };
}
export async function listVehicleUrls(filtersInput: ReceiptFilters = {}) {
  const page = Math.max(1, Math.floor(filtersInput.page ?? 1)), size = 100, f = filters(filtersInput, "v"), d = deadline();
  const rows: any[] = await timed(__deps.getSql().unsafe(
    `SELECT c.connection_id,v.mos_shop_id,v.vin,v.vehicle_url,v.last_received_at,v.source_receipt_id,v.updated_at
     FROM appfueled_vehicle_urls v JOIN appfueled_url_connections c ON c.id=v.connection_id
     ${f.where} ORDER BY v.last_received_at DESC,v.source_receipt_id DESC LIMIT ${size + 1} OFFSET ${(page - 1) * size}`, f.params), d);
  const hasMore = rows.length > size;
  return {
    vehicleUrls: rows.slice(0, size).map((v): AppFueledVehicleUrl => ({
      connectionId: v.connection_id, mosShopId: Number(v.mos_shop_id), vin: v.vin,
      vehicleUrl: v.vehicle_url, lastReceivedAt: v.last_received_at,
      sourceReceiptId: v.source_receipt_id, updatedAt: v.updated_at,
      // UI-friendly provenance aliases; kept in addition to the explicit names.
      receivedAt: v.last_received_at, receiptId: v.source_receipt_id,
    })),
    hasMore,
    page,
  };
}
export async function cleanupExpiredAppFueledReceipts(now = new Date()): Promise<{ receipts: number; buckets: number }> {
  const d = deadline();
  const sql = __deps.getSql();
  const [receipts, buckets]: any = await Promise.all([
    timed(sql.unsafe(`DELETE FROM appfueled_url_receipts WHERE received_at < $1`, [new Date(now.getTime() - RETENTION_MS)]), d),
    timed(sql.unsafe(`DELETE FROM appfueled_url_rate_buckets WHERE expires_at < $1`, [now]), d),
  ]);
  return { receipts: receipts.count ?? 0, buckets: buckets.count ?? 0 };
}