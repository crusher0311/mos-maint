# ZINK Print Agent – Windows Pilot Rollout Runbook

> **Canonical production URL:** `https://mos.tools`  
> **Agent repo path:** `zink-print-agent/`  
> **Scope:** First-shop Windows x64 pilot distribution

---

## 1. Overview

The ZINK Print Agent is a small Windows service that runs inside a shop's
LAN, polls `https://mos.tools` over outbound HTTPS for pending sticker-print
jobs, and delivers each job to a ZINK hAppy or Brother VC-500W printer over
TCP port 9100.  No inbound firewall holes are required on the shop side.

---

## 2. Build the Windows Pilot Distribution

### 2.1 Prerequisites (developer machine)

| Requirement | Version |
|---|---|
| Node.js | ≥ 18 LTS |
| npm | ≥ 9 |
| `@yao-pkg/pkg` | installed via `npm ci` in `zink-print-agent/` |

```bash
cd zink-print-agent
npm ci
```

### 2.2 Build + assemble

```bash
# Compile TypeScript, package the Windows x64 executable, and
# assemble the pilot folder in dist/pilot/.
npm run package:win:pilot
```

The script performs these steps in order:

1. `tsc -p tsconfig.json` – compiles `src/` → `dist/`
2. `pkg . --targets node20-win-x64 --output dist/zink-print-agent-win.exe` –
   bundles Node 20 + compiled JS into a single self-contained executable.
3. `node scripts/assemble-pilot.js` – validates `config.example.json`
   (no real secrets, valid URL, placeholder API key) and copies the four
   pilot files into `dist/pilot/`.

### 2.3 Pilot folder contents

```
dist/pilot/
  zink-print-agent-win.exe        ← single-file Windows x64 binary
  config.example.json             ← safe non-secret template
  startup/
    Register-ZinkAgent.ps1        ← unattended Task Scheduler registration
  DIAGNOSTICS.txt                 ← concise foreground-run guide
```

Zip `dist/pilot/` and send it to the first-shop technician.

---

## 3. Config Template

`config.example.json` is the canonical non-secret starting point.
**Never put a real API key here.**

```json
{
  "cloudBaseUrl": "https://mos.tools",
  "shopApiKey": "REPLACE_WITH_YOUR_SHOP_API_KEY",
  "printer": {
    "address": "zink.local",
    "port": 9100
  },
  "printerId": "front-counter",
  "pollIntervalMs": 5000,
  "mdnsTimeoutMs": 5000,
  "connectTimeoutMs": 8000
}
```

Key fields:

| Field | Required | Notes |
|---|---|---|
| `cloudBaseUrl` | yes | Always `https://mos.tools` in production |
| `shopApiKey` | yes | Dedicated per-shop key with `print:agent` scope only |
| `printer.address` | yes | `zink.local` (mDNS) or a static IP |
| `printer.port` | no | Defaults to 9100 |
| `printerId` | no | Logical label for multi-printer shops |
| `pollIntervalMs` | no | Poll frequency in ms; minimum 250 |
| `mdnsTimeoutMs` | no | How long to wait for mDNS reply |
| `connectTimeoutMs` | no | TCP connect timeout to printer |

---

## 4. First-Shop Rollout Checklist

Work through every item in order.  Check the box only when verified.

### 4.1 Pre-deployment – Shop Settings (remote)

- [ ] **Dedicated shop API key created.**  
      In `https://mos.tools/dashboard/settings/api-keys` while signed into the
      pilot shop, create a new key
      with **only** the `print:agent` permission scope.  
      Label it `pilot-shop-<shop-name>-zink`.  
      Copy the key value – it is shown only once.

### 4.2 On-Site Deployment

- [ ] **Copy pilot folder to the PC.**  
      Recommended path: `C:\ZinkPrintAgent\`

- [ ] **Create `config.json` from the example.**  
      ```
      copy C:\ZinkPrintAgent\config.example.json C:\ZinkPrintAgent\config.json
      ```
      Open `config.json` in Notepad and fill in:
      - `shopApiKey` → paste the dedicated API key from step 4.1
      - `printer.address` → leave as `zink.local` initially (see 4.3)

- [ ] **Confirm no placeholder remains.**  
      The Register script validates this; see also step 4.3.

### 4.3 Printer Discovery – mDNS then static-IP fallback

- [ ] **mDNS check (preferred).**  
      From the agent PC in PowerShell:
      ```powershell
      Resolve-DnsName zink.local
      ```
      If it resolves → leave `"address": "zink.local"` in `config.json`.

- [ ] **Static-IP fallback (if mDNS unavailable).**  
      Find the printer IP via its LCD menu or DHCP lease table.  
      Set a DHCP reservation so the IP is stable, then update `config.json`:
      ```json
      "printer": { "address": "192.168.1.xxx", "port": 9100 }
      ```

- [ ] **TCP port 9100 reachable from agent PC.**  
      ```powershell
      Test-NetConnection -ComputerName zink.local -Port 9100
      # or with static IP:
      Test-NetConnection -ComputerName 192.168.1.xxx -Port 9100
      ```
      Expected: `TcpTestSucceeded : True`  
      If false: check printer is powered on, same LAN segment, no VLAN
      isolation; verify printer is not in sleep mode.

### 4.4 Foreground Diagnostics Run

- [ ] **Run agent in foreground and confirm clean startup.**  
      Open a plain Command Prompt (no elevation needed):
      ```
      cd C:\ZinkPrintAgent
      zink-print-agent-win.exe
      ```
      Expected JSON log lines:
      ```
      {"level":"info","msg":"config loaded","cloudBaseUrl":"https://mos.tools",...}
      {"level":"info","msg":"agent started","printer":"zink.local","port":9100,...}
      {"level":"debug","msg":"no pending jobs"}   ← repeats every 5 s
      ```
      Press **Ctrl+C** to stop.

- [ ] **No error lines** (`"level":"error"` or `"level":"warn"`) at startup.

### 4.5 Platform-Admin Configuration and Heartbeat

- [ ] **Agent is visible and online.**  
      Keep the foreground agent running. Sign into `https://mos.tools` as a
      platform admin and open **Platform Admin → ZINK Print**. The agent's
      successful poll creates the shop's first ZINK footprint. Within 10
      seconds, verify the pilot shop appears as **online** with version
      **1.1.0** and the configured `printerId`.

- [ ] **Cloud printer config matches the agent.**  
      In the pilot shop card, set the same `printerId` used by `config.json`,
      enter `zink.local` or the static IP verified in section 4.3, keep port
      `9100`, choose the first cut/mode combination, and click **Save**.
      The cloud address is an operator-visible configuration check; the agent
      deliberately uses only its local `config.json` host/port so a cloud job
      can never redirect the SYSTEM service elsewhere on the shop LAN.

### 4.6 Admin Test Print – Deterministic Verification

- [ ] **Trigger a test print from the admin panel.**  
      1. Stay on **Platform Admin → ZINK Print**.  
      2. Find the pilot shop and click **Send pilot test**.  
      3. Watch the foreground terminal for:
         ```
         {"level":"info","msg":"received jobs","count":1}
         {"level":"info","msg":"printing job","jobId":"...","host":"...","port":9100}
         {"level":"info","msg":"job printed","jobId":"...","durationMs":...}
         ```
      4. Confirm a sticker emerges from the printer within ~15 seconds.
      5. Confirm the job moves through **pending**, **in-flight**, then **done**.
         On failure, the same row displays the agent/printer error.

- [ ] **Full-cut verified.**  
      Save **Full cut (1)** in the shop card, then send another pilot test.  
      Sticker should be cleanly separated from the roll.

- [ ] **Half-cut verified.**  
      Save **Half cut (0)** in the shop card, then send another pilot test.  
      Sticker should be perforated/kiss-cut but still attached to the backing.

- [ ] **Vivid colour/quality verified.**  
      Save **Vivid · 317 lpi (0)**, then send another pilot test.  
      Check that colours are saturated and sharp.

- [ ] **Normal speed/quality verified.**  
      Save **Normal · 264 lpi (1)**, then send another pilot test.  
      Verify acceptable output at standard print speed.

### 4.7 Quick Sticker Validation

- [ ] **Quick Sticker flow end-to-end.**  
      1. In `https://mos.tools` open the Quick Sticker panel.  
      2. While operating in the pilot shop, fill the sticker and click
         **Print to ZINK**.  
      3. Verify the agent picks up the job (log line `"msg":"received jobs"`).  
      4. Verify the printed sticker matches the selected template (text, image,
         barcode if present).  
      5. Confirm the job shows **success** in the admin panel within 30 seconds.

### 4.8 Unattended Startup – Task Scheduler Registration

- [ ] **Register the scheduled task.**  
      Open an **elevated** PowerShell prompt:
      ```powershell
      Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
      cd C:\ZinkPrintAgent\startup
      .\Register-ZinkAgent.ps1
      ```
      Expected output ends with `Task 'ZinkPrintAgent' registered successfully.`
      The script fails closed unless it can restrict `C:\ZinkPrintAgent`
      (including the executable and API-key config) and the log directory to
      **SYSTEM and Administrators only**. It preserves an existing
      `config.json`; it never replaces a configured key.

- [ ] **Start the task immediately and confirm.**  
      ```powershell
      Start-ScheduledTask -TaskName "ZinkPrintAgent"
      Get-ScheduledTaskInfo -TaskName "ZinkPrintAgent" | Select LastRunTime, LastTaskResult
      ```
      For this long-running task, `LastTaskResult` may be `267009`
      (`0x41301`, currently running). A completed clean stop reports `0`.

- [ ] **Verify the effective Windows security boundary.**  
      In the same elevated PowerShell window:
      ```powershell
      (Get-Acl C:\ZinkPrintAgent\config.json).Access |
        Select IdentityReference, FileSystemRights, AccessControlType
      $task = Get-ScheduledTask -TaskName "ZinkPrintAgent"
      $task.Principal | Select UserId, LogonType, RunLevel
      $task.Actions | Select Execute, Arguments, WorkingDirectory
      ```
      The config ACL must list only **SYSTEM** and
      **BUILTIN\Administrators**, both Allow/FullControl. The task principal
      must be SYSTEM/ServiceAccount/Highest, and the working directory must be
      `C:\ZinkPrintAgent`. Stop rollout if any other Allow entry remains.

- [ ] **Reboot the PC and verify auto-start.**  
      After reboot, wait 60 seconds, then:
      ```powershell
      Get-ScheduledTaskInfo -TaskName "ZinkPrintAgent"
      ```
      Confirm the task is running (`267009` / `0x41301`) and the log file
      `C:\ProgramData\ZinkPrintAgent\zink-print-agent.log` is being written.

- [ ] **Post-reboot test print.**  
      Repeat section 4.6 (send test print via admin panel) after the reboot to
      confirm the unattended task is fully operational.

> After registration, edit `config.json` only from an elevated editor. Rerun
> `Register-ZinkAgent.ps1` after replacing the executable so the ACLs and task
> definition are re-verified.

---

## 5. Admin-Page Failure Diagnosis

| Symptom | Probable cause | Resolution |
|---|---|---|
| Job stuck **pending** > 30 s | Agent not running or not polling | Check task scheduler state; review log file; re-run foreground test |
| `"level":"error","msg":"job failed"` + `ECONNREFUSED` | Printer not accepting TCP 9100 | Power-cycle printer; re-run `Test-NetConnection` |
| `"job failed"` + `mDNS resolution … timed out` | mDNS broken on this network | Switch `printer.address` to static IP in `config.json` |
| `"job failed"` + `ETIMEDOUT` | Printer unreachable (wrong IP / VLAN) | Verify IP, subnet, no VLAN isolation; increase `connectTimeoutMs` |
| `"level":"warn"` + `401` or `403` from cloud | API key wrong or missing `print:agent` scope | Regenerate key with `print:agent` scope; update `config.json` |
| Test print triggers, sticker prints, but job shows **failure** in admin | Ack network error (transient) | Usually self-corrects; if persistent, check outbound HTTPS to `mos.tools` |
| `printer rejected setup` + comment | Printer rejected the setup before image upload | Use the printer comment (for example cassette missing); correct hardware state and requeue |
| `printer rejected image` + comment | Printer rejected the JPEG payload | Record the job ID and exact comment; requeue once, then escalate if repeatable |
| Wrong cut type on sticker | Saved cloud printer default is wrong | Save the intended Full/Half cut in Platform Admin → ZINK Print and send the fixed pattern again |
| Washed-out colours | Normal mode selected instead of Vivid | Save Vivid · 317 lpi (0) and send the fixed pattern again |
| Quick Sticker prints blank | Quick Sticker rendering issue | Compare against the fixed pilot pattern; record the failed Quick Sticker job ID and error |

---

## 6. Rollback

If the pilot must be aborted:

```powershell
# Stop and remove the scheduled task
Stop-ScheduledTask  -TaskName "ZinkPrintAgent"
Unregister-ScheduledTask -TaskName "ZinkPrintAgent" -Confirm:$false

# Revoke the pilot API key in the admin panel
# Admin → API Keys → pilot-shop-<name>-zink → Revoke
```

---

## 7. Promotion to General Availability

Once the pilot shop passes all checklist items:

1. Tag the approved agent build using its shipped version.
2. Upload `dist/pilot/zink-print-agent-win.exe` to the
   GitHub release or internal software distribution system.
3. Replicate the per-shop API-key provisioning in the shop onboarding flow.
4. Update this runbook to reflect GA installation paths.
