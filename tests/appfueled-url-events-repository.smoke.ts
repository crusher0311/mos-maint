import assert from "node:assert/strict";
import {
  __deps,
  captureDelivery,
  cleanupExpiredAppFueledReceipts,
  createConnection,
  ConnectionIdConflictError,
  listConnections,
  listVehicleUrls,
} from "../lib/data/repositories/appfueled-url-events";

type State = {
  connections: any[];
  receipts: any[];
  urls: any[];
  buckets: Map<string, number>;
};

function pending<T>(value: T | Promise<T>): Promise<T> & { cancel(): void } {
  const promise: any = Promise.resolve(value);
  promise.cancel = () => {};
  return promise;
}

class FakeSql {
  state: State = { connections: [], receipts: [], urls: [], buckets: new Map() };
  failAssociation = false;
  delayCommitMs = 0;
  private tail = Promise.resolve();

  begin(callback: (tx: FakeSql) => Promise<any>) {
    const work = this.tail.then(async () => {
      // This fake models PostgreSQL's serialized row-lock transaction shape,
      // including commit visibility/ack delay. It is not a throughput or
      // isolation-level substitute for a live Postgres integration test.
      const committed = this.state;
      const draft = structuredClone(committed);
      this.state = draft;
      try {
        const result = await callback(this);
        this.state = committed;
        if (this.delayCommitMs) await new Promise((resolve) => setTimeout(resolve, this.delayCommitMs));
        this.state = draft;
        return result;
      } catch (error) {
        this.state = committed;
        throw error;
      }
    });
    this.tail = work.then(() => undefined, () => undefined);
    return work;
  }

  unsafe(statement: string, values: any[] = []): any {
    const q = statement.replace(/\s+/g, " ").trim();
    if (q.startsWith("SET LOCAL")) return pending([]);
    if (q.startsWith("INSERT INTO appfueled_url_connections")) {
      if (this.state.connections.some((c) => c.connection_id === values[0])) {
        return pending(Promise.reject(Object.assign(new Error("unique"), {
          code: "23505", constraint_name: "appfueled_url_connections_connection_id_uq",
        })));
      }
      const now = new Date();
      const row = {
        id: `00000000-0000-4000-8000-${String(this.state.connections.length + 1).padStart(12, "0")}`,
        connection_id: values[0], mos_shop_id: values[1], incoming_shop_id: values[2],
        shop_id_namespace: values[3], namespace_confirmation: values[4],
        allowed_hosts: JSON.parse(values[5]), token_hash: values[6], created_by: values[7],
        updated_by: values[7], enabled: true, created_at: now, updated_at: now,
        disabled_at: null, disabled_by: null, rotated_at: null, rotated_by: null,
        last_success_at: null, last_receipt_id: null,
      };
      this.state.connections.push(row);
      return pending([row]);
    }
    if (q.includes("FROM appfueled_url_connections WHERE id=$1 FOR UPDATE")) {
      return pending(this.state.connections.filter((c) => c.id === values[0]));
    }
    if (q.includes("FROM appfueled_url_receipts WHERE connection_id=$1 AND correlation_id=$2")) {
      return pending(this.state.receipts.filter((r) => r.connection_id === values[0] && r.correlation_id === values[1]));
    }
    if (q.startsWith("INSERT INTO appfueled_url_rate_buckets")) {
      const count = (this.state.buckets.get(values[0]) ?? 0) + 1;
      this.state.buckets.set(values[0], count);
      return pending([{ count }]);
    }
    if (q.startsWith("INSERT INTO appfueled_url_receipts")) {
      this.state.receipts.push({
        id: values[0], connection_id: values[1], mos_shop_id: values[2],
        correlation_id: values[3], received_at: values[4], vin: values[5],
        payload: JSON.parse(values[6]), outcome: values[7], reason: values[8],
        vehicle_url: values[9], started_at: values[10], ip_hash: values[11],
        duration_ms: values[12], created_at: new Date(),
      });
      return pending([]);
    }
    if (q.startsWith("INSERT INTO appfueled_vehicle_urls")) {
      if (this.failAssociation) return pending(Promise.reject(new Error("association failure")));
      const existing = this.state.urls.find((u) => u.connection_uuid === values[0] && u.mos_shop_id === values[1] && u.vin === values[2]);
      const newer = !existing || values[4] > existing.last_received_at ||
        (+values[4] === +existing.last_received_at && values[5] > existing.source_receipt_id);
      if (newer) {
        const connection = this.state.connections.find((c) => c.id === values[0]);
        const row = {
          connection_uuid: values[0], connection_id: connection.connection_id, mos_shop_id: values[1],
          vin: values[2], vehicle_url: values[3], last_received_at: values[4],
          source_receipt_id: values[5], updated_at: new Date(),
        };
        if (existing) Object.assign(existing, row); else this.state.urls.push(row);
      }
      return pending([]);
    }
    if (q.startsWith("UPDATE appfueled_url_connections SET last_success_at")) {
      const c = this.state.connections.find((row) => row.id === values[0]);
      if (!c.last_success_at || values[1] > c.last_success_at ||
          (+values[1] === +c.last_success_at && values[2] > c.last_receipt_id)) {
        c.last_success_at = values[1]; c.last_receipt_id = values[2];
      }
      return pending([]);
    }
    if (q.startsWith("UPDATE appfueled_url_receipts SET duration_ms")) {
      const receipt = this.state.receipts.find((row) => row.id === values[0]);
      if (receipt) receipt.duration_ms = values[1];
      return pending([]);
    }
    if (q.startsWith("SELECT * FROM appfueled_url_connections ORDER BY")) {
      return pending([...this.state.connections]);
    }
    if (q.startsWith("SELECT c.connection_id,v.mos_shop_id")) {
      return pending([...this.state.urls]);
    }
    if (q.startsWith("DELETE FROM appfueled_url_receipts")) {
      const before = this.state.receipts.length;
      this.state.receipts = this.state.receipts.filter((r) => r.received_at >= values[0]);
      return pending(Object.assign([], { count: before - this.state.receipts.length }));
    }
    if (q.startsWith("DELETE FROM appfueled_url_rate_buckets")) {
      const count = this.state.buckets.size;
      this.state.buckets.clear();
      return pending(Object.assign([], { count }));
    }
    throw new Error(`Unhandled fake statement: ${q}`);
  }
}

async function main() {
const fake = new FakeSql();
(__deps as any).getSql = () => fake;
const actor = "admin@example.com";
const token = "a".repeat(64);
const connection = await createConnection({
  connectionId: "exact-provider-connection", mosShopId: 42, incomingShopId: 42,
  shopIdNamespace: "mos", namespaceConfirmation: "verified against MOS shop",
  allowedHosts: ["inventory.example.com"],
}, actor, token);
await assert.rejects(
  createConnection({
    connectionId: "exact-provider-connection", mosShopId: 99, incomingShopId: 99,
    shopIdNamespace: "mos", namespaceConfirmation: "verified against other shop",
    allowedHosts: ["inventory.example.com"],
  }, actor, token),
  ConnectionIdConflictError,
);

let n = 0;
const delivery = (overrides: Record<string, any> = {}) => ({
  connection, tokenHash: token, correlationId: `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`,
  receivedAt: new Date(1_700_000_000_000 + n), vin: "1M8GDM9AXKP042788",
  payload: { safe: true }, outcome: "accepted" as const, reason: "accepted",
  vehicleUrl: `https://inventory.example.com/${n}`, startedAt: Date.now() - 10,
  ipHash: "b".repeat(64), deadlineAt: Date.now() + 2_000, ...overrides,
});

const same = delivery();
const duplicates = await Promise.all([captureDelivery(same), captureDelivery(same)]);
assert.equal(new Set(duplicates.map((r) => r.receiptId)).size, 1, "concurrent duplicate is one receipt");
assert.equal(fake.state.receipts.length, 1);

fake.state.connections[0].token_hash = "c".repeat(64);
const rotated = await captureDelivery(delivery());
assert.deepEqual([rotated.outcome, rotated.reason, rotated.status], ["rejected", "token_rotated", 401]);
fake.state.connections[0].token_hash = token;
fake.state.connections[0].enabled = false;
const disabled = await captureDelivery(delivery());
assert.deepEqual([disabled.reason, disabled.status], ["connection_disabled", 403]);
fake.state.connections[0].enabled = true;

fake.failAssociation = true;
const beforeFailure = fake.state.receipts.length;
await assert.rejects(captureDelivery(delivery()), /association failure/);
assert.equal(fake.state.receipts.length, beforeFailure, "receipt rolls back with association failure");
fake.failAssociation = false;

process.env.APPFUELED_URL_RATE_LIMIT = "1";
fake.state.buckets.clear();
await captureDelivery(delivery({ outcome: "rejected", reason: "malformed", vehicleUrl: null }));
const limited = await captureDelivery(delivery());
assert.equal(limited.reason, "rate_limited", "malformed authenticated request consumes distributed budget");
delete process.env.APPFUELED_URL_RATE_LIMIT;

fake.state.buckets.clear();
const newest = delivery({ receivedAt: new Date("2025-01-02T00:00:00Z") });
await captureDelivery(newest);
await captureDelivery(delivery({ receivedAt: new Date("2025-01-01T00:00:00Z"), vehicleUrl: "https://inventory.example.com/stale" }));
const urls = await listVehicleUrls({ connectionId: connection.id });
assert.equal(urls.vehicleUrls[0].vehicleUrl, newest.vehicleUrl, "older delivery cannot replace association");
assert.equal(urls.vehicleUrls[0].receivedAt, urls.vehicleUrls[0].lastReceivedAt);
assert.equal(urls.vehicleUrls[0].receiptId, urls.vehicleUrls[0].sourceReceiptId);

for (const receipt of fake.state.receipts) receipt.received_at = new Date(0);
const purged = await cleanupExpiredAppFueledReceipts(new Date());
assert.ok(purged.receipts > 0);
const listed = await listConnections();
assert.ok(listed[0].lastSuccessAt && listed[0].lastReceiptId, "success metadata survives finite receipts");

// A COMMIT acknowledgement arriving after the repository deadline is never
// reported as accepted. Persistence is explicitly UNKNOWN: this fake then
// makes the committed receipt visible so support/retry can find correlationId.
fake.delayCommitMs = 80;
fake.state.buckets.clear();
const delayed = delivery({ deadlineAt: Date.now() + 30 });
let returnedSuccess = false;
await assert.rejects(
  captureDelivery(delayed).then(() => { returnedSuccess = true; }),
  (error: any) => error?.name === "AppFueledDeadlineError" && error.persistenceUnknown === true,
);
assert.equal(returnedSuccess, false, "no accepted result before COMMIT acknowledgement");
await new Promise((resolve) => setTimeout(resolve, 100));
assert.ok(fake.state.receipts.some((row) => row.correlation_id === delayed.correlationId),
  "late COMMIT demonstrates UNKNOWN persistence inspectable by correlation ID");
fake.delayCommitMs = 0;

console.log("✓ AppFueled URL event repository fake-SQL transaction tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});