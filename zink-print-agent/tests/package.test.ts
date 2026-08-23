import { test } from "node:test";
import assert from "node:assert/strict";

// The assembly script is CommonJS so it can run on a technician/build machine
// without tsx. Requiring it is side-effect-free; main() is guarded.
const { buildRegisterPs1, diagnosticsText } = require("../scripts/assemble-pilot.js") as {
  buildRegisterPs1: () => string;
  diagnosticsText: string;
};

test("generated Windows installer fails closed and protects SYSTEM-task assets", () => {
  const script = buildRegisterPs1();

  assert.match(script, /#Requires -RunAsAdministrator/);
  assert.match(script, /\$ErrorActionPreference = "Stop"/);
  assert.match(script, /S-1-5-18/); // SYSTEM
  assert.match(script, /S-1-5-32-544/); // BUILTIN\\Administrators
  assert.match(script, /SetAccessRuleProtection\(\$true, \$false\)/);
  assert.match(script, /RemoveAccessRuleAll/);
  assert.match(script, /throw "Unsafe ACL remains on \$Path"/);

  for (const protectedTarget of [
    "Set-PrivateAgentAcl $AgentDir $true",
    "Set-PrivateAgentAcl $ExePath $false",
    "Set-PrivateAgentAcl $ConfigPath $false",
    "Set-PrivateAgentAcl $LogDir $true",
  ]) {
    assert.ok(script.includes(protectedTarget), `missing ACL protection: ${protectedTarget}`);
  }

  assert.doesNotMatch(script, /(?:Everyone|BUILTIN\\Users|S-1-5-32-545).*FullControl/i);
});

test("generated Windows installer validates config before SYSTEM registration", () => {
  const script = buildRegisterPs1();
  const placeholderCheck = script.indexOf("config.json still contains a placeholder");
  const unregister = script.indexOf("Unregister-ScheduledTask ");
  const aclCheck = script.indexOf("Set-PrivateAgentAcl $ConfigPath $false");
  const registration = script.indexOf("Register-ScheduledTask ");

  assert.ok(placeholderCheck >= 0);
  assert.ok(unregister > placeholderCheck);
  assert.ok(aclCheck > unregister);
  assert.ok(registration > aclCheck);
  assert.match(script, /cloudBaseUrl must be exactly https:\/\/mos\.tools/);
  assert.match(script, /-Execute "cmd\.exe".*-WorkingDirectory \$AgentDir/);
  assert.match(
    script,
    /New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest/,
  );

  // Existing config is preserved: copying the template is nested under the
  // missing-config branch, not performed unconditionally.
  assert.match(
    script,
    /if \(-not \(Test-Path \$ConfigPath\)\) \{[\s\S]*Copy-Item \$ExamplePath \$ConfigPath[\s\S]*\}/,
  );
});

test("pilot bundle instructions cover install, foreground, auto-start, and reboot", () => {
  assert.match(diagnosticsText, /copy this entire pilot folder to C:\\ZinkPrintAgent/i);
  assert.match(diagnosticsText, /zink-print-agent-win\.exe --help/);
  assert.match(diagnosticsText, /zink-print-agent-win\.exe\r?\n/);
  assert.match(diagnosticsText, /Register-ZinkAgent\.ps1/);
  assert.match(diagnosticsText, /Start-ScheduledTask -TaskName "ZinkPrintAgent"/);
  assert.match(diagnosticsText, /Reboot the PC/);
  assert.match(diagnosticsText, /https:\/\/mos\.tools/);
});

test("committed pilot config is production-only and contains no real key", () => {
  const fs = require("node:fs") as typeof import("node:fs");
  const path = require("node:path") as typeof import("node:path");
  const config = JSON.parse(
    fs.readFileSync(path.resolve(__dirname, "../config.example.json"), "utf8"),
  );

  assert.equal(config.cloudBaseUrl, "https://mos.tools");
  assert.match(config.shopApiKey, /^REPLACE_/);
  assert.ok(config.printer?.address);
  assert.equal(config.printer?.port, 9100);
});