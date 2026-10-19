import "./helpers/deny-network-egress";
import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { applyIndexRepair, prepareIndexRepair, type RepairStore } from "../lib/protractor-index-repair";
import { reviewDigest } from "../lib/protractor-held-review";
import { indexRepairStore } from "../scripts/protractor-weekend/index-repair-store";

const scope = { campaignId: "protractor-weekend-2026-10-17", shopId: 139, days: ["2026-10-16"] };
const id = "abcd1234-1234-1234-1234-123456789abc";
function fixture() {
  const invoice = { ID: id, Header: { LastModifiedTime: "2026-10-16T12:00:00Z" },
    ServicePackages: ["job-1", "job-2"].map(ID => ({ ID, Title: "Oil change",
      ServicePackageLines: [{ Type: "Labor", Description: "Labor", Quantity: 2, Price: 100 }] })) };
  const page = { _id: "page", ...scope, day: scope.days[0], invoices: [invoice], digest: reviewDigest([invoice]) };
  const receipt = { _id: `${scope.campaignId}:${scope.shopId}:${reviewDigest(id)}`,
    ...scope, day: scope.days[0], status: "existing-needs-index-review", sourceDigest: reviewDigest(invoice) };
  const original = { servicePackageId: "JOB-1", metadata: { sourceType: "protractor" }, totals: { totalAmount: 999 } };
  const rows: any[] = [original];
  const owner = { canonical: ["pg"], legacy: ["mongo"] };
  const checkpoint = { ...scope, day: scope.days[0], unresolved: 2 };
  let hook = async () => {}, lost = false, calls = 0;
  const store: RepairStore = {
    campaign: async () => ({ shops: [{ shopId: scope.shopId, pendingDays: scope.days, priorJobId: "prior" }] }),
    cursor: async () => ({ heldDays: scope.days }), pages: async () => [page],
    receipts: async () => [receipt], days: async () => [checkpoint],
    receipt: async key => key === receipt._id ? receipt : null,
    ownership: async () => owner,
    index: async () => rows.map(r => ({ servicePackageId: r.servicePackageId, sourceType: r.metadata.sourceType })),
    insertOnly: async (_m, added, check) => {
      calls++; await hook(); await check();
      rows.push(...added);
      if (lost) throw Error("lost response");
    },
  };
  return { store, rows, original, invoice, page, receipt, owner, checkpoint,
    hook: (fn: typeof hook) => { hook = fn; }, lose: () => { lost = true; }, calls: () => calls };
}
async function prepared(f = fixture()) {
  const manifest = await prepareIndexRepair(f.store, scope, id);
  const approval = { operation: manifest.operation, manifestDigest: reviewDigest(manifest),
    approvedBy: "operator", approvalReference: "approved-change",
    expiresAt: new Date(Date.now() + 600000).toISOString(), writersPaused: true as const, environment: "test" };
  return { f, manifest, approval };
}
test("separate approval gate refuses missing, expired, wrong scope/environment and non-quiesced approval before action", async () => {
  const { f, manifest, approval } = await prepared();
  for (const change of [{ manifestDigest: "bad" }, { expiresAt: "2000-01-01" }, { approvedBy: "" },
    { writersPaused: false }, { environment: "production" }, { approvalReference: "" },
    { operation: "ingest" }, { expiresAt: "invalid" }]) {
    await assert.rejects(applyIndexRepair(f.store, manifest, { ...approval, ...change } as any, "test"));
  }
  await assert.rejects(applyIndexRepair(f.store, { ...manifest, scope: { ...scope, shopId: 1 } }, approval, "test"));
  assert.equal(f.calls(), 0);
});
test("inserts only missing package and preserves financial rows, receipts and checkpoints byte-for-byte", async () => {
  const { f, manifest, approval } = await prepared();
  const before = JSON.stringify([f.original, f.receipt, f.checkpoint]);
  assert.deepEqual(await applyIndexRepair(f.store, manifest, approval, "test"), { status: "inserted", inserted: 1 });
  assert.equal(f.rows[1].servicePackageId, "job-2");
  assert.equal(f.rows[1].lines[0].lineType, "labor");
  assert.equal(f.rows[1].totals.laborHours, 2);
  assert.equal(JSON.stringify([f.original, f.receipt, f.checkpoint]), before);
});
test("lost response is reconciled by key presence; rerun does not overwrite or double-insert", async () => {
  const { f, manifest, approval } = await prepared(); f.lose();
  await assert.rejects(applyIndexRepair(f.store, manifest, approval, "test"), /lost/);
  const before = JSON.stringify(f.rows);
  assert.deepEqual(await applyIndexRepair(f.store, manifest, approval, "test"), { status: "already-present", inserted: 0 });
  assert.equal(JSON.stringify(f.rows), before);
  assert.equal(f.calls(), 1);
});
test("concurrent archive, either owner, receipt, prior receipt, checkpoint and index changes hold before insertion", async () => {
  const changes: ((f: ReturnType<typeof fixture>) => void)[] = [
    f => { f.page.digest = "corrupt"; },
    f => { f.invoice.ServicePackages[1].Title = "changed"; f.page.digest = reviewDigest([f.invoice]); },
    f => { f.owner.canonical = ["other"]; }, f => { f.owner.legacy = []; },
    f => { f.receipt.status = "processing"; },
    f => { f.store.receipt = async key => key === f.receipt._id ? f.receipt : { status: "processing" }; },
    f => { f.checkpoint.unresolved = 3; },
    f => { f.rows.push({ servicePackageId: "JOB-2", metadata: { sourceType: "protractor" }, totals: { totalAmount: 321 } }); },
    f => { f.store.ownership = async () => { throw Error("timeout"); }; },
  ];
  for (const change of changes) {
    const { f, manifest, approval } = await prepared();
    f.hook(async () => change(f));
    await assert.rejects(applyIndexRepair(f.store, manifest, approval, "test"));
    assert.equal(f.rows.filter(r => r._id).length, 0);
  }
});
test("fully present concurrent index keys are no-op, but a newly missing unapproved key is held", async () => {
  const { f, manifest, approval } = await prepared();
  f.rows.push({ ...f.original, servicePackageId: "JOB-2" });
  assert.equal((await applyIndexRepair(f.store, manifest, approval, "test")).status, "already-present");
  f.rows.splice(0, 1);
  await assert.rejects(applyIndexRepair(f.store, manifest, approval, "test"), /changed/);
});
test("adapter uses insertMany only, rechecks before staging/commit and never auto-retries lost commit", async () => {
  const { manifest } = await prepared();
  for (const fail of ["none", "commit", "second-check", "existing", "unique"]) {
    const events: string[] = [];
    let transaction = false;
    const session: any = {
      startTransaction: () => { transaction = true; events.push("start"); },
      commitTransaction: async () => { events.push("commit"); transaction = false; if (fail === "commit") throw Error(); },
      inTransaction: () => transaction, abortTransaction: async () => { events.push("abort"); transaction = false; },
      endSession: async () => { events.push("end"); },
    };
    const db: any = { collection: (name: string) => {
      assert.equal(name, "job_index");
      return {
        listIndexes: () => ({ toArray: async () => fail === "unique" ? [] :
          [{ unique: true, key: { shopId: 1, workOrderId: 1, servicePackageId: 1 } }] }),
        findOne: async (q: any, opts: any) => {
          assert.equal(opts.session, session);
          assert.ok(q.servicePackageId.test("JOB-2")); return fail === "existing" ? {} : null;
        },
        insertMany: async () => { events.push("insert"); },
      };
    } };
    const pg: any = { begin: async (fn: any) => fn({ unsafe: async (sql: string) => { events.push(sql); } }) };
    let checks = 0;
    const action = indexRepairStore(db, { startSession: () => session } as any, pg)
      .insertOnly(manifest, [{ workOrderId: id, servicePackageId: "job-2" }], async () => {
        events.push("check"); if (++checks === 2 && fail === "second-check") throw Error();
      });
    if (fail === "none") await action; else await assert.rejects(action);
    if (fail === "none" || fail === "commit") {
      assert.deepEqual(events.slice(-6), ["start", "check", "insert", "check", "commit", "end"]);
    } else assert.ok(!events.includes("commit"));
    assert.ok(events.filter(e => e === "insert").length <= 1);
  }
});
test("CLI invalid approval/mode fails offline before database imports", () => {
  const child = spawnSync(process.execPath, ["--import", "tsx", "scripts/protractor-weekend/index-repair.ts", "--apply"], {
    encoding: "utf8", timeout: 10000,
    env: { NODE_ENV: "test", PATH: process.env.PATH, NODE_OPTIONS: "--require ./tests/helpers/deny-network-egress.cjs" },
  });
  assert.equal(child.status, 1); assert.equal(child.stdout, "");
  assert.match(child.stderr, /held or unconfirmed/);
});
