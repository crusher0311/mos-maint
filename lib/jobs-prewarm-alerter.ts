import { sendEmail } from "@/lib/email";

/**
 * Provider-agnostic onboarding pre-warm anomaly alerter.
 *
 * Originally introduced for Tekmetric (task #69) and generalized to
 * Protractor / Shop-Ware in task #74. Each provider has its own
 * pre-warm pipeline (`lib/{tekmetric,protractor,shopware}-jobs-prewarm.ts`)
 * that stamps a `jobsCachePrewarm` record on the shop document with
 * `errors` and `capped` flags. On-call wants the same heads-up across
 * all three providers when those flags trip on a freshly onboarded
 * shop, before the cron's first chunk lands.
 *
 * Why we page on these:
 *   - `errors > 0` means one or more upstream API calls failed during
 *     the onboarding warm — the very first backfill chunk for the shop
 *     will hit those records cold and likely re-fail the same way.
 *   - `capped: true` means the shop has more terminal records in the
 *     lookback window than the per-provider pre-warm cap allows — a
 *     high-volume shop whose first chunk will run colder than expected
 *     because the tail of the window never got warmed.
 *
 * Either case is worth a heads-up before the cron's first chunk lands
 * so on-call can decide whether to bump the cap, schedule a follow-up
 * warm, or investigate the upstream errors.
 *
 * Dedup strategy (mirrors the stuck-shop alerter in
 * `app/api/cron/tekmetric-backfill-health/route.ts`):
 *   - One row per shopId in a per-provider collection
 *     (`{provider}_jobs_cache_prewarm_alerts`). Using a per-provider
 *     collection — instead of a single shared collection keyed by
 *     `(shopId, provider)` — is what satisfies the task brief's
 *     requirement that "the three providers can't collide on the same
 *     dedup document": same MOS shopId can appear in all three
 *     collections without conflict, and it preserves Tekmetric's
 *     existing dedup state from before this generalization.
 *   - `alertedKey` is a sorted, comma-joined list of which flags fired
 *     (e.g. `"capped"`, `"errors"`, `"capped,errors"`).
 *   - We only re-page if the current key differs from `alertedKey` — i.e.
 *     a new failure mode appeared since the last alert. Re-warming via
 *     the platform-admin UI on a shop that's still in the same
 *     anomalous state (e.g. high-volume and still capped) is
 *     suppressed, which is exactly the behavior the original task
 *     brief calls out.
 */

export type PrewarmProvider = "tekmetric" | "protractor" | "shopware";

const PROVIDER_LABELS: Record<PrewarmProvider, string> = {
  tekmetric: "Tekmetric",
  protractor: "Protractor",
  shopware: "Shop-Ware",
};

// Per-provider dedup collections. The Tekmetric name is the original
// collection from task #69 — preserved here to avoid losing
// already-paged shops' dedup state when this module was generalized
// in task #74.
const COLLECTION_NAMES: Record<PrewarmProvider, string> = {
  tekmetric: "tekmetric_jobs_cache_prewarm_alerts",
  protractor: "protractor_jobs_cache_prewarm_alerts",
  shopware: "shopware_jobs_cache_prewarm_alerts",
};

/**
 * Minimum result fields the alerter needs to decide whether to page.
 * Each per-provider pre-warm result happens to be a structural
 * superset of this shape (errors / capped / lookbackDays are stamped
 * onto the shop doc by all three flows), so callers can pass their
 * full result without an explicit narrowing.
 */
export interface PrewarmAnomalyInput {
  errors: number;
  capped: boolean;
  lookbackDays: number;
}

/**
 * One labelled row to render in the alert email's metrics table.
 * Each provider passes its own provider-specific rows
 * (terminal-RO count for Tekmetric, invoices-scanned for Protractor,
 * ROs-fetched for Shop-Ware, etc.) so on-call sees the same shape of
 * forensic data they'd find on the platform-admin sync-health UI.
 */
export interface AlertMetricRow {
  label: string;
  value: string | number;
}

export interface MaybeAlertResult {
  alerted: boolean;
  suppressed: boolean;
  alertedKey: string | null;
  emailed: number;
}

export interface MaybeAlertOptions {
  db: any;
  provider: PrewarmProvider;
  /** MOS shopId — what the dedup row is keyed by within the per-provider collection. */
  shopId: number;
  /**
   * Optional provider-side identifier to display in the email subject /
   * body (e.g. Tekmetric shop ID, Shop-Ware swShopId, Protractor
   * connectionId). Used purely for the on-call human; the dedup
   * collection itself is keyed by MOS shopId.
   */
  providerShopId?: string | number | null;
  providerShopIdLabel?: string;
  /** Errors / capped / lookbackDays from the prewarm result. */
  result: PrewarmAnomalyInput;
  /** Provider-specific metrics rendered into the email body. */
  metrics?: AlertMetricRow[];
  /**
   * Snapshot persisted into the dedup row's
   * `lastAlertedResult` / `lastSeenResult`. Useful when triaging from
   * Mongo without going back to the shop doc.
   */
  snapshot?: Record<string, any>;
  /**
   * Pre-warm completion timestamp captured by the caller. Optional for
   * backwards compatibility, but callers should pass it so the
   * email body's "Pre-warm completed at" matches the persisted shop
   * record to the millisecond.
   */
  completedAt?: Date;
}

function buildAlertedKey(input: PrewarmAnomalyInput): string | null {
  const flags: string[] = [];
  if (input.errors > 0) flags.push("errors");
  if (input.capped) flags.push("capped");
  if (flags.length === 0) return null;
  return flags.sort().join(",");
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function describeFlags(flags: string[], providerLabel: string): string {
  const parts: string[] = [];
  if (flags.includes("errors")) {
    parts.push(
      `one or more ${providerLabel} API calls failed during pre-warm`
    );
  }
  if (flags.includes("capped")) {
    parts.push(
      "the lookback window's terminal-record count hit the pre-warm cap (high-volume shop; tail of the window was not warmed)"
    );
  }
  return parts.join("; ");
}

function logTag(provider: PrewarmProvider): string {
  return `${PROVIDER_LABELS[provider]}JobsPrewarmAlert`;
}

export async function maybeAlertOnPrewarmAnomalies(
  opts: MaybeAlertOptions
): Promise<MaybeAlertResult> {
  const {
    db,
    provider,
    shopId,
    providerShopId = null,
    providerShopIdLabel,
    result,
    metrics = [],
    snapshot,
    completedAt,
  } = opts;

  const providerLabel = PROVIDER_LABELS[provider];
  const collectionName = COLLECTION_NAMES[provider];
  const tag = logTag(provider);

  const alertedKey = buildAlertedKey(result);

  const collection = db.collection(collectionName);
  await collection
    .createIndex({ shopId: 1 }, { unique: true, name: "uniq_shopId" })
    .catch(() => {});

  // Auto-clear: a clean re-warm (no errors, not capped) drops any
  // existing dedup row for this shop so a future regression to the
  // same anomaly state re-pages instead of being silently suppressed.
  // Mirrors the stuck-shop alerter in
  // `app/api/cron/tekmetric-backfill-health/route.ts`, which deletes
  // `tekmetric_backfill_health_alerts` rows for shops that are no
  // longer stuck (see the `resolvedShopIds` block).
  if (!alertedKey) {
    const cleared = await collection.deleteOne({ shopId });
    if (cleared.deletedCount && cleared.deletedCount > 0) {
      console.log(
        `[${tag}] Shop ${shopId}${
          providerShopId !== null && providerShopId !== undefined
            ? ` (${provider} ${providerShopId})`
            : ""
        }: clean re-warm cleared dedup row`
      );
    }
    return { alerted: false, suppressed: false, alertedKey: null, emailed: 0 };
  }

  const now = new Date();
  const completionTs = completedAt ?? now;
  const existing = await collection.findOne({ shopId });

  // Suppression: same anomaly state already paged → don't re-page even
  // if an admin re-warms via the platform-admin UI. We still touch
  // `lastSeenAt` so ops can tell the dedup row is live.
  if (existing && existing.alertedKey === alertedKey) {
    await collection.updateOne(
      { shopId },
      {
        $set: {
          lastSeenAt: now,
          lastSeenResult: snapshot ?? {
            errors: result.errors,
            capped: result.capped,
          },
        },
      }
    );
    return {
      alerted: false,
      suppressed: true,
      alertedKey,
      emailed: 0,
    };
  }

  const flags = alertedKey.split(",");

  // Resolve a human-readable shop label for the email subject.
  const shopDoc = await db.collection("shops").findOne(
    { shopId: { $in: [shopId, String(shopId)] } },
    { projection: { name: 1, locationIdentifier: 1 } }
  );
  const shopName = shopDoc?.locationIdentifier
    ? `${shopDoc?.name || "(unnamed)"} — ${shopDoc.locationIdentifier}`
    : shopDoc?.name || `Shop ${shopId}`;

  const admins = await db
    .collection("users")
    .find(
      { isPlatformAdmin: true, email: { $exists: true, $ne: null } },
      { projection: { email: 1 } }
    )
    .toArray();

  let emailed = 0;
  if (admins.length === 0) {
    console.warn(
      `[${tag}] No platform admins configured; alert logged only`
    );
  } else {
    const baseUrl = process.env.REPLIT_DEV_DOMAIN
      ? `https://${process.env.REPLIT_DEV_DOMAIN}`
      : process.env.NEXT_PUBLIC_APP_URL || "";
    const syncHealthLink = baseUrl
      ? `${baseUrl}/platform-admin/sync-health`
      : "/platform-admin/sync-health";
    const completedAtIso = completionTs.toISOString();
    const subjectLabel =
      flags.includes("errors") && flags.includes("capped")
        ? "errors + capped"
        : flags[0];

    const providerIdRow =
      providerShopId !== null && providerShopId !== undefined
        ? `<tr>
            <td style="padding:6px 12px;border:1px solid #ddd"><strong>${escapeHtml(
              providerShopIdLabel || `${providerLabel} shop ID`
            )}</strong></td>
            <td style="padding:6px 12px;border:1px solid #ddd"><code>${escapeHtml(
              String(providerShopId)
            )}</code></td>
          </tr>`
        : "";

    const metricRows = metrics
      .map(
        (m) => `<tr>
          <td style="padding:6px 12px;border:1px solid #ddd"><strong>${escapeHtml(
            m.label
          )}</strong></td>
          <td style="padding:6px 12px;border:1px solid #ddd">${escapeHtml(
            String(m.value)
          )}</td>
        </tr>`
      )
      .join("");

    const providerIdSubjectSuffix =
      providerShopId !== null && providerShopId !== undefined
        ? ` (${providerLabel} shop <code>${escapeHtml(String(providerShopId))}</code>)`
        : "";

    const html = `
      <div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;line-height:1.5">
        <h2>${escapeHtml(providerLabel)} Jobs-Cache Pre-Warm Anomaly</h2>
        <p>The onboarding pre-warm for <strong>${escapeHtml(shopName)}</strong>
          (MOS shop <code>${shopId}</code>)${providerIdSubjectSuffix}
          finished with one or more anomalies that will affect the very first backfill chunk:</p>
        <p><strong>${escapeHtml(describeFlags(flags, providerLabel))}.</strong></p>
        <table style="border-collapse:collapse;border:1px solid #ddd;font-size:13px">
          <tbody>
            <tr>
              <td style="padding:6px 12px;border:1px solid #ddd"><strong>Provider</strong></td>
              <td style="padding:6px 12px;border:1px solid #ddd">${escapeHtml(providerLabel)}</td>
            </tr>
            <tr>
              <td style="padding:6px 12px;border:1px solid #ddd"><strong>MOS shop ID</strong></td>
              <td style="padding:6px 12px;border:1px solid #ddd"><code>${shopId}</code></td>
            </tr>
            ${providerIdRow}
            <tr>
              <td style="padding:6px 12px;border:1px solid #ddd"><strong>Pre-warm completed at</strong></td>
              <td style="padding:6px 12px;border:1px solid #ddd">${completedAtIso}</td>
            </tr>
            <tr>
              <td style="padding:6px 12px;border:1px solid #ddd"><strong>Errors</strong></td>
              <td style="padding:6px 12px;border:1px solid #ddd">${result.errors}</td>
            </tr>
            <tr>
              <td style="padding:6px 12px;border:1px solid #ddd"><strong>Capped</strong></td>
              <td style="padding:6px 12px;border:1px solid #ddd">${result.capped ? "yes" : "no"}</td>
            </tr>
            <tr>
              <td style="padding:6px 12px;border:1px solid #ddd"><strong>Lookback (days)</strong></td>
              <td style="padding:6px 12px;border:1px solid #ddd">${result.lookbackDays}</td>
            </tr>
            ${metricRows}
          </tbody>
        </table>
        <p style="margin-top:12px">
          <a href="${escapeHtml(syncHealthLink)}">Open the platform-admin sync-health page →</a>
        </p>
        <p style="margin-top:16px;color:#666;font-size:13px">
          Sent by <code>lib/jobs-prewarm-alerter.ts</code>. Dedup is per-shop
          on the anomaly state (<code>${escapeHtml(alertedKey)}</code>) within
          the <code>${escapeHtml(collectionName)}</code> collection — re-warming
          via the UI on a shop in the same state is suppressed; you'll only be
          re-paged if a new failure mode appears.
        </p>
      </div>`;

    for (const admin of admins as Array<{ email: string }>) {
      try {
        await sendEmail({
          to: admin.email,
          subject: `[MOS] ${providerLabel} jobs-cache pre-warm anomaly (${subjectLabel}): ${shopName}`,
          html,
        });
        emailed++;
      } catch (err: any) {
        console.error(
          `[${tag}] Email send failed for ${admin.email}:`,
          err?.message
        );
      }
    }
  }

  await collection.updateOne(
    { shopId },
    {
      $set: {
        shopId,
        provider,
        ...(providerShopId !== null && providerShopId !== undefined
          ? { providerShopId }
          : {}),
        alertedKey,
        flags,
        lastAlertedAt: now,
        lastAlertedResult: {
          ...(snapshot ?? {
            errors: result.errors,
            capped: result.capped,
          }),
          completedAt: completionTs,
        },
        lastSeenAt: now,
        ...(existing?.alertedKey
          ? { previousAlertedKey: existing.alertedKey }
          : {}),
      },
      $setOnInsert: { firstAlertedAt: now },
    },
    { upsert: true }
  );

  console.log(
    `[${tag}] Shop ${shopId}${
      providerShopId !== null && providerShopId !== undefined
        ? ` (${provider} ${providerShopId})`
        : ""
    }: alertedKey=${alertedKey} previousKey=${existing?.alertedKey ?? "none"} emailed=${emailed}`
  );

  return { alerted: true, suppressed: false, alertedKey, emailed };
}
