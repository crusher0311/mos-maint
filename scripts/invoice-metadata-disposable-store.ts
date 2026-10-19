/** Test-only physical adapter. No production env variables, URLs or Mongo imports. */
import assert from "node:assert/strict";
import postgres from "postgres";
import {userInfo} from "node:os";
import {evidenceDigest as digest} from "./invoice-metadata-repair-plan";
import type {AuditEvent, CurrentCase, OfflineRepairStore, Proposal, Receipt, RepairTransaction} from "./invoice-metadata-executor";

export const DISPOSABLE_SCHEMA = `
CREATE TABLE repair_cases(identity text PRIMARY KEY, context jsonb NOT NULL);
CREATE TABLE repair_owners(identity text NOT NULL REFERENCES repair_cases(identity),
  side text NOT NULL CHECK(side IN ('canonical','shadow')), owner_key text NOT NULL,
  revision bigint NOT NULL, snapshot jsonb NOT NULL, document jsonb NOT NULL,
  PRIMARY KEY(side,owner_key));
CREATE TABLE repair_receipts(key text PRIMARY KEY, receipt jsonb NOT NULL);
CREATE TABLE repair_audit(sequence bigserial PRIMARY KEY, event jsonb NOT NULL);
`;
export const identity = (p: Proposal) => `${p.shopId}:${p.provider}:${p.sourceId.toLowerCase()}`;

export class DisposableMetadataStore implements OfflineRepairStore {
  readonly mode = "disposable-only" as const;
  readonly sql;
  /** Test fault hooks; cannot cause writes outside the isolated database. */
  failAfterCanonical = false;
  loseNextCommitResponse = false;
  failOnIdentity: string | null = null;
  constructor(socket: string) {
    assert.match(socket, /^\/tmp\/invoice-owner-offline\.[A-Za-z0-9]+$/);
    this.sql = postgres({host: socket, port: 5432, database: "postgres", username: userInfo().username,
      max: 4, connect_timeout: 3, idle_timeout: 2, onnotice: () => {}});
  }
  private async guard(tx: any) {
    const [r] = await tx`SELECT current_setting('invoice_preview.disposable',true) marker, inet_server_addr() address`;
    assert.equal(r.marker, "yes", "Not a disposable database");
    assert.equal(r.address, null, "Network database refused");
    await tx.unsafe("SET LOCAL statement_timeout='3s'");
    await tx.unsafe("SET LOCAL lock_timeout='1s'");
    await tx.unsafe("SET LOCAL idle_in_transaction_session_timeout='5s'");
  }
  private adapter(tx: any): RepairTransaction {
    const read = async (p: Proposal): Promise<CurrentCase> => {
      const id = identity(p);
      const cases = await tx`SELECT context FROM repair_cases WHERE identity=${id}`;
      assert.equal(cases.length, 1, "Missing source/hold context");
      // Discover competing aliases even if their fixture grouping key is wrong.
      const owners = await tx`SELECT * FROM repair_owners WHERE identity=${id} OR
        (document->>'shop_id'=${String(p.shopId)} AND EXISTS (
          SELECT 1 FROM jsonb_array_elements(document->'provenance'->'sourceIds') s
          WHERE s->>'system'='protractor' AND s->>'idType' IN ('invoice_id','work_order_id')
            AND lower(s->>'idValue')=${p.sourceId.toLowerCase()}))
        ORDER BY side,owner_key`;
      const side = (name: string) => owners.filter((o: any) => o.side === name).map((o: any) =>
        ({key: o.owner_key, revision: Number(o.revision), snapshot: o.snapshot, row: o.document}));
      return {...cases[0].context, canonical: side("canonical"), shadow: side("shadow")};
    };
    return {
      read,
      receipt: async key => (await tx`SELECT receipt FROM repair_receipts WHERE key=${key}`)[0]?.receipt ?? null,
      compareAndSet: async (p, before, after) => {
        if (digest(await read(p)) !== digest(before)) return false;
        if (this.failOnIdentity === identity(p)) throw new Error("Injected owner failure");
        for (const side of ["canonical", "shadow"] as const) {
          const old = before[side][0], next = after[side][0];
          // Defense in depth: even a faulty caller cannot update another field.
          const unchanged = structuredClone(next);
          unchanged.revision = old.revision;
          unchanged.row.custom_fields = structuredClone(old.row.custom_fields);
          unchanged.snapshot.custom_fields = structuredClone(old.snapshot.custom_fields);
          assert.equal(digest(unchanged), digest(old), "Non-metadata write refused");
          for (const field of ["row", "snapshot"] as const) {
            const strip = (v: any) => {const c = structuredClone(v.custom_fields); delete c.invoiceHours; return c;};
            assert.equal(digest(strip(old[field])), digest(strip(next[field])), "Other custom field write refused");
          }
          const exists = Object.hasOwn(next.row.custom_fields, "invoiceHours");
          const value = tx.json(next.row.custom_fields.invoiceHours ?? null);
          const rows = await tx`
            UPDATE repair_owners SET
              document = CASE WHEN ${exists} THEN jsonb_set(document,'{custom_fields,invoiceHours}',coalesce(${value}::jsonb,'null'::jsonb))
                ELSE document #- '{custom_fields,invoiceHours}' END,
              snapshot = CASE WHEN ${exists} THEN jsonb_set(snapshot,'{custom_fields,invoiceHours}',coalesce(${value}::jsonb,'null'::jsonb))
                ELSE snapshot #- '{custom_fields,invoiceHours}' END,
              revision=${next.revision}
            WHERE side=${side} AND owner_key=${old.key} AND identity=${identity(p)}
              AND revision=${old.revision} AND document=${tx.json(old.row)}::jsonb
              AND snapshot=${tx.json(old.snapshot)}::jsonb RETURNING owner_key`;
          assert.equal(rows.length, 1, "Physical CAS lost");
          if (side === "canonical" && this.failAfterCanonical) throw new Error("Injected shadow failure");
        }
        return true;
      },
      saveReceipt: async (key: string, receipt: Receipt) => {
        await tx`INSERT INTO repair_receipts VALUES(${key},${tx.json(receipt)}::jsonb)
          ON CONFLICT(key) DO UPDATE SET receipt=excluded.receipt`;
      },
      audit: async (event: AuditEvent) => {await tx`INSERT INTO repair_audit(event) VALUES(${tx.json(event)}::jsonb)`;},
    };
  }
  async preflight<T>(fn: (tx: RepairTransaction) => Promise<T>): Promise<T> {
    return this.sql.begin("isolation level repeatable read read only", async tx => {
      await this.guard(tx);
      return fn(this.adapter(tx));
    }) as Promise<T>;
  }
  async transaction<T>(fn: (tx: RepairTransaction) => Promise<T>): Promise<T> {
    const result = await this.sql.begin(async tx => {
      await this.guard(tx);
      // All fixture writers, inserts and alias changes are blocked too, not
      // merely the target row. A production writer fence must be equally strong.
      await tx.unsafe("LOCK TABLE repair_cases,repair_owners,repair_receipts IN EXCLUSIVE MODE");
      return fn(this.adapter(tx));
    }) as T;
    if (this.loseNextCommitResponse) {
      this.loseNextCommitResponse = false;
      throw new Error("Injected lost COMMIT acknowledgment");
    }
    return result;
  }
  async auditFailure(event: AuditEvent) {
    await this.sql.begin(async (tx: any) => {
      await this.guard(tx);
      await tx`INSERT INTO repair_audit(event) VALUES(${tx.json(event)}::jsonb)`;
    });
  }
  async close() {await this.sql.end();}
}
