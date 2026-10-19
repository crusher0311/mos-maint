import assert from "node:assert/strict";
import {test} from "node:test";
import net from "node:net";
import {createHash} from "node:crypto";
import {evidenceDigest as digest, prepareInvoiceMetadataProposal} from "../scripts/invoice-metadata-repair-plan";
import {executeOfflinePlan, finalizeOfflinePlan, inspectOfflineOutcomes, type Approval, type CurrentCase, type FinalPlan,
  type OriginalProposal, type Readiness} from "../scripts/invoice-metadata-executor";
import {DisposableMetadataStore, DISPOSABLE_SCHEMA, identity} from "../scripts/invoice-metadata-disposable-store";
import {invoiceHoursEvidence} from "../lib/invoice-hours-contract";

const now = Date.parse("2026-10-19T12:00:00Z");
const readiness: Readiness = {
  requiredWriterIds: ["web", "callback", "background"],
  writers: ["web", "callback", "background"].map(id => ({id, deployedRevision: "fixture-build",
    runtimeRevision: "fixture-build", preservationVerified: true, rawRetentionVerified: true,
    invoiceEvidenceVersion: 1, verificationDigest: digest({fixture: id})})),
  verifiedAt: now, writersQuiesced: true, quiescenceEvidenceDigest: digest("fixture-fence"),
  topology: "disposable-atomic-canonical-shadow",
};
function fixture(n = 1, explicitNull = false) {
  const id = `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
  const raw = {ID: id, Type: "Invoice", WorkflowStage: "Invoice", InvoiceNumber: n,
    InvoiceTime: "2026-10-16T12:00:00Z", ServicePackages: [], DeferredServicePackages: []};
  const source = {shopId: 9000 + n, sourceIds: [id], copies: [{shopId: 9000 + n, raw}]};
  const snapshot = {id: createHash("sha256").update(`${source.shopId}:fixture-row-${n}`).digest("hex"),
    shop_id: source.shopId, status: "closed",
    soft_delete: {isDeleted: false}, provenance: {sourceSystem: "protractor",
      sourceIds: [{system: "protractor", idType: "invoice_id", idValue: id}]},
    custom_fields: {...(explicitNull ? {invoiceHours: null} : {}), unrelated: {nested: [1, null, "retain"]}}};
  const proposal = prepareInvoiceMetadataProposal(source, [snapshot]);
  const owner = {key: `fixture-row-${n}`, revision: 10, snapshot: structuredClone(snapshot),
    row: {...structuredClone(snapshot), id: `fixture-row-${n}`, work_order_number: n, closed_date: "2026-10-16",
      raw_payload: raw, grand_total: "125.00", labor_total: "99.00", payments: [{amount: "125.00"}],
      jobs: [{id: "native-job", lines: [{quantity: 0, cost: "2.00", price: "0.00"}]}]}};
  const current: CurrentCase = {canonical: [owner], shadow: [{...structuredClone(owner), key: `shadow-${n}`}],
    source, holds: [], evidenceInventory: {archives: [digest(raw)], currentCopies: [digest(raw)], holdsRevision: 1}};
  return {proposal, current};
}
function approve(plan: FinalPlan, action: Approval["action"] = "apply"): Approval {
  return {action, planDigest: digest(plan),
    preflightDigest: digest({cases: plan.cases, readiness: plan.readiness, at: plan.preflightAt}),
    approvedBy: "offline-fixture-operator", approvalReference: `fixture-${action}`,
    approvedAt: now, expiresAt: now + 60_000};
}
const store = new DisposableMetadataStore(process.env.INVOICE_OWNER_TEST_SOCKET!);
async function reset(count = 1, nullFirst = false) {
  await store.sql.unsafe("TRUNCATE repair_cases,repair_owners,repair_receipts,repair_audit");
  store.failAfterCanonical = false; store.loseNextCommitResponse = false; store.failOnIdentity = null;
  const fixtures = Array.from({length: count}, (_, i) => fixture(i + 1, nullFirst && i === 0));
  for (const {proposal, current} of fixtures) {
    const {canonical, shadow, ...context} = current;
    await store.sql`INSERT INTO repair_cases VALUES(${identity(proposal)},${store.sql.json(context as any)}::jsonb)`;
    for (const side of ["canonical", "shadow"] as const) {
      for (const o of current[side]) {
        await store.sql`INSERT INTO repair_owners VALUES(${identity(proposal)},${side},${o.key},${o.revision},
          ${store.sql.json(o.snapshot as any)},${store.sql.json(o.row)})`;
      }
    }
  }
  const original: OriginalProposal = {format: "synthetic-fixture", proposals: fixtures.map(f => f.proposal),
    held: [], repairAuthorized: false, livePreflightRequired: true};
  const plan = await finalizeOfflinePlan(store, original, digest(original), readiness, now);
  return {plan, original, fixtures};
}
const read = (plan: FinalPlan, index = 0) => store.preflight(tx => tx.read(plan.proposals[index]));
const run = (plan: FinalPlan, action: Approval["action"] = "apply") => executeOfflinePlan(store, plan, approve(plan, action), () => now);
function withoutRepair(caseValue: CurrentCase) {
  const c = structuredClone(caseValue);
  for (const side of ["canonical", "shadow"] as const) for (const o of c[side]) {
    delete o.row.custom_fields.invoiceHours; delete o.snapshot.custom_fields.invoiceHours;
    o.revision = 0;
  }
  return c;
}

test("credential-free, network-denied disposable executor", async t => {
  try {
    await store.sql.unsafe(DISPOSABLE_SCHEMA);
    await t.test("network and production destinations are denied", async () => {
      assert.throws(() => net.connect({host: "127.0.0.1", port: 5432}), /network denied/);
      await assert.rejects(fetch("https://example.com"), /network denied/);
      assert.throws(() => new DisposableMetadataStore("/tmp/not-approved"), /match/);
      assert.equal(process.env.SUPABASE_PROD_DATABASE_URL, undefined);
      assert.equal(process.env.MONGODB_PASSWORD, undefined);
    });
    await t.test("100 exact metadata patches, source generator compatible, all financial fields unchanged", async () => {
      const {plan} = await reset(100, true);
      const result = await run(plan);
      assert.equal(result.length, 100);
      for (let i = 0; i < 100; i++) {
        const after = await read(plan, i), before = plan.cases[i];
        assert.deepEqual(withoutRepair(after), withoutRepair(before));
        assert.deepEqual(after.canonical[0].row.custom_fields.invoiceHours,
          invoiceHoursEvidence(before.source.copies[0].raw));
        assert.deepEqual(after.canonical[0].row.custom_fields, after.shadow[0].row.custom_fields);
      }
      assert.equal((await store.sql`SELECT count(*)::int n FROM repair_receipts`)[0].n, 100);
      assert.equal((await run(plan))[0].outcome, "already_applied");
    });
    await t.test("authorization, digest, expiration, writer inventory and compatibility gates", async () => {
      const {plan, original} = await reset();
      for (const mutate of [
        (a: Approval) => {a.planDigest = digest("other");},
        (a: Approval) => {a.preflightDigest = digest("other");},
        (a: Approval) => {a.approvedBy = "";},
        (a: Approval) => {a.expiresAt = now;},
        (a: Approval) => {a.approvedAt = now - 1;},
      ]) {
        const a = approve(plan); mutate(a);
        await assert.rejects(executeOfflinePlan(store, plan, a, () => now));
      }
      for (const mutate of [
        (r: Readiness) => {r.writers.pop();},
        (r: Readiness) => {r.writers[0].preservationVerified = false;},
        (r: Readiness) => {r.writers[0].rawRetentionVerified = false;},
        (r: Readiness) => {r.writers[0].invoiceEvidenceVersion = 2;},
        (r: Readiness) => {r.writers[0].runtimeRevision = "old";},
        (r: Readiness) => {r.writersQuiesced = false;},
        (r: Readiness) => {r.verifiedAt = now - 300_001;},
      ]) {
        const r = structuredClone(readiness); mutate(r);
        await assert.rejects(finalizeOfflinePlan(store, original, digest(original), r, now));
      }
      await assert.rejects(finalizeOfflinePlan(store, original, digest("wrong-plan"), readiness, now));
      assert.equal((await store.sql`SELECT count(*)::int n FROM repair_receipts`)[0].n, 0);
    });
    await t.test("stale row, source, hold, alias and shadow changes reject without rebase", async () => {
      for (const sql of [
        "UPDATE repair_owners SET document=jsonb_set(document,'{grand_total}','\"999.00\"')",
        "UPDATE repair_owners SET revision=revision+1",
        "UPDATE repair_owners SET snapshot=jsonb_set(snapshot,'{provenance,sourceIds}','[]')",
        "UPDATE repair_owners SET document=jsonb_set(document,'{custom_fields,invoiceHours}','null') WHERE side='shadow'",
        "UPDATE repair_cases SET context=jsonb_set(context,'{holds}','[\"financial-review\"]')",
        "UPDATE repair_cases SET context=jsonb_set(context,'{source,copies,0,raw,InvoiceNumber}','999')",
        "UPDATE repair_cases SET context=jsonb_set(context,'{evidenceInventory,archives}','[\"new-archive\"]')",
      ]) {
        const {plan} = await reset();
        await store.sql.unsafe(sql);
        const changed = await read(plan);
        await assert.rejects(run(plan), /Stale state/);
        assert.deepEqual(await read(plan), changed);
      }
    });
    await t.test("competing owner and cross-shop conflicts fail preflight and execution", async () => {
      const {plan, original} = await reset();
      await store.sql.unsafe(`INSERT INTO repair_owners
        SELECT identity,side,owner_key||'-duplicate',revision,snapshot,document
        FROM repair_owners WHERE side='canonical'`);
      await assert.rejects(finalizeOfflinePlan(store, original, digest(original), readiness, now), /Unique current owner/);
      await assert.rejects(run(plan), /Stale state/);
      const next = await reset();
      await store.sql.unsafe("UPDATE repair_owners SET snapshot=jsonb_set(snapshot,'{shop_id}','999')");
      await assert.rejects(finalizeOfflinePlan(store, next.original, digest(next.original), readiness, now), /Projection does not match row/);
    });
    await t.test("concurrent retry makes one repair; lost commit response recovers by receipt", async () => {
      const {plan} = await reset();
      const results = await Promise.all([run(plan), run(plan)]);
      assert.deepEqual(results.map(r => r[0].outcome).sort(), ["already_applied", "applied"]);
      assert.equal((await read(plan)).canonical[0].revision, 11);
      const next = await reset();
      store.loseNextCommitResponse = true;
      await assert.rejects(run(next.plan), /lost COMMIT/);
      assert.equal((await run(next.plan))[0].outcome, "already_applied");
      assert.equal((await read(next.plan)).canonical[0].revision, 11);
      await assert.rejects(executeOfflinePlan(store, next.plan, approve(next.plan), () => now + 400_000), /expired/);
      assert.deepEqual(await inspectOfflineOutcomes(store, next.plan),
        [{index: 0, state: "applied", currentStateMatches: true}]);
      const events = await store.sql`SELECT event FROM repair_audit ORDER BY sequence`;
      assert.deepEqual(events.map(e => e.event.outcome), ["applied", "rejected_or_unknown", "already_applied"]);
    });
    await t.test("shadow failure rolls back pair and receipt; mid-plan failure resumes only unfinished entries", async () => {
      const {plan} = await reset(3);
      store.failAfterCanonical = true;
      await assert.rejects(run(plan), /shadow failure/);
      assert.deepEqual(await read(plan), plan.cases[0]);
      assert.equal((await store.sql`SELECT count(*)::int n FROM repair_receipts`)[0].n, 0);
      store.failAfterCanonical = false;
      store.failOnIdentity = identity(plan.proposals[1]);
      await assert.rejects(run(plan), /owner failure/);
      assert.equal((await read(plan)).canonical[0].revision, 11);
      assert.deepEqual(await read(plan, 1), plan.cases[1]);
      assert.deepEqual(await read(plan, 2), plan.cases[2]);
      store.failOnIdentity = null;
      assert.deepEqual((await run(plan)).map(r => r.outcome), ["already_applied", "applied", "applied"]);
    });
    await t.test("rollback restores absent vs null, requires its own approval, never overwrites intervening edits", async () => {
      const {plan} = await reset(2, true);
      await run(plan);
      const tamperedApproval = approve(plan, "rollback"); tamperedApproval.planDigest = digest("different");
      await assert.rejects(executeOfflinePlan(store, plan, tamperedApproval, () => now));
      store.loseNextCommitResponse = true;
      await assert.rejects(run(plan, "rollback"), /lost COMMIT/);
      assert.deepEqual((await run(plan, "rollback")).map(r => r.outcome), ["already_rolled_back", "rolled_back"]);
      assert.equal((await read(plan)).canonical[0].row.custom_fields.invoiceHours, null);
      assert.equal(Object.hasOwn((await read(plan, 1)).canonical[0].row.custom_fields, "invoiceHours"), false);
      assert.deepEqual(withoutRepair(await read(plan)), withoutRepair(plan.cases[0]));
      await assert.rejects(run(plan), /cannot be reapplied/);
      const next = await reset(); await run(next.plan);
      await store.sql.unsafe("UPDATE repair_owners SET document=jsonb_set(document,'{grand_total}','\"999.00\"') WHERE side='shadow'");
      await assert.rejects(run(next.plan, "rollback"), /Conditional rollback/);
      assert.deepEqual(await inspectOfflineOutcomes(store, next.plan),
        [{index: 0, state: "applied", currentStateMatches: false}]);
    });
    await t.test("aliases outside the grouping key, changed primary keys and modified proposals cannot bypass binding", async () => {
      let f = await reset();
      await store.sql`INSERT INTO repair_cases SELECT 'misgrouped',context FROM repair_cases`;
      await store.sql.unsafe(`INSERT INTO repair_owners
        SELECT 'misgrouped',side,owner_key||'-alias',revision,snapshot,document
        FROM repair_owners WHERE side='shadow'`);
      await assert.rejects(run(f.plan), /Stale state/);
      await assert.rejects(finalizeOfflinePlan(store, f.original, digest(f.original), readiness, now), /Unique current owner/);
      f = await reset();
      await store.sql.unsafe("UPDATE repair_owners SET owner_key='changed' WHERE side='canonical'");
      await assert.rejects(finalizeOfflinePlan(store, f.original, digest(f.original), readiness, now), /primary key/);
      f = await reset();
      const changed = structuredClone(f.plan);
      changed.proposals[0].patch.value.sold = 50;
      await assert.rejects(executeOfflinePlan(store, changed, approve(f.plan), () => now));
      assert.deepEqual(await inspectOfflineOutcomes(store, f.plan), [{index: 0, state: "not_committed"}]);
    });
    await t.test("read-only preflight refuses writes and bounded lock waits fail closed", async () => {
      await assert.rejects(store.sql.begin("read only", async tx => {await tx.unsafe("DELETE FROM repair_cases");}),
        (e: any) => e.code === "25006");
      const {plan} = await reset();
      let locked!: () => void;
      const ready = new Promise<void>(resolve => {locked = resolve;});
      const blocker = store.sql.begin(async tx => {
        await tx.unsafe("LOCK TABLE repair_owners IN EXCLUSIVE MODE"); locked();
        await tx.unsafe("SELECT pg_sleep(1.3)");
      });
      await ready;
      await assert.rejects(run(plan), (e: any) => e.code === "55P03");
      await blocker;
      assert.deepEqual(await read(plan), plan.cases[0]);
    });
  } finally {await store.close();}
});
