/**
 * Reusable ops-alert escalation helper.
 *
 * Most existing alerters page platform admins by email only (Resend via
 * `lib/email.ts`). Email-only alerts get missed — a fleet-wide backfill
 * stall went unnoticed for ~2 days because nobody was watching the inbox.
 * This helper routes a high-severity operational alert to channels on-call
 * actually watches, in addition to (not instead of) email:
 *
 *   1. Better Stack — every alert is emitted as a single structured stderr
 *      line prefixed with the stable `[OPS-ALERT]` marker. The Render web
 *      service streams stderr into Better Stack (host `mos-maintenance-mvp-main`),
 *      so a Better Stack alert rule matching `[OPS-ALERT]` pages reliably
 *      with zero extra infrastructure. This channel is ALWAYS on.
 *
 *   2. Slack — optional. When `OPS_ALERT_SLACK_WEBHOOK_URL` (or the
 *      `SLACK_WEBHOOK_URL` / `ALERT_SLACK_WEBHOOK_URL` fallbacks) is set, the
 *      alert is POSTed to the incoming webhook. Absent the env var the Slack
 *      leg is skipped cleanly — the Better Stack line still fires.
 *
 * This helper NEVER throws: a Slack hiccup must not break the caller's cron.
 * Callers own their own de-duplication (state in Mongo) so this just delivers.
 */

export type OpsAlertSeverity = "critical" | "warning" | "info";

export type OpsAlert = {
  title: string;
  severity?: OpsAlertSeverity;
  /** One-line human summary shown first in every channel. */
  summary?: string;
  /** Key/value detail pairs rendered as `key: value` lines. */
  fields?: Record<string, string | number | boolean | null | undefined>;
  /** Free-form extra lines (e.g. one per affected provider). */
  lines?: string[];
  /** Originating cron/route, e.g. "pipeline-stall-alerter". */
  source?: string;
  /** Stable key the caller deduped on — echoed into every channel. */
  dedupKey?: string;
};

export type OpsAlertResult = {
  slack: "sent" | "skipped" | "error";
  slackError?: string;
  betterstack: "logged";
};

// Test seam — the smoke test swaps `fetch` so it can assert the Slack
// payload without a real network call. Production never touches this.
export const __deps = {
  fetch: (...args: Parameters<typeof fetch>) => fetch(...args),
};

function slackWebhookUrl(): string | null {
  return (
    process.env.OPS_ALERT_SLACK_WEBHOOK_URL ||
    process.env.SLACK_WEBHOOK_URL ||
    process.env.ALERT_SLACK_WEBHOOK_URL ||
    null
  );
}

function severityEmoji(sev: OpsAlertSeverity): string {
  if (sev === "critical") return "🚨";
  if (sev === "warning") return "⚠️";
  return "ℹ️";
}

function renderFieldLines(alert: OpsAlert): string[] {
  const out: string[] = [];
  if (alert.fields) {
    for (const [k, v] of Object.entries(alert.fields)) {
      if (v === undefined || v === null || v === "") continue;
      out.push(`${k}: ${v}`);
    }
  }
  if (alert.lines) out.push(...alert.lines.filter(Boolean));
  return out;
}

function buildSlackText(alert: OpsAlert): string {
  const sev = alert.severity ?? "warning";
  const header = `${severityEmoji(sev)} *[MOS] ${alert.title}*`;
  const parts = [header];
  if (alert.summary) parts.push(alert.summary);
  const detail = renderFieldLines(alert);
  if (detail.length) parts.push(detail.map((l) => `• ${l}`).join("\n"));
  const footer: string[] = [];
  if (alert.source) footer.push(`source: ${alert.source}`);
  if (alert.dedupKey) footer.push(`dedupKey: ${alert.dedupKey}`);
  if (footer.length) parts.push(`_${footer.join(" · ")}_`);
  return parts.join("\n\n");
}

export async function sendOpsAlert(alert: OpsAlert): Promise<OpsAlertResult> {
  const sev = alert.severity ?? "warning";

  // 1) Better Stack — always-on structured stderr line. Keep it on ONE line
  //    (JSON) so a Better Stack alert rule can match `[OPS-ALERT]` and parse
  //    the payload. Use console.error so it lands on the error stream.
  try {
    console.error(
      "[OPS-ALERT]",
      JSON.stringify({
        severity: sev,
        title: alert.title,
        summary: alert.summary ?? null,
        source: alert.source ?? null,
        dedupKey: alert.dedupKey ?? null,
        fields: alert.fields ?? null,
        lines: alert.lines ?? null,
        at: new Date().toISOString(),
      }),
    );
  } catch {
    // console.error should never throw, but never let logging break delivery.
  }

  // 2) Slack — optional.
  const url = slackWebhookUrl();
  if (!url) {
    return { slack: "skipped", betterstack: "logged" };
  }
  try {
    const res = await __deps.fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: buildSlackText(alert) }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return {
        slack: "error",
        slackError: `Slack webhook ${res.status}: ${body || res.statusText}`,
        betterstack: "logged",
      };
    }
    return { slack: "sent", betterstack: "logged" };
  } catch (err: any) {
    return {
      slack: "error",
      slackError: String(err?.message || err),
      betterstack: "logged",
    };
  }
}
