#!/usr/bin/env node
/**
 * assemble-pilot.js
 *
 * Assembles a self-contained Windows pilot folder at dist/pilot/ containing:
 *   zink-print-agent-win.exe          – the compiled agent binary
 *   config.example.json               – safe non-secret config template
 *   startup/Register-ZinkAgent.ps1    – PowerShell / Task Scheduler unattended startup
 *   DIAGNOSTICS.txt                   – concise foreground-run diagnostics guide
 *
 * This script is intentionally plain CommonJS with zero dependencies so it
 * runs with any Node >= 18 that pkg bundles.
 *
 * Run: node scripts/assemble-pilot.js
 *      (invoked automatically by `npm run package:win:pilot`)
 */

"use strict";

const fs   = require("node:fs");
const path = require("node:path");

const ROOT        = path.resolve(__dirname, "..");
const DIST        = path.join(ROOT, "dist");
const PILOT_DIR   = path.join(DIST, "pilot");
const STARTUP_DIR = path.join(PILOT_DIR, "startup");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mkdir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function copy(src, dest) {
  if (!fs.existsSync(src)) {
    throw new Error("Source file not found: " + src);
  }
  fs.copyFileSync(src, dest);
  console.log("  copied  " + path.relative(ROOT, dest));
}

function write(dest, content) {
  fs.writeFileSync(dest, content, "utf8");
  console.log("  created " + path.relative(ROOT, dest));
}

// ---------------------------------------------------------------------------
// Validate placeholder values in config.example.json before including it
// ---------------------------------------------------------------------------

function validateConfigExample(cfgPath) {
  var raw = JSON.parse(fs.readFileSync(cfgPath, "utf8"));

  // A pilot package must never silently point at an old or non-production host.
  if (raw.cloudBaseUrl !== "https://mos.tools") {
    throw new Error(
      'config.example.json: "cloudBaseUrl" must be exactly https://mos.tools'
    );
  }

  // shopApiKey MUST be a placeholder in the example (never a real secret)
  if (!raw.shopApiKey || raw.shopApiKey.indexOf("REPLACE_") !== 0) {
    throw new Error(
      'config.example.json: "shopApiKey" must be a REPLACE_... placeholder – ' +
      'never commit a real API key to source.'
    );
  }

  // printer.address present
  if (!raw.printer || !raw.printer.address) {
    throw new Error('config.example.json: "printer.address" is required');
  }

  console.log("  validated config.example.json (no secrets, valid URL, placeholder key)");
}

// ---------------------------------------------------------------------------
// PowerShell startup script
// Note: PowerShell uses backtick as its escape character.  We build this
// string with plain concatenation so that JS template literals do not
// mis-interpret those backticks.
// ---------------------------------------------------------------------------

function buildRegisterPs1() {
  var BT = "`"; // PowerShell escape / line-continuation character
  var lines = [
    "# Register-ZinkAgent.ps1",
    "# ============================================================",
    "# Registers the ZINK Print Agent as a Windows Task Scheduler",
    "# task that starts automatically at system boot and runs as",
    "# the SYSTEM account (no interactive logon required).",
    "#",
    "# Run once from an elevated (Administrator) PowerShell prompt:",
    "#   .\\Register-ZinkAgent.ps1",
    "#",
    "# The task writes stdout/stderr to:",
    "#   %ProgramData%\\ZinkPrintAgent\\zink-print-agent.log",
    "# ============================================================",
    "",
    "#Requires -RunAsAdministrator",
    "",
    "$ErrorActionPreference = \"Stop\"",
    "",
    "# ------------------------------------------------------------------",
    "# Paths - adjust AgentDir if you place the files elsewhere",
    "# ------------------------------------------------------------------",
    "$AgentDir   = \"C:\\ZinkPrintAgent\"",
    "$ExeName    = \"zink-print-agent-win.exe\"",
    "$ConfigName = \"config.json\"",
    "$LogDir     = \"$Env:ProgramData\\ZinkPrintAgent\"",
    "$LogFile    = \"$LogDir\\zink-print-agent.log\"",
    "$TaskName   = \"ZinkPrintAgent\"",
    "",
    "# ------------------------------------------------------------------",
    "# Pre-flight checks",
    "# ------------------------------------------------------------------",
    "$ExePath     = Join-Path $AgentDir $ExeName",
    "$ConfigPath  = Join-Path $AgentDir $ConfigName",
    "",
    "if (-not (Test-Path $ExePath)) {",
    "    Write-Error \"Agent executable not found: $ExePath\"",
    "    Write-Error \"Copy $ExeName to $AgentDir before running this script.\"",
    "    exit 1",
    "}",
    "",
    "if (-not (Test-Path $ConfigPath)) {",
    "    $ExamplePath = Join-Path $AgentDir \"config.example.json\"",
    "    if (Test-Path $ExamplePath) {",
    "        Write-Host \"config.json not found - copying from config.example.json\"",
    "        Copy-Item $ExamplePath $ConfigPath",
    "        Write-Warning \"Edit $ConfigPath and replace REPLACE_WITH_YOUR_SHOP_API_KEY before the task runs.\"",
    "    } else {",
    "        Write-Error \"config.json not found at $ConfigPath. Create it from config.example.json.\"",
    "        exit 1",
    "    }",
    "}",
    "",
    "# Validate that the config does not still contain the placeholder key",
    "$cfg = Get-Content $ConfigPath | ConvertFrom-Json",
    "if ([string]::IsNullOrWhiteSpace($cfg.shopApiKey) -or $cfg.shopApiKey -like \"REPLACE_*\") {",
    "    Write-Error \"config.json still contains a placeholder shopApiKey.\"",
    "    Write-Error \"Set a real API key (print:agent scope) in $ConfigPath before registering.\"",
    "    exit 1",
    "}",
    "",
    "if ($cfg.cloudBaseUrl -ne \"https://mos.tools\") {",
    "    Write-Error \"cloudBaseUrl must be exactly https://mos.tools for the production pilot.\"",
    "    exit 1",
    "}",
    "",
    "if ([string]::IsNullOrWhiteSpace($cfg.printer.address)) {",
    "    Write-Error \"printer.address is required (zink.local or the printer's static IP).\"",
    "    exit 1",
    "}",
    "",
    "# Stop/remove an old SYSTEM task before changing ACLs. If hardening fails,",
    "# no previously registered privileged process is left running insecurely.",
    "if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {",
    "    Write-Host \"Removing existing task '$TaskName' ...\"",
    "    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue",
    "    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false",
    "}",
    "",
    "# ------------------------------------------------------------------",
    "# Lock the SYSTEM executable and bearer-key config against local users.",
    "# Exact ACL replacement (not additive icacls grants) removes any permissive",
    "# ACE inherited or copied in with the ZIP. SIDs work on non-English Windows.",
    "# ------------------------------------------------------------------",
    "$SystemSid = New-Object System.Security.Principal.SecurityIdentifier(\"S-1-5-18\")",
    "$AdminsSid = New-Object System.Security.Principal.SecurityIdentifier(\"S-1-5-32-544\")",
    "$AllowedSidValues = @($SystemSid.Value, $AdminsSid.Value)",
    "",
    "function Set-PrivateAgentAcl([string]$Path, [bool]$IsDirectory) {",
    "    $Acl = Get-Acl $Path",
    "    $Acl.SetAccessRuleProtection($true, $false)",
    "    foreach ($Rule in @($Acl.Access)) { [void]$Acl.RemoveAccessRuleAll($Rule) }",
    "    $Acl.SetOwner($AdminsSid)",
    "    $Inheritance = if ($IsDirectory) {",
    "        [System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [System.Security.AccessControl.InheritanceFlags]::ObjectInherit",
    "    } else {",
    "        [System.Security.AccessControl.InheritanceFlags]::None",
    "    }",
    "    foreach ($Sid in @($SystemSid, $AdminsSid)) {",
    "        $Rule = [System.Security.AccessControl.FileSystemAccessRule]::new(",
    "            $Sid,",
    "            [System.Security.AccessControl.FileSystemRights]::FullControl,",
    "            $Inheritance,",
    "            [System.Security.AccessControl.PropagationFlags]::None,",
    "            [System.Security.AccessControl.AccessControlType]::Allow",
    "        )",
    "        [void]$Acl.AddAccessRule($Rule)",
    "    }",
    "    Set-Acl -Path $Path -AclObject $Acl",
    "    $Unexpected = (Get-Acl $Path).Access | Where-Object {",
    "        $_.AccessControlType -eq \"Allow\" -and",
    "        $AllowedSidValues -notcontains $_.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value",
    "    }",
    "    if ($Unexpected) { throw \"Unsafe ACL remains on $Path\" }",
    "}",
    "",
    "Set-PrivateAgentAcl $AgentDir $true",
    "Set-PrivateAgentAcl $ExePath $false",
    "Set-PrivateAgentAcl $ConfigPath $false",
    "",
    "# ------------------------------------------------------------------",
    "# Ensure log directory exists",
    "# ------------------------------------------------------------------",
    "if (-not (Test-Path $LogDir)) {",
    "    New-Item -ItemType Directory -Path $LogDir -Force | Out-Null",
    "}",
    "Set-PrivateAgentAcl $LogDir $true",
    "",
    "# ------------------------------------------------------------------",
    "# Build the task action",
    "# Wrap in cmd /c so stdout+stderr are redirectable to the log file",
    "# ------------------------------------------------------------------",
    // PowerShell: $CmdArgs = "/c `"$ExePath`" >> `"$LogFile`" 2>&1"
    "$CmdArgs = \"/c " + BT + "\"$ExePath" + BT + "\" >> " + BT + "\"$LogFile" + BT + "\" 2>&1\"",
    "$Action  = New-ScheduledTaskAction -Execute \"cmd.exe\" -Argument $CmdArgs -WorkingDirectory $AgentDir",
    "",
    "# ------------------------------------------------------------------",
    "# Trigger: at system boot",
    "# ------------------------------------------------------------------",
    "$Trigger = New-ScheduledTaskTrigger -AtStartup",
    "",
    "# ------------------------------------------------------------------",
    "# Settings: run whether user is logged on or not; restart on failure",
    "# ------------------------------------------------------------------",
    "$Settings = New-ScheduledTaskSettingsSet " + BT,
    "    -ExecutionTimeLimit (New-TimeSpan -Hours 0) " + BT,
    "    -RestartCount 3 " + BT,
    "    -RestartInterval (New-TimeSpan -Minutes 1) " + BT,
    "    -StartWhenAvailable " + BT,
    "    -RunOnlyIfNetworkAvailable",
    "",
    "# ------------------------------------------------------------------",
    "# Run as SYSTEM (no password required; has network access)",
    "# ------------------------------------------------------------------",
    "$Principal = New-ScheduledTaskPrincipal -UserId \"SYSTEM\" -LogonType ServiceAccount -RunLevel Highest",
    "",
    "Register-ScheduledTask " + BT,
    "    -TaskName $TaskName " + BT,
    "    -Action   $Action " + BT,
    "    -Trigger  $Trigger " + BT,
    "    -Settings $Settings " + BT,
    "    -Principal $Principal " + BT,
    "    -Description \"MOS Tools ZINK Print Agent - polls mos.tools for sticker print jobs.\" " + BT,
    "    | Out-Null",
    "",
    "Write-Host \"\"",
    "Write-Host \"Task '$TaskName' registered successfully.\"",
    "Write-Host \"Log file: $LogFile\"",
    "Write-Host \"\"",
    "Write-Host \"To start immediately (without rebooting):\"",
    "Write-Host \"  Start-ScheduledTask -TaskName '$TaskName'\"",
    "Write-Host \"\"",
    "Write-Host \"To verify it is running:\"",
    "Write-Host \"  Get-ScheduledTaskInfo -TaskName '$TaskName' | Select LastRunTime, LastTaskResult\"",
    ""
  ];
  return lines.join("\r\n");
}

// ---------------------------------------------------------------------------
// Foreground diagnostics guide
// ---------------------------------------------------------------------------

var DIAGNOSTICS_TXT = [
  "ZINK Print Agent - Foreground Diagnostics",
  "==========================================",
  "Extract/copy this entire pilot folder to C:\\ZinkPrintAgent before starting.",
  "Keep the startup subfolder beside the executable. Use these steps to verify",
  "the agent before registering the scheduled task. Steps 1-8 need no elevation.",
  "",
  "STEP 1 - Verify the executable",
  "-------------------------------",
  "  cd C:\\ZinkPrintAgent",
  "  zink-print-agent-win.exe --help",
  "  Expected: prints usage/config fields, then exits 0.",
  "",
  "STEP 2 - Copy and edit config",
  "-------------------------------",
  "  Copy config.example.json to config.json in the same folder.",
  "  Open config.json in Notepad and fill in:",
  '    "cloudBaseUrl": "https://mos.tools"   <- already set; do not change',
  '    "shopApiKey":   "<your print:agent key>"',
  '    "printer" > "address": "zink.local"   <- or static IP if mDNS unavailable',
  "  Save the file.",
  "",
  "STEP 3 - Run in foreground",
  "-------------------------------",
  "  zink-print-agent-win.exe",
  "  Expected output (JSON log lines):",
  '    {"level":"info","msg":"config loaded","cloudBaseUrl":"https://mos.tools",...}',
  '    {"level":"info","msg":"agent started","printer":"zink.local",...}',
  '    {"level":"debug","msg":"no pending jobs"}   <- repeats every 5 s',
  "",
  "  Press Ctrl+C to stop.",
  "",
  "STEP 4 - Diagnose config errors",
  "-------------------------------",
  '  "config file not found"',
  "    -> Ensure config.json is in the same folder as the .exe.",
  '  "shopApiKey ... placeholder"',
  "    -> Replace REPLACE_WITH_YOUR_SHOP_API_KEY with a real key.",
  '  "cloudBaseUrl is not a valid URL"',
  '    -> Restore the default: "https://mos.tools"',
  "",
  "STEP 5 - Diagnose printer connectivity",
  "-------------------------------",
  "  From the same machine, test port 9100 reachability:",
  "    PowerShell: Test-NetConnection -ComputerName zink.local -Port 9100",
  "    or:         Test-NetConnection -ComputerName 192.168.1.xxx -Port 9100",
  "  Expected: TcpTestSucceeded : True",
  "",
  "  If mDNS (zink.local) fails, switch config.json to the printer's static IP:",
  '    "address": "192.168.1.xxx"',
  "",
  "  If TCP fails entirely, check:",
  "    * Printer is powered on and shows a solid status LED.",
  "    * Both the print-agent PC and the printer are on the same LAN segment.",
  "    * Any Windows Firewall rule blocking outbound port 9100 (usually none).",
  "",
  "STEP 6 - Diagnose cloud connectivity",
  "-------------------------------",
  "  Confirm outbound HTTPS to mos.tools:",
  "    PowerShell: Invoke-WebRequest https://mos.tools/api/health -UseBasicParsing",
  "  Expected: StatusCode 200",
  "",
  '  "401 Unauthorized" or "403 Forbidden" in the log',
  "    -> API key is wrong or lacks print:agent permission.",
  "    -> Generate a new dedicated shop API key via the admin panel.",
  "",
  "STEP 7 - Trigger a test print (admin page)",
  "-------------------------------",
  "  1. Log into https://mos.tools as a platform admin.",
  "  2. Navigate to Platform Admin -> ZINK Print.",
  '  3. Find the pilot shop and click "Send pilot test".',
  "  4. Watch the foreground terminal - you should see:",
  '       {"level":"info","msg":"received jobs","count":1}',
  '       {"level":"info","msg":"printing job","jobId":"...","host":"...","port":9100}',
  '       {"level":"info","msg":"job printed","jobId":"...","durationMs":...}',
  "  5. Confirm the sticker prints with correct cut and colour.",
  "",
  "STEP 8 - Admin-page failure diagnosis",
  "-------------------------------",
  '  "level":"error","msg":"job failed" + ECONNREFUSED',
  "    -> Printer TCP port 9100 not accepting connections (see Step 5).",
  '  "job failed" + "mDNS resolution ... timed out"',
  "    -> Switch to static IP (see Step 5).",
  '  "job failed" + ETIMEDOUT',
  "    -> Printer unreachable; check network path and connectTimeoutMs value.",
  "  Job stays pending in admin panel after 30 s",
  "    -> Agent is not polling; check foreground output or task scheduler status.",
  "  Test print shows wrong colour / speed",
  "    -> See cut/colour/speed verification checklist in the pilot runbook.",
  "",
  "STEP 9 - Register unattended startup (Administrator)",
  "----------------------------------------------------",
  "  After the foreground test succeeds, stop it with Ctrl+C. Open PowerShell",
  "  as Administrator and run:",
  "    Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass",
  "    cd C:\\ZinkPrintAgent\\startup",
  "    .\\Register-ZinkAgent.ps1",
  "    Start-ScheduledTask -TaskName \"ZinkPrintAgent\"",
  "    Get-ScheduledTaskInfo -TaskName \"ZinkPrintAgent\"",
  "",
  "  The registration script stops before creating a SYSTEM task unless it can",
  "  lock the executable, config (API key), and logs to SYSTEM/Administrators.",
  "  Reboot the PC, verify the task is running (0x41301 / 267009 is normal for",
  "  this long-running task), then send the admin pilot test one more time.",
  ""
].join("\r\n");

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function assemblePilot() {
  console.log("\nAssembling pilot distribution ...\n");

  fs.rmSync(PILOT_DIR, { recursive: true, force: true });
  mkdir(PILOT_DIR);
  mkdir(STARTUP_DIR);

  var configExampleSrc = path.join(ROOT, "config.example.json");
  validateConfigExample(configExampleSrc);

  // 1. Executable
  copy(path.join(DIST, "zink-print-agent-win.exe"), path.join(PILOT_DIR, "zink-print-agent-win.exe"));

  // 2. Config example
  copy(configExampleSrc, path.join(PILOT_DIR, "config.example.json"));

  // 3. PowerShell startup script
  write(path.join(STARTUP_DIR, "Register-ZinkAgent.ps1"), buildRegisterPs1());

  // 4. Diagnostics guide
  write(path.join(PILOT_DIR, "DIAGNOSTICS.txt"), DIAGNOSTICS_TXT);

  console.log("\nPilot folder ready: dist/pilot/");
  console.log("  zink-print-agent-win.exe");
  console.log("  config.example.json");
  console.log("  startup/Register-ZinkAgent.ps1");
  console.log("  DIAGNOSTICS.txt");
  console.log("\nDeliverable: dist/pilot/ is ready to zip for the first-shop technician.\n");
}

if (require.main === module) {
  assemblePilot();
}

module.exports = {
  assemblePilot,
  buildRegisterPs1,
  diagnosticsText: DIAGNOSTICS_TXT,
  validateConfigExample,
};
