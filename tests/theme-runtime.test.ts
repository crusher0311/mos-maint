import assert from "node:assert/strict";
import { test } from "node:test";
import vm from "node:vm";
import { appearance, themeBootstrap, THEME_KEY } from "../components/theme/theme-runtime";

test("bootstrap applies default System before any React execution", () => {
  for (const dark of [true, false]) {
    const document = { documentElement: { dataset: {} as Record<string, string> } };
    vm.runInNewContext(themeBootstrap, { document, localStorage: { getItem: () => null }, matchMedia: () => ({ matches: dark }) });
    assert.equal(document.documentElement.dataset.theme, dark ? "dark" : "light");
    assert.equal(document.documentElement.dataset.appearance, "system");
  }
});
test("explicit preferences win, invalid and unavailable storage safely use System", () => {
  for (const value of ["light", "dark", "system", "bad", null, new Error("denied")]) {
    const document = { documentElement: { dataset: {} as Record<string, string> } };
    vm.runInNewContext(themeBootstrap, {
      document, localStorage: { getItem: (key: string) => {
        assert.equal(key, THEME_KEY);
        if (value instanceof Error) throw value;
        return value;
      } }, matchMedia: () => ({ matches: true }),
    });
    assert.equal(document.documentElement.dataset.theme, value === "light" ? "light" : "dark");
    assert.equal(document.documentElement.dataset.appearance, appearance(value));
  }
});
test("missing device preference API does not break initialization", () => {
  const document = { documentElement: { dataset: {} as Record<string, string> } };
  vm.runInNewContext(themeBootstrap, { document });
  assert.equal(document.documentElement.dataset.theme, "light");
});
