import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";
import { configForSetup, verifySetupKey } from "../src/ipp/wizard";

test("setup preserves identity and rejects implicit shop or TCP migration", () => {
  const dir = path.resolve("/tmp/installer-fixture");
  const config = configForSetup(dir, "synthetic-key");
  const upgraded = configForSetup(dir, "synthetic-key", config);
  assert.deepEqual(upgraded, config);
  assert.notEqual(configForSetup(dir, "synthetic-key").ipp!.installationId, config.ipp!.installationId);
  assert.throws(() => configForSetup(dir, "different-key", config), /Changing shop/);
  assert.throws(() => configForSetup(dir, "synthetic-key", { ...config, ipp: undefined }), /TCP/);
  assert.throws(() => configForSetup(dir, "synthetic-key", {
    ...config, ipp: { ...config.ipp, enrollmentFile: "/tmp/outside.json" },
  }), /protected/);
});
test("shop check is bounded, outbound-only and never polls jobs", async () => {
  const result = await verifySetupKey("synthetic-key", (async (url, init) => {
    assert.equal(url, "https://mos.tools/api/print-agent/setup");
    assert.equal(init?.redirect, "error");
    assert.equal((init?.headers as any).Authorization, "Bearer synthetic-key");
    return new Response(JSON.stringify({ shopId: 17, name: "Test shop", token: "ignored" }));
  }) as typeof fetch);
  assert.deepEqual(result, { shopId: 17, name: "Test shop" });
  for (const body of ["x".repeat(9000), '{"shopId":0,"name":"bad"}', '{}']) {
    await assert.rejects(() => verifySetupKey("synthetic-key", (async () => new Response(body)) as typeof fetch));
  }
  await assert.rejects(() => verifySetupKey("synthetic-key", (async () => new Response("", { status: 403 })) as typeof fetch), /403/);
});
test("installer preserves state and wizard does not put secrets into arguments", () => {
  const nsi = fs.readFileSync(path.join(__dirname, "../installer/installer.nsi"), "utf8");
  for (const file of ["config.json", "printers.json", "ipp-journal"]) {
    assert(!nsi.includes(`Delete "$INSTDIR\\${file}"`));
    assert(!nsi.includes(`File "${file}"`));
  }
  assert(!nsi.includes("RMDir /r"));
  const wizard = fs.readFileSync(path.join(__dirname, "../installer/SetupWizard.ps1"), "utf8");
  assert(wizard.includes("$start.Arguments = '--setup-json'"));
  assert(wizard.includes("$p.StandardInput.Write"));
  assert(wizard.includes("UseSystemPasswordChar = $true"));
  assert(wizard.includes("Stop-ScheduledTask"));
  assert(wizard.includes("Outcome") || wizard.includes("outcome"));
});

test("scheduled launch preserves cmd outer quotes and protected log redirection", () => {
  const { buildRegisterPs1 } = require("../scripts/assemble-pilot.js");
  const script = buildRegisterPs1();
  assert(script.includes(`$CmdArgs = '/d /s /c ""{0}" >> "{1}" 2>&1"' -f $ExePath, $LogFile`));
  assert(script.includes('-Argument $CmdArgs -WorkingDirectory $AgentDir'));
  assert(!script.includes('$CmdArgs = "/c'));
});
