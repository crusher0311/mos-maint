/**
 * Production-shaped execution preparation, constrained to the existing
 * disposable socket/marker constructor. There is NO live connection factory.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { LocalDualMetadataStore } from "./invoice-metadata-dual-store";
import { readNativeInvoiceEvidence } from "./invoice-native-evidence";
import { evidenceDigest as digest, prepareInvoiceMetadataProposal } from "./invoice-metadata-repair-plan";
import { type OriginalProposal } from "./invoice-metadata-executor";
import {
  decodeNativeBson, encodeNativeBson, invoiceField, mapNativePostgres, mapNativeMongo,
  nativePostgresCas, nativeMongoCas, type InvoiceField,
} from "./invoice-native-schema";
import { requireHoldCoverage } from "../lib/invoice-repair/hold-registry";
import { requireRepairApproval } from "../lib/invoice-repair/approvals";
import { verifyInvoiceRepairWriters } from "../lib/invoice-repair/writer-verification";
import { INVOICE_FENCE_LOCK } from "../lib/invoice-repair/fence";

type Evidence = Awaited<ReturnType<typeof readNativeInvoiceEvidence>>;
type Pair = Pick<Evidence, "canonical" | "shadow">;
type Entry = { operation: string; proposal: OriginalProposal["proposals"][number];
  original: Evidence; apply: Pair; rollback: Pair; holdReview: string; holdDigest: string };
export interface NativeRepairPlan {
  version: 1; original: OriginalProposal; writerDigest: string;
  preparedAt: number; expiresAt: number; entries: Entry[];
}
const equal = (a: unknown, b: unknown) => assert.equal(digest(a), digest(b), "Bound native state/evidence changed");

export class DisposableNativeInvoiceStore extends LocalDualMetadataStore {
  nativeFault: "canonical" | "shadow" | "completed" | null = null;
  private async exclusive(tx: any) {
    await this.guard(tx);
    await tx.unsafe("SELECT pg_advisory_xact_lock($1,$2)", [...INVOICE_FENCE_LOCK]);
    const accesses = await tx.unsafe("SELECT id FROM invoice_repair_access LIMIT 1");
    assert.equal(accesses.length, 0, "Unresolved or in-flight ordinary access");
    const installations = await tx.unsafe("SELECT installation_key FROM invoice_repair_installation WHERE id=1 AND protocol=1");
    const mongo = await this.db.collection("invoice_repair_installation").findOne({ _id: "coordinator" as any });
    assert.equal(installations.length, 1);
    assert.equal(mongo?.installationKey, installations[0].installation_key, "Wrong Mongo/coordinator binding");
  }
  private async pairAfter(tx: any, before: Pair, field: InvoiceField, operation: string): Promise<Pair> {
    const [row] = await tx.unsafe(`SELECT $1::text id,
      (CASE WHEN $3::boolean THEN jsonb_set($2::text::jsonb,'{custom_fields,invoiceHours}',$4::text::jsonb)
      ELSE $2::text::jsonb #- '{custom_fields,invoiceHours}' END)::text full_state`,
    [before.canonical.id, before.canonical.fullState, field.present,
      field.present ? JSON.stringify(field.value) : "null"]);
    const doc = decodeNativeBson(before.shadow.fullStateBson);
    if (field.present) doc.customFields.invoiceHours = field.value;
    else delete doc.customFields.invoiceHours;
    doc.invoiceMetadataRepair = { operation };
    const normalized = decodeNativeBson(encodeNativeBson(doc));
    return { canonical: mapNativePostgres(row), shadow: mapNativeMongo(normalized) };
  }
  async finalizeNative(original: OriginalProposal, expectedDigest: string, holdReviews: Record<number, string>) {
    original = structuredClone(original);
    equal(digest(original), expectedDigest);
    assert.equal(original.repairAuthorized, false);
    assert.equal(original.livePreflightRequired, true);
    assert.deepEqual(original.held, []);
    assert.ok(original.proposals.length > 0 && original.proposals.length <= 100);
    return this.sql.begin(async (tx: any) => {
      await this.exclusive(tx);
      const fence = await tx.unsafe("SELECT operation FROM invoice_repair_fence WHERE id=1");
      assert.equal(fence[0]?.operation, null);
      const writerDigest = await verifyInvoiceRepairWriters(tx);
      const entries: Entry[] = [];
      for (const proposal of original.proposals) {
        const current = await readNativeInvoiceEvidence(tx, this.db, proposal.shopId, proposal.sourceId);
        equal(prepareInvoiceMetadataProposal(current.source, [current.canonical.target]), proposal);
        const shadowProposal = prepareInvoiceMetadataProposal(current.source,
          [{ ...current.shadow.target, id: current.canonical.target.id }]);
        equal(shadowProposal.patch, proposal.patch);
        equal(shadowProposal.sourceCaseDigest, proposal.sourceCaseDigest);
        const holdReview = holdReviews[proposal.shopId];
        const holdDigest = await requireHoldCoverage(tx, proposal, [proposal.sourceId], current.inventoryDigest, holdReview);
        const operation = randomUUID();
        const applied = await this.pairAfter(tx, current, { present: true, value: proposal.patch.value }, `${operation}:apply`);
        const rollback = await this.pairAfter(tx, current,
          invoiceField(current.canonical.target.custom_fields), `${operation}:rollback`);
        // Restore each store's own missing/null preimage, not the PG projection.
        const shadowRollback = await this.pairAfter(tx, current,
          invoiceField(current.shadow.target.custom_fields), `${operation}:rollback`);
        rollback.shadow = shadowRollback.shadow;
        entries.push({ operation, proposal, original: current, apply: applied, rollback, holdReview, holdDigest });
      }
      assert.equal(new Set(entries.map(e => e.original.canonical.id)).size, entries.length, "Repeated native owner");
      return { version: 1 as const, original, writerDigest, preparedAt: Date.now(),
        expiresAt: Date.now() + 5 * 60_000, entries };
    }) as Promise<NativeRepairPlan>;
  }
  static evidenceDigest(plan: NativeRepairPlan) {
    return digest({ writer: plan.writerDigest, entries: plan.entries.map(e =>
      ({ source: e.original.source, inventory: e.original.inventoryDigest, holds: e.holdDigest })) });
  }
  async executeNative(plan: NativeRepairPlan, action: "apply" | "rollback", approvalId: string, actor: string) {
    plan = structuredClone(plan);
    assert.equal(plan.version, 1);
    assert.ok(plan.entries.length > 0 && plan.entries.length <= 100);
    assert.equal(plan.original.repairAuthorized, false);
    assert.equal(plan.original.livePreflightRequired, true);
    assert.deepEqual(plan.original.held, []);
    assert.equal(new Set(plan.entries.map(e => e.operation)).size, plan.entries.length, "Repeated operation");
    assert.equal(new Set(plan.entries.map(e => e.original.canonical.id)).size, plan.entries.length, "Repeated owner");
    equal(plan.original.proposals, plan.entries.map(e => e.proposal));
    for (const entry of plan.entries) {
      equal(prepareInvoiceMetadataProposal(entry.original.source, [entry.original.canonical.target]), entry.proposal);
      equal(prepareInvoiceMetadataProposal(entry.original.source,
        [{ ...entry.original.shadow.target, id: entry.original.canonical.target.id }]).patch, entry.proposal.patch);
      const operation = `${entry.operation}:${action}`;
      try {
      const before = action === "apply" ? entry.original : entry.apply;
      const after = entry[action];
      const phase = async (name: string, work: (tx: any, current: Evidence, journal: any) => Promise<void>) => {
        await this.sql.begin(async (tx: any) => {
          await this.exclusive(tx);
          equal(await this.pairAfter(tx, entry.original, { present: true, value: entry.proposal.patch.value },
            `${entry.operation}:apply`), entry.apply);
          const expectedRollback = await this.pairAfter(tx, entry.original,
            invoiceField(entry.original.canonical.target.custom_fields), `${entry.operation}:rollback`);
          expectedRollback.shadow = (await this.pairAfter(tx, entry.original,
            invoiceField(entry.original.shadow.target.custom_fields), `${entry.operation}:rollback`)).shadow;
          equal(expectedRollback, entry.rollback);
          assert.ok(plan.preparedAt <= Date.now() && Date.now() < plan.expiresAt, "Native preflight expired");
          assert.ok(plan.expiresAt <= plan.preparedAt + 5 * 60_000);
          await requireRepairApproval(tx, approvalId, actor, {
            action, planDigest: digest(plan), evidenceDigest: DisposableNativeInvoiceStore.evidenceDigest(plan),
          });
          equal(await verifyInvoiceRepairWriters(tx), plan.writerDigest);
          const [fence] = await tx.unsafe("SELECT operation FROM invoice_repair_fence WHERE id=1 FOR UPDATE");
          const [journal] = await tx.unsafe("SELECT * FROM invoice_repair_journal WHERE operation=$1", [operation]);
          // Earlier completed entries can be inspected while a later entry in
          // this exact plan owns the unresolved fence.
          const earlier = journal?.phase === "completed" && plan.entries.some(e => `${e.operation}:${action}` === fence.operation);
          assert.ok(fence.operation === null || fence.operation === operation || earlier, "Another repair owns the fence");
          if (journal) equal(journal.binding, digest({ plan, action }));
          const current = await readNativeInvoiceEvidence(tx, this.db, entry.proposal.shopId, entry.proposal.sourceId);
          equal(current.source, entry.original.source);
          equal(current.inventoryDigest, entry.original.inventoryDigest);
          equal(await requireHoldCoverage(tx, entry.proposal, [entry.proposal.sourceId],
            current.inventoryDigest, entry.holdReview), entry.holdDigest);
          await work(tx, current, journal);
          await tx.unsafe("INSERT INTO invoice_repair_audit(operation,approval_id,outcome) VALUES($1,$2,$3)",
            [operation, approvalId, name]);
        });
      };
      let done = false;
      await phase("prepare", async (tx, current, journal) => {
        if (journal?.phase === "completed") {
          equal({ canonical: current.canonical, shadow: current.shadow }, after); done = true; return;
        }
        if (journal) return;
        equal({ canonical: current.canonical, shadow: current.shadow },
          { canonical: before.canonical, shadow: before.shadow });
        const completedApply = await tx.unsafe("SELECT phase FROM invoice_repair_journal WHERE operation=$1", [`${entry.operation}:apply`]);
        if (action === "rollback") assert.equal(completedApply[0]?.phase, "completed", "Committed apply required");
        const rolledBack = await tx.unsafe("SELECT phase FROM invoice_repair_journal WHERE operation=$1", [`${entry.operation}:rollback`]);
        if (action === "apply") assert.equal(rolledBack.length, 0, "Cannot reapply a rolled-back plan");
        await tx.unsafe("UPDATE invoice_repair_fence SET operation=$1 WHERE id=1", [operation]);
        await tx.unsafe("INSERT INTO invoice_repair_journal(operation,binding,phase,plan) VALUES($1,$2,'prepared',$3::text::jsonb)",
          [operation, digest({ plan, action }), JSON.stringify(plan)]);
      });
      if (done) continue;
      await phase("canonical", async (tx, current, journal) => {
        assert.ok(journal && ["prepared", "canonical"].includes(journal.phase));
        equal(current.canonical, journal.phase === "canonical" ? after.canonical : before.canonical);
        if (journal.phase === "canonical") return;
        equal(current.shadow, before.shadow);
        const cas = nativePostgresCas(before.canonical, invoiceField(after.canonical.target.custom_fields));
        assert.equal((await tx.unsafe(cas.sql, cas.params)).length, 1, "Native canonical CAS lost");
        await tx.unsafe("UPDATE invoice_repair_journal SET phase='canonical' WHERE operation=$1", [operation]);
      });
      if (this.nativeFault === "canonical") throw Error("Injected lost native canonical response");
      await phase("shadow", async (_tx, current, journal) => {
        assert.equal(journal.phase, "canonical");
        equal(current.canonical, after.canonical);
        if (current.shadow.fullStateBson === after.shadow.fullStateBson) return;
        equal(current.shadow, before.shadow);
        const cas = nativeMongoCas(before.shadow, invoiceField(after.shadow.target.custom_fields));
        const update: any = cas.update;
        update.$set = { ...update.$set, invoiceMetadataRepair: { operation } };
        const result = await this.db.collection("normalized_work_orders").updateOne(cas.filter, update, { writeConcern: { w: "majority" } });
        assert.equal(result.modifiedCount, 1, "Native shadow CAS lost");
      });
      if (this.nativeFault === "shadow") throw Error("Injected lost native shadow response");
      await phase("completed", async (tx, current) => {
        equal({ canonical: current.canonical, shadow: current.shadow }, after);
        await tx.unsafe("UPDATE invoice_repair_journal SET phase='completed' WHERE operation=$1", [operation]);
        await tx.unsafe("UPDATE invoice_repair_fence SET operation=null,generation=generation+1 WHERE id=1 AND operation=$1", [operation]);
      });
      if (this.nativeFault === "completed") throw Error("Injected lost native completion response");
      } catch (error) {
        await this.sql.begin(async (tx: any) => {
          await this.guard(tx);
          await tx.unsafe("INSERT INTO invoice_repair_audit(operation,approval_id,outcome) VALUES($1,$2,'rejected_or_unknown')",
            [operation, approvalId]);
        });
        throw error;
      }
    }
  }
  async inspectNative(plan: NativeRepairPlan) {
    return this.sql.begin("read only", async (tx: any) => {
      await this.guard(tx);
      const results = [];
      for (const entry of plan.entries) {
        const journals = await tx.unsafe("SELECT operation,binding,phase FROM invoice_repair_journal WHERE operation=ANY($1::text[])",
          [[`${entry.operation}:apply`, `${entry.operation}:rollback`]]);
        const current = await readNativeInvoiceEvidence(tx, this.db, entry.proposal.shopId, entry.proposal.sourceId);
        const pair = { canonical: current.canonical, shadow: current.shadow };
        results.push({ operation: entry.operation, journals,
          matchesApplied: digest(pair) === digest(entry.apply), matchesRolledBack: digest(pair) === digest(entry.rollback) });
      }
      const [fence] = await tx.unsafe("SELECT operation FROM invoice_repair_fence WHERE id=1");
      return { fenced: fence.operation !== null, results };
    });
  }
}
