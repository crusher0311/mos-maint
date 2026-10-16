import "./helpers/deny-network-egress";
import assert from "node:assert/strict";
import { callbackPipelineWidth, runCallbackPipeline } from "../lib/integrations/protractor/callback-pipeline";

const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function gate() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}

async function main() {
  for (const value of [undefined, "", "0", "5", "2.5", "2x", " 2", 2]) {
    assert.equal(callbackPipelineWidth(value), 1);
  }
  for (const value of ["1", "2", "3", "4"]) assert.equal(callbackPipelineWidth(value), Number(value));
  for (const width of [1, 2, 4, 99]) {
    const capacity = width === 99 ? 1 : width;
    let active = 0, peak = 0;
    const shops = new Set<string>();
    const seen: number[] = [];
    await runCallbackPipeline(Array.from({ length: 20 }, (_, id) => ({ id, shop: String(id % 5) })),
      width, x => x.shop, () => false, async x => {
        assert(!shops.has(x.shop), "same-shop work must remain serial");
        shops.add(x.shop); peak = Math.max(peak, ++active);
        await tick();
        seen.push(x.id); active--; shops.delete(x.shop);
        return true;
      });
    assert.equal(peak, capacity);
    assert.equal(seen.length, 20);
    for (let shop = 0; shop < 5; shop++) {
      assert.deepEqual(seen.filter(id => id % 5 === shop), [shop, shop + 5, shop + 10, shop + 15]);
    }
  }
  // Shutdown stops new admission, but waits for every in-flight local save.
  for (const mode of ["shutdown", "budget", "exception"] as const) {
    const save = gate();
    let stop = false, settled = false;
    const started: number[] = [];
    const task = runCallbackPipeline([1, 2, 3, 4], 2, String, () => stop, async id => {
      started.push(id);
      if (id === 1) {
        await tick();
        if (mode === "exception") throw new Error("durable store unavailable");
        stop = mode === "shutdown";
        return mode !== "budget";
      }
      await save.promise;
      return true;
    });
    const result = task.then(() => { settled = true; return null; },
      error => { settled = true; return error; });
    await tick(); await tick();
    assert.equal(settled, false, "must wait for the other admitted save");
    assert.deepEqual(started, [1, 2], "must not admit more work after stopping");
    save.release();
    const error = await result;
    assert.equal(Boolean(error), mode === "exception");
  }
  let calls = 0;
  await runCallbackPipeline([1, 2], 4, String, () => true, async () => { calls++; return true; });
  assert.equal(calls, 0, "expired deadline must admit nothing");
  console.log("callback pipeline checks passed");
}
main().catch(error => { console.error(error); process.exitCode = 1; });
