---
name: Long-running one-shot jobs need a workflow, not shell backgrounding
description: How to run multi-minute scripts (backfills/decodes) that must survive across agent tool calls in this Replit env
---

Shell-backgrounded processes (`cmd &`, `nohup ... &`, even `setsid ... & disown`) are
**reaped the moment the spawning bash tool call returns** in this environment. The
process is visible/alive *during* the launch command, then gone before the next tool
call — the log simply freezes at wherever it got to (often only ~15s in).

**Why:** the agent's bash tool kills its child process group on return; nohup (SIGHUP-only)
and setsid (new session) do not save it here. Confirmed repeatedly: log mtime stops
exactly at the launch command's exit time.

**How to apply:** to run a long one-shot job (e.g. ACES decode/backfill that takes
30-50 min) that must keep running between polls, use a **Replit workflow** (runs under
the supervisor, independent of agent tool calls):
- `configureWorkflow({ name, command, outputType: "console", autoStart: true })`
- Wrap the command so it does NOT exit (or the supervisor may restart-loop it):
  `bash -c '...run scripts...; touch /tmp/<job>.done; sleep infinity'`
- Poll progress with `getWorkflowStatus({ name, maxScrollbackLines })` between turns;
  detect completion via the `.done` sentinel or an "ALL DONE" log line.
- `removeWorkflow({ name })` when finished so it doesn't linger.

The bash tool's own hard timeout is ~120s, so you also cannot just foreground a long
job in one call. Time-boxed foreground chunks work only if the script is idempotent
AND each chunk fits in <~115s (a 500-VIN ACES batch does NOT fit; ~25 does).
