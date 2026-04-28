/**
 * Pure HTML builders for the backfill chunk-speed alert and recovery
 * emails.
 *
 * Extracted from `route.ts` so:
 *   - the route handler stays focused on I/O (DB, env, email send), and
 *   - `scripts/preview-chunk-speed-alert-email.ts` can render the same
 *     markup the cron sends without touching Mongo or Resend, so on-call
 *     can eyeball the layout in a real browser before a regression makes
 *     it into a paged email.
 *
 * Output is byte-for-byte identical to what `route.ts` used to produce
 * inline so the route-level smoke test (which substring-asserts the
 * payload) keeps passing.
 *
 * No I/O, no env reads — `syncHealthUrl` is passed in by the caller so
 * this module is trivial to unit-test.
 */

import {
  HIGH_BACKOFF_AVG_MS,
  LOW_CACHE_HIT_RATE,
  LOW_CACHE_MIN_LOOKUPS,
  P95_BASELINE_LOOKBACK,
  P95_BASELINE_MIN_SAMPLES,
  P95_REGRESSION_MULTIPLIER,
  P95_REGRESSION_NOISE_FLOOR_MS,
  SLOW_P95_THRESHOLD_MS,
  SlowShop,
} from "./lib";

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function formatMs(ms: number | null): string {
  if (ms == null) return "—";
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60_000).toFixed(1)}m`;
}

export function formatRate(rate: number | null, total: number): string {
  if (rate == null || total === 0) return "—";
  return `${(rate * 100).toFixed(0)}% (n=${total})`;
}

/** One row in the alert table. `isNew` toggles the NEW vs REASONS CHANGED badge. */
export type AlertEmailRow = { shop: SlowShop; isNew: boolean };

export type AlertEmailInput = {
  rows: AlertEmailRow[];
  /** Total currently breaching (may be larger than rows.length when some
   *  shops were deduped because their reasons didn't change). */
  breachingTotal: number;
  /** Resolved fully-qualified URL to the platform-admin sync-health page. */
  syncHealthUrl: string;
};

export function buildAlertEmailSubject(toAlertCount: number, breachingTotal: number): string {
  return `[MOS] Backfill chunk-speed: ${toAlertCount} shop(s) breaching (${breachingTotal} total)`;
}

export function buildAlertEmailHtml(input: AlertEmailInput): string {
  const { rows: alertRows, breachingTotal, syncHealthUrl: linkBase } = input;
  const rows = alertRows
    .map(({ shop: s, isNew }) => {
      // For shops that tripped the relative regression rule, show the
      // baseline and the multiplier inline with the p95 cell so on-call
      // can see at a glance how far the shop has degraded — the whole
      // point of the rule is that the absolute number alone might not
      // look alarming yet.
      const p95Cell =
        s.p95Baseline != null && s.rollup.p95DurationMs != null
          ? `${formatMs(s.rollup.p95DurationMs)} (n=${s.rollup.chunkSampleCount}, ` +
            `${(s.rollup.p95DurationMs / s.p95Baseline).toFixed(1)}× baseline ${formatMs(s.p95Baseline)})`
          : `${formatMs(s.rollup.p95DurationMs)} (n=${s.rollup.chunkSampleCount})`;
      return `
        <tr>
          <td style="padding:6px 12px;border:1px solid #ddd">${escapeHtml(s.providerLabel)}</td>
          <td style="padding:6px 12px;border:1px solid #ddd">${escapeHtml(s.name)}</td>
          <td style="padding:6px 12px;border:1px solid #ddd">${s.shopId}</td>
          <td style="padding:6px 12px;border:1px solid #ddd">${escapeHtml(s.reasons.join(", "))}</td>
          <td style="padding:6px 12px;border:1px solid #ddd">${p95Cell}</td>
          <td style="padding:6px 12px;border:1px solid #ddd">${formatMs(s.rollup.avgBackoff429Ms)}</td>
          <td style="padding:6px 12px;border:1px solid #ddd">${formatRate(s.rollup.jobsCacheHitRate, s.rollup.jobsCacheTotal)}</td>
          <td style="padding:6px 12px;border:1px solid #ddd">${formatRate(s.rollup.vehiclesCacheHitRate, s.rollup.vehiclesCacheTotal)}</td>
          <td style="padding:6px 12px;border:1px solid #ddd">${formatRate(s.rollup.customersCacheHitRate, s.rollup.customersCacheTotal)}</td>
          <td style="padding:6px 12px;border:1px solid #ddd">${isNew ? "NEW" : "REASONS CHANGED"}</td>
        </tr>`;
    })
    .join("");
  return `
        <div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;line-height:1.5">
          <h2>Backfill Chunk-Speed Alert</h2>
          <p>${alertRows.length} shop(s) breached a chunk-speed threshold. Total currently breaching: <strong>${breachingTotal}</strong>.</p>
          <p>Reasons:
            <code>slow_p95</code> = p95 chunk wall-clock &gt; ${SLOW_P95_THRESHOLD_MS / 60000}m ·
            <code>regressed_p95</code> = p95 &gt; ${P95_REGRESSION_MULTIPLIER}× rolling baseline
            (median of the last ${P95_BASELINE_LOOKBACK} daily snapshots, min ${P95_BASELINE_MIN_SAMPLES}),
            with current p95 also &gt; ${P95_REGRESSION_NOISE_FLOOR_MS / 60000}m ·
            <code>high_backoff</code> = avg per-chunk 429 backoff &gt; ${HIGH_BACKOFF_AVG_MS / 1000}s ·
            <code>low_jobs_cache</code> / <code>low_vehicles_cache</code> / <code>low_customers_cache</code>
            = cache hit rate &lt; ${(LOW_CACHE_HIT_RATE * 100).toFixed(0)}%
            (with at least ${LOW_CACHE_MIN_LOOKUPS} lookups in the rolling window).
          </p>
          <p>Open the chunk-speed tables for the affected providers:
            <a href="${linkBase}">${linkBase}</a>
          </p>
          <table style="border-collapse:collapse;border:1px solid #ddd">
            <thead>
              <tr>
                <th style="padding:6px 12px;border:1px solid #ddd;text-align:left">Provider</th>
                <th style="padding:6px 12px;border:1px solid #ddd;text-align:left">Shop</th>
                <th style="padding:6px 12px;border:1px solid #ddd;text-align:left">MOS ID</th>
                <th style="padding:6px 12px;border:1px solid #ddd;text-align:left">Reasons</th>
                <th style="padding:6px 12px;border:1px solid #ddd;text-align:left">p95 chunk</th>
                <th style="padding:6px 12px;border:1px solid #ddd;text-align:left">Avg backoff</th>
                <th style="padding:6px 12px;border:1px solid #ddd;text-align:left">Jobs cache</th>
                <th style="padding:6px 12px;border:1px solid #ddd;text-align:left">Veh cache</th>
                <th style="padding:6px 12px;border:1px solid #ddd;text-align:left">Cust cache</th>
                <th style="padding:6px 12px;border:1px solid #ddd;text-align:left">Status</th>
              </tr>
            </thead>
            <tbody>${rows}</tbody>
          </table>
          <p style="margin-top:16px;color:#666;font-size:13px">
            Sent by <code>/api/cron/backfill-chunk-speed-health</code>. Roll-up source:
            <code>/api/admin/sync-health</code>. Already-breaching shops with unchanged reasons
            are deduped — you'll only be re-paged when something new breaks or reasons change.
          </p>
        </div>`;
}

export type RecoveryEmailInput = {
  shopId: number;
  /** Display name of the recovered shop (e.g. "Acme Auto — ACME-001"). */
  name: string;
  lastSeenP95Ms: number | null;
  lastSeenAt: Date | null;
  /** Reasons the shop had on its last alert, before recovery. */
  previousReasons: string[];
  transition: "auto_clear" | "reasons_changed";
  syncHealthUrl: string;
};

export function buildRecoveryEmailSubject(shopName: string): string {
  return `[MOS] Tekmetric slow-chunk recovered: ${shopName}`;
}

export function buildRecoveryEmailHtml(input: RecoveryEmailInput): string {
  const { shopId, name, lastSeenP95Ms, lastSeenAt, previousReasons, transition, syncHealthUrl: linkBase } = input;
  const lastP95 = formatMs(lastSeenP95Ms);
  const lastSeen = lastSeenAt ? lastSeenAt.toISOString() : "—";
  const otherReasons = previousReasons.filter((x) => x !== "slow_p95");
  const isFullClear = transition === "auto_clear";
  // For partial recovery the dedup row stays alive (the row was just
  // updated to the new reasons in `reasonsChanged`); for full clear
  // the row was deleted just above. Wording matches each case so
  // on-call understands whether anything still needs attention.
  const stateNote = isFullClear
    ? `<p>The dedup row has been cleared, so the shop can re-page if it
              slows down again.</p>`
    : `<p>Other reasons still active: <code>${escapeHtml(
        otherReasons.length > 0 ? otherReasons.join(", ") : "(none)",
      )}</code>. The dedup row remains so those won't re-page; a fresh
              <code>slow_p95</code> regression will trigger another alert.</p>`;
  const otherReasonsBlock =
    isFullClear && otherReasons.length > 0
      ? `<p>Previous reasons also included:
                <code>${escapeHtml(otherReasons.join(", "))}</code>.
                Those cleared too in this auto-clear.</p>`
      : "";
  return `
          <div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;line-height:1.5">
            <h2>Tekmetric Slow-Chunk Recovery</h2>
            <p><strong>${escapeHtml(name)}</strong> (MOS shop ${shopId})
              has dropped back under the
              ${SLOW_P95_THRESHOLD_MS / 60000}-minute p95 chunk threshold.</p>
            <p>Last-seen p95 before recovery: <strong>${lastP95}</strong>
              (observed at ${escapeHtml(lastSeen)}).</p>
            ${otherReasonsBlock}
            ${stateNote}
            <p><a href="${linkBase}">${linkBase}</a></p>
            <p style="margin-top:16px;color:#666;font-size:13px">
              Sent by <code>/api/cron/backfill-chunk-speed-health</code>
              on ${isFullClear ? "auto-clear of" : "slow_p95 drop in"}
              <code>backfill_chunk_speed_alerts</code>.
            </p>
          </div>`;
}

// ---------------------------------------------------------------
// Lightweight HTML lint
// ---------------------------------------------------------------
//
// Designed to catch the kinds of regressions that would slip past a
// substring assertion but make the rendered email look broken in real
// inboxes:
//   - mismatched / unclosed tags (a forgotten `</tr>` will silently
//     wrap subsequent rows in the wrong cell)
//   - unsafe attributes that Gmail / Outlook strip and that have no
//     business in an alert email (`on*=` event handlers, `javascript:`
//     URLs)
//   - inline `style="..."` blocks with malformed declarations
//     (missing colon, unbalanced quotes), which silently kill the rest
//     of the rule on Outlook
//
// Intentionally narrow: this is a sanity check, not a full HTML5
// parser. False negatives are fine; false positives must stay close
// to zero so the lint can be wired into a smoke test or CI later.

export type LintIssue = {
  severity: "error" | "warn";
  message: string;
};

const VOID_ELEMENTS = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
]);

export function lintEmailHtml(html: string): LintIssue[] {
  const issues: LintIssue[] = [];

  // 1) Tag balance check. Strip CDATA / comments first.
  const stripped = html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, "");

  const tagRe = /<\/?\s*([a-zA-Z][a-zA-Z0-9]*)\b([^>]*)>/g;
  const stack: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = tagRe.exec(stripped)) !== null) {
    const full = match[0];
    const name = match[1].toLowerCase();
    const isClose = full.startsWith("</");
    const isSelfClose = /\/\s*>$/.test(full);
    if (VOID_ELEMENTS.has(name) || isSelfClose) continue;
    if (!isClose) {
      stack.push(name);
    } else {
      if (stack.length === 0) {
        issues.push({
          severity: "error",
          message: `Stray closing tag </${name}> with no matching opener`,
        });
        continue;
      }
      const top = stack[stack.length - 1];
      if (top === name) {
        stack.pop();
      } else {
        // Try to recover: pop until we find the matching opener (or run
        // out). Each unclosed opener becomes its own error so the lint
        // reports the precise tag(s) that were never closed.
        const idx = stack.lastIndexOf(name);
        if (idx === -1) {
          issues.push({
            severity: "error",
            message: `Closing </${name}> doesn't match the currently open <${top}>`,
          });
        } else {
          for (let i = stack.length - 1; i > idx; i--) {
            issues.push({
              severity: "error",
              message: `Unclosed <${stack[i]}> before </${name}>`,
            });
          }
          stack.length = idx;
        }
      }
    }
  }
  for (const unclosed of stack) {
    issues.push({
      severity: "error",
      message: `Tag <${unclosed}> was never closed`,
    });
  }

  // 2) Unsafe attributes. Gmail / Outlook strip these, and they have no
  //    place in a one-way alert email.
  const onAttrRe = /\s(on[a-z]+)\s*=/gi;
  let onMatch: RegExpExecArray | null;
  const seenOn = new Set<string>();
  while ((onMatch = onAttrRe.exec(stripped)) !== null) {
    const attr = onMatch[1].toLowerCase();
    if (seenOn.has(attr)) continue;
    seenOn.add(attr);
    issues.push({
      severity: "error",
      message: `Unsafe inline event handler "${attr}=" found in markup`,
    });
  }
  if (/\b(?:href|src)\s*=\s*["']\s*javascript:/i.test(stripped)) {
    issues.push({
      severity: "error",
      message: `Unsafe javascript: URL found in href/src`,
    });
  }

  // 3) Inline-style sanity. Many email clients silently drop the rest
  //    of an inline-style attribute as soon as they hit a malformed
  //    declaration, so a typo in one cell can blank out a whole row's
  //    styling. Check each declaration has `key: value`, and bail
  //    early if the attribute string itself has unbalanced quotes.
  const styleAttrRe = /\sstyle\s*=\s*"([^"]*)"/gi;
  let styleMatch: RegExpExecArray | null;
  let styleIdx = 0;
  while ((styleMatch = styleAttrRe.exec(stripped)) !== null) {
    styleIdx += 1;
    const value = styleMatch[1];
    const decls = value.split(";").map((d) => d.trim()).filter((d) => d.length > 0);
    for (const decl of decls) {
      if (!decl.includes(":")) {
        issues.push({
          severity: "warn",
          message: `Inline style #${styleIdx} has a declaration without a colon: "${decl}"`,
        });
        continue;
      }
      const [k, ...rest] = decl.split(":");
      const key = k.trim();
      const val = rest.join(":").trim();
      if (!key || !/^[-a-zA-Z]+$/.test(key)) {
        issues.push({
          severity: "warn",
          message: `Inline style #${styleIdx} has an invalid property name: "${key}"`,
        });
      }
      if (!val) {
        issues.push({
          severity: "warn",
          message: `Inline style #${styleIdx} property "${key}" has no value`,
        });
      }
    }
  }

  // 4) Width sanity. Outlook clips at ~600px in Reading Pane and any
  //    fixed pixel width above ~700px is a layout-break smell. The
  //    chunk-speed alert table is fluid (no width set), so this catches
  //    a future regression that hard-codes a width.
  const widthRe = /width\s*[:=]\s*["']?\s*(\d{3,4})(?:px)?/gi;
  let widthMatch: RegExpExecArray | null;
  while ((widthMatch = widthRe.exec(stripped)) !== null) {
    const px = Number(widthMatch[1]);
    if (px > 700) {
      issues.push({
        severity: "warn",
        message: `Width ${px}px exceeds 700px — Outlook reading pane will clip the layout`,
      });
    }
  }

  return issues;
}
