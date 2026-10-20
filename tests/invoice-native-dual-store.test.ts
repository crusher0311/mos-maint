import assert from "node:assert/strict";
import { DisposableNativeInvoiceStore } from "../scripts/invoice-native-dual-store";
import { readNativeInvoiceEvidence } from "../scripts/invoice-native-evidence";
import { evidenceDigest as digest, prepareInvoiceMetadataProposal } from "../scripts/invoice-metadata-repair-plan";
import { HoldRegistry } from "../lib/invoice-repair/hold-registry";
import { recordRepairApproval } from "../lib/invoice-repair/approvals";
import { InvoiceFence } from "../lib/invoice-repair/fence";
import { guardPostgres } from "../lib/invoice-repair/guarded-drivers";
import { testProductionEntry } from "./invoice-production-entry.test";

export async function testNativeProtocol(sql: any, db: any) {
  const native = new DisposableNativeInvoiceStore(process.env.INVOICE_DUAL_SOCKET!,
    Number(process.env.INVOICE_DUAL_PORT), process.env.INVOICE_DUAL_MARKER!,
    process.env.INVOICE_DUAL_PORTS?.split(",").map(Number));
  const oldFetch = globalThis.fetch;
  const revision = "a".repeat(40), service = "srv-fixture", repository = "https://example.invalid/fixture";
  process.env.RENDER_API_KEY_PROD = "disposable-fixture-not-a-credential";
  globalThis.fetch = (async (input: any) => {
    const path = new URL(String(input)).pathname;
    const response = path === "/v1/services" ? [{ service: { id: service, repo: repository,
      type: "background_worker", suspended: "not_suspended" } }]
      : path === `/v1/services/${service}/deploys` ? [{ deploy: {
        id: "fixture-deploy", status: "live", commit: { id: revision },
      } }] : null;
    assert.ok(response, "Unexpected deployment read");
    return new Response(JSON.stringify(response), { status: 200 });
  }) as typeof fetch;
  try {
    await sql.unsafe("DELETE FROM invoice_repair_access"); // fixture-only failed admissions from previous test
    await db.collection("normalized_work_orders").deleteOne({ _id: "competing-native" });
    await sql.unsafe(`INSERT INTO invoice_repair_writer_inventory VALUES($1,$2,$3,$4,$5,
      clock_timestamp(),clock_timestamp()+interval '5 minutes')`,
    [service, repository, revision, "b".repeat(64), "fixture-authenticated-admin"]);
    await sql.unsafe(`INSERT INTO invoice_repair_writer_runtime VALUES($1,$2,$3,1,clock_timestamp())`,
      [service, "fixture-instance", revision]);
    const shopId = 9200, sourceId = "22222222-2222-4222-8222-222222222222";
    const source = await readNativeInvoiceEvidence(sql, db, shopId, sourceId);
    const proposal = prepareInvoiceMetadataProposal(source.source, [source.canonical.target]);
    const original = { proposals: [proposal], held: [], repairAuthorized: false as const, livePreflightRequired: true as const };
    const actor = "fixture-authenticated-admin";
    const review = await new HoldRegistry(sql).review({ shopId, provider: "protractor" }, { actorId: actor },
      source.inventoryDigest, "fixture-complete-coverage-review");
    const plan = await native.finalizeNative(original, digest(original), { [shopId]: review });
    const approval = async (action: "apply" | "rollback") => recordRepairApproval(sql, actor, {
      action, planDigest: digest(plan), evidenceDigest: DisposableNativeInvoiceStore.evidenceDigest(plan),
    });
    const apply = await approval("apply");
    await assert.rejects(native.executeNative(plan, "apply", apply, "forged-actor"), /action-specific approval/);
    native.nativeFault = "canonical";
    await assert.rejects(native.executeNative(plan, "apply", apply, actor), /Injected lost native canonical/);
    const guarded = guardPostgres(sql, new InvoiceFence(sql));
    await assert.rejects(async () => { await guarded.unsafe("SELECT * FROM normalized_work_orders"); }, /unavailable/);
    native.nativeFault = "shadow";
    await assert.rejects(native.executeNative(plan, "apply", apply, actor), /Injected lost native shadow/);
    native.nativeFault = null;
    await native.executeNative(plan, "apply", apply, actor);
    await native.executeNative(plan, "apply", apply, actor);
    await assert.rejects(native.executeNative(plan, "rollback", apply, actor), /action-specific approval/);
    const rollback = await approval("rollback");
    await native.executeNative(plan, "rollback", rollback, actor);
    await native.executeNative(plan, "rollback", rollback, actor);
    const restored = await readNativeInvoiceEvidence(sql, db, shopId, sourceId);
    assert.equal(restored.canonical.fullState, source.canonical.fullState);
    assert.equal(Object.hasOwn(restored.shadow.target.custom_fields, "invoiceHours"), false);
    assert.equal((await sql.unsafe("SELECT operation FROM invoice_repair_fence WHERE id=1"))[0].operation, null);
    await testProductionEntry(sql, db, original, { [shopId]: review });
    await assert.rejects(native.executeNative(plan, "apply", apply, actor), /changed|reapply/);
    console.log("Native two-store protocol passed: authenticated persisted action binding, canonical/shadow lost responses, fencing, retry and rollback");
  } finally {
    globalThis.fetch = oldFetch;
    delete process.env.RENDER_API_KEY_PROD;
    await native.close();
  }
}
