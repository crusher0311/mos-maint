---
name: Better Stack shared log feed
description: Why the production log feed contains errors from apps other than MOS Maintenance
---

# Better Stack shared log feed

The production Better Stack source `t500063_mos_production_logs` (`_app: mos_production`)
is shared by MULTIPLE unrelated Render apps, not just MOS Maintenance.

**MOS Maintenance** logs under syslog host/hostname **`mos-maintenance-mvp-main`**
(appname `web-*`). Other apps — notably **`heart-helper`** — write into the same feed.

**Why it matters:** a recurring scary-looking error like
`[RingCentral] Error syncing call ...: column "ringcentral_extension_id" does not exist`
is emitted by `heart-helper`, NOT MOS. RingCentral appears nowhere in the MOS codebase
(MOS uses Twilio for phone features). Reporting another app's errors as MOS bugs wastes
Brandon's time and alarms him unnecessarily.

**How to apply:** when checking prod logs for MOS, filter `WHERE JSONExtractString(raw,'syslog.host') = 'mos-maintenance-mvp-main'`
(or ILIKE the hostname) unless explicitly asked to look across all apps. Note: the
dotted-path extraction `JSONExtractString(raw,'syslog.host')` may return empty — the
host is nested as `syslog: { host, hostname }`; fall back to `raw ILIKE '%mos-maintenance-mvp-main%'`
or inspect a raw line to confirm origin.

**Query method that works** (POST body / `--data-binary` returns "Empty query"):
`curl -s -G "https://$BETTERSTACK_QUERY_HOST" -u "$BETTERSTACK_QUERY_USERNAME:$BETTERSTACK_QUERY_PASSWORD" --data-urlencode "query@/tmp/q.sql"`.
Secrets are only readable from the project runtime env (bash/node), not the masked viewEnvVars or the code_execution sandbox.
