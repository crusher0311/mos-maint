import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { readShopProtractorCredentials } from "../lib/integrations/protractor/shop-eligibility";

test("onboarding uses the same provider-aware Protractor credentials as settings", () => {
  const source = readFileSync("app/api/onboarding/integrations-status/route.ts", "utf8");
  assert.match(source, /const hasProtractor = !!readShopProtractorCredentials\(shop\)/);
  assert.match(source, /hasIntegration: hasProtractor \|\| hasTekmetric \|\| hasAutoFlow \|\| hasCarfax/);
});

test("top-level shop connection counts, but disconnected and foreign-provider records do not", () => {
  const connected = {
    integrationProvider: "protractor",
    protractorConnectionId: "test-connection",
    protractorApiKey: "test-key",
    protractor: { configured: true },
  };
  assert.equal(!!readShopProtractorCredentials(connected), true);
  assert.equal(
    !!readShopProtractorCredentials({ ...connected, protractor: { configured: false } }),
    false,
  );
  assert.equal(
    !!readShopProtractorCredentials({ ...connected, integrationProvider: "tekmetric" }),
    false,
  );
  assert.equal(
    !!readShopProtractorCredentials({ ...connected, protractorApiKey: "" }),
    false,
  );
});