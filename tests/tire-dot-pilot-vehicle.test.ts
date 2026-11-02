import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";

test("pilot projection supplements vehicle with VIN present, stays bounded and refuses saturated lookup", async () => {
  let saturated = false;
  const raw = { id: 42, shopId: 10, vehicleId: 7, vin: "1HGCM82633A004352", jobs: [{ dotNumbers: ["pinned"] }] };
  const cached = { shopId: 1, workOrderId: 42, data: { id: 42, shopId: 10, vehicleId: 7, vehicle: { year: 2020, make: "Land Rover", model: "Range Rover Sport" } } };
  const db = { collection(name: string) {
    return { find(query: any, options: any) {
      assert.equal(options.maxTimeMS, 2000);
      if (name === "tekmetric_work_orders") {
        assert.deepEqual(Array.from(query.shopId.$in), [1, "1"]);
        for (const field of ["data.vehicle", "data.vehicleYear", "data.vehicleMake", "data.vehicleModel", "vehicleYear", "vehicleMake", "vehicleModel"])
          assert.equal(options.projection[field], 1);
      }
      let mapper = (v: any) => v;
      const chain = {
        hint(value: string) { assert.equal(value, name === "tekmetric_work_orders" ? "shopId_workOrderId" : "pilot_generation_shop_key"); return chain; },
        sort() { return chain; },
        limit(n: number) { assert.equal(n, name === "tekmetric_work_orders" ? 100 : 25); return chain; },
        map(fn: any) { mapper = fn; return chain; },
        async toArray() { return (name === "tekmetric_work_orders" ? Array(saturated ? 100 : 1).fill(cached) : [{ key: "42", header: {}, data: raw }]).map(mapper); },
      };
      return chain;
    } };
  } };
  const bundle = await build({
    entryPoints: ["lib/data/repositories/tire-dot-pilot.ts"], bundle: true, write: false, platform: "node", format: "cjs", packages: "external",
    plugins: [{ name: "offline-pilot", setup(b) {
      b.onResolve({ filter: /^(?:@\/lib\/data\/db|\.\/enterprise|\.\/shops)$/ }, args => ({ path: args.path, namespace: "fixture" }));
      b.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({ contents: "export const getDb=async()=>globalThis.fixtureDb; export const findEnterpriseById=()=>{throw Error('unexpected')}; export const listShopsByShopIds=()=>{throw Error('unexpected')};" }));
    } }],
  });
  const mod = { exports: {} as any };
  runInNewContext(bundle.outputFiles[0].text, { module: mod, exports: mod.exports, require: createRequire(import.meta.url), fixtureDb: db });
  const rows = await mod.exports.readTirePilotPage({ generation: "fixture" }, 1, null);
  assert.equal(rows[0].doc.vehicleModel, "Range Rover Sport");
  assert.equal(rows[0].doc.data, raw);
  saturated = true;
  const unknown = await mod.exports.readTirePilotPage({ generation: "fixture" }, 1, null);
  assert.equal(unknown[0].doc.vehicleModel, undefined);
});
