import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createAiUsageOutbox } from "../lib/openai-usage-outbox";
import { analyzerModel } from "../lib/openai-model-policy";
import { trackedAiFetch, wasAutomaticallyTracked, summarizeAiUsage } from "../lib/openai-usage";

test("analyzer models reject arbitrary, malformed, dated and expensive choices", () => {
  for (const model of ["gpt-5.4", "gpt-4.1-turbo", "gpt-4o-2024-08-06", " gpt-4o", {}, 1, ["gpt-4o"]])
    assert.equal(analyzerModel(model), null);
  for (const model of ["gpt-4o", "gpt-4o-mini", "gpt-4.1", "gpt-4.1-mini"])
    assert.equal(analyzerModel(model), model);
  assert.equal(analyzerModel(undefined), "gpt-4.1");
  assert.equal(analyzerModel(undefined, "gpt-4o"), "gpt-4o");
});

test("failed preparation never sends a provider request", async () => {
  let calls = 0;
  const writer = Object.assign(async () => {}, { prepare: async () => { throw Error("unavailable"); } });
  const fetcher = trackedAiFetch({ feature: "offline" }, writer, async () => { calls++; return Response.json({}); });
  await assert.rejects(fetcher("https://example.test", { body: JSON.stringify({ model: "gpt-4o" }) }));
  assert.equal(calls, 0);
});

test("ambiguous recording stays owned by accounting, not duplicate legacy inserts", async () => {
  const receipts: any[] = [];
  const old = console.info;
  console.info = (...args) => { receipts.push(args); };
  try {
    const fetcher = trackedAiFetch({ feature: "offline", shopId: 7 }, async () => { throw Error("private error"); },
      async () => Response.json({ id: "failed-dedup-unique", model: "gpt-4o",
        choices: [{ message: { content: "private response" } }], usage: { prompt_tokens: 3, completion_tokens: 4 } }));
    await fetcher("https://example.test", { body: JSON.stringify({ model: "gpt-4o", messages: ["private prompt"] }) });
    assert.equal(wasAutomaticallyTracked("failed-dedup-unique"), true);
    const record = receipts[0][1];
    assert.equal(record.requestedModel, "gpt-4o");
    assert.equal(record.returnedModel, "gpt-4o");
    assert.equal(record.promptTokens, 3);
    assert.ok(record._id);
    assert.ok(record.aiProcessInstance);
    assert.equal(JSON.stringify(receipts).includes("private"), false);
  } finally { console.info = old; }
});

test("journal survives restart, retries delivery, revives dates and keeps stable IDs", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ai-outbox-"));
  let fail = true;
  const delivered = new Map<string, any>();
  const deliver = async (r: any) => {
    if (fail) throw Error("offline");
    delivered.set(r._id, r);
  };
  const id = randomUUID();
  const row = { _id: id, provider: "openai", timestamp: new Date(), aiOutcome: "pending", usageKnown: false };
  const first = createAiUsageOutbox(dir, deliver, { report: () => {} });
  try {
    await first.prepare(row);
    await first({ ...row, aiOutcome: "complete", promptTokens: 5 });
    await first.drain();
    assert.ok((await readdir(dir)).some(n => n.endsWith(".ready.json")));
    first.close();
    fail = false;
    const second = createAiUsageOutbox(dir, deliver);
    try {
      await second.drain();
      assert.equal(delivered.size, 1);
      assert.equal(delivered.get(id).promptTokens, 5);
      assert.ok(delivered.get(id).timestamp instanceof Date);
      assert.equal((await readdir(dir)).length, 0);
    } finally { second.close(); }
  } finally { first.close(); await rm(dir, { recursive: true, force: true }); }
});

test("restart recovers pending attempts as unknown, never replays inference", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ai-pending-"));
  const rows: any[] = [];
  const first = createAiUsageOutbox(dir, async r => { rows.push(r); });
  try {
    await first.prepare({ _id: randomUUID(), provider: "openai", timestamp: new Date(), aiOutcome: "pending" });
    await first.drain();
    assert.equal(rows.length, 0); // Live inference is not mistaken for an orphan.
    first.close();
    const second = createAiUsageOutbox(dir, async r => { rows.push(r); });
    try {
      await second.drain();
      assert.equal(rows.length, 1);
      assert.equal(summarizeAiUsage(rows).totals.pendingRequests, 1);
      assert.equal(summarizeAiUsage(rows).totals.unknownUsageRequests, 1);
    } finally { second.close(); }
  } finally { first.close(); await rm(dir, { recursive: true, force: true }); }
});

test("full journal fails closed and bounds queued work", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ai-cap-"));
  const writer = createAiUsageOutbox(dir, async () => {}, { limit: 1, report: () => {} });
  try {
    await writer.prepare({ _id: randomUUID(), timestamp: new Date(), aiOutcome: "pending" });
    await assert.rejects(writer.prepare({ _id: randomUUID() }), /no provider request/);
  } finally { writer.close(); await rm(dir, { recursive: true, force: true }); }
});
