import assert from "node:assert/strict";
import { test } from "node:test";
import type { DestinationSettings, SavedDestination } from "../../lib/print-queue/ipp-contract";
import { assertMatchingStock, browserDefaultKey, inchesToStock, readBrowserDefault, resolvedDefault, writeBrowserDefault } from "./saved-print-client";

const data = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
  getItem: (key: string) => data.get(key) ?? null,
  setItem: (key: string, value: string) => data.set(key, value),
  removeItem: (key: string) => data.delete(key),
} });
const settings = (shopId = 17, kind: "sticker" | "keytag" = "sticker"): DestinationSettings => ({
  shopId, kind, destinations: [], defaultDestinationId: "front-counter", canManage: false,
});

test("browser defaults are isolated by returned MOS shop and label kind", () => {
  data.clear();
  writeBrowserDefault(settings(), "bay-2");
  assert.equal(resolvedDefault(settings()), "bay-2");
  assert.equal(resolvedDefault(settings(18)), "front-counter");
  assert.equal(resolvedDefault(settings(17, "keytag")), "front-counter");
  assert.notEqual(browserDefaultKey(17, "sticker"), browserDefaultKey(17, "keytag"));
});
test("explicit Browser Print is distinct from inheriting the shop default", () => {
  data.clear();
  writeBrowserDefault(settings(), null);
  assert.equal(resolvedDefault(settings()), null);
  writeBrowserDefault(settings(), undefined);
  assert.equal(readBrowserDefault(settings()), undefined);
  assert.equal(resolvedDefault(settings()), "front-counter");
});
test("stale destinations are preserved and never silently replaced", () => {
  data.clear();
  writeBrowserDefault(settings(), "removed-printer");
  assert.equal(resolvedDefault(settings()), "removed-printer");
});
test("physical dimensions come from rendering and are integer hundredths mm", () => {
  assert.deepEqual(inchesToStock("3.500in", "1.125in"), { width: 8890, height: 2858 });
  assert.deepEqual(inchesToStock(2, 2.5), { width: 5080, height: 6350 });
  assert.throws(() => inchesToStock("", "1.125in"), /dimensions/);
  assert.throws(() => inchesToStock("890px", "300px"), /dimensions/);
  assert.throws(() => inchesToStock(0, 2), /dimensions/);
});
test("mismatched media fails closed without using destination dimensions", () => {
  const destination = { stock: { width: 5080, height: 6350 } } as SavedDestination;
  assert.doesNotThrow(() => assertMatchingStock(destination, inchesToStock(2, 2.5)));
  assert.throws(() => assertMatchingStock(destination, inchesToStock(2, 3)), /Nothing was sent/);
});
