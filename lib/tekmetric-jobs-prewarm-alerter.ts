import { sendEmail } from "@/lib/email";

// Local copy of the prewarm result shape we care about. We deliberately
// don't `import type` from `lib/tekmetric-jobs-prewarm.ts` to avoid a
// cycle (prewarm imports this alerter at runtime). Only the fields below
// are read here.
interface PrewarmJobsCacheResult {
  errors: number;
  capped: boolean;
  lookbackDays: number;
  terminalRosFound: number;
  rosCached: number;
  jobsCached: number;
}

/**
 * Pre-warm anomaly alerter — follow-up to task #63 (which surfaced
 * `errors` and `capped` flags in the sync-health UI) and task #59 (the
 * onboarding pre-warm itself).
 *
 * Why page on these:
 *   - `errors > 0` means one or more `/jobs` calls failed during the
 *     onboarding warm — the very first backfill chunk for the shop will
 *     hit those ROs cold and likely re-fail the same way.
 *   - `capped: true` means the shop has more than `PREWARM_MAX_ROS` (500)
 *     terminal ROs in the 90-day window — a high-volume shop whose first
 *     chunk will run colder than expected because the tail of the window
 *     never got warmed.
 *
 * Either case is worth a heads-up to on-call before the cron's first
 * chunk lands so they can decide whether to bump the cap, schedule a
 * follow-up warm, or investigate the upstream errors.
 *
 * Dedup strategy (mirrors the stuck-shop alerter in
 * `app/api/cron/tekmetric-backfill-health/route.ts`):
 *   - One row per shopId in `tekmetric_jobs_cache_prewarm_alerts`.
 *   - `alertedKey` is a sorted, comma-joined list of which flags fired
 *     (e.g. `"capped"`, `"errors"`, `"capped,errors"`).
 *   - We only re-page if the current key differs from `alertedKey` — i.e.
 *     a new failure mode appeared since last alert. Re-warming via the
 *     platform-admin UI on a shop that's still in the same anomalous
 *     state (e.g. high-volume and still capped) is suppressed, which is
 *     exactly the behavior the task brief calls out.
 */

const COLLECTION_NAME = "tekmetric_jobs_cache_prewarm_alerts";

export interface MaybeAlertResult {
  alerted: boolean;
  suppressed: boolean;
  alertedKey: string | null;
  emailed: number;
}

function buildAlertedKey(result: PrewarmJobsCacheResult): string | null {
  const flags: string[] = [];
  if (result.errors > 0) flags.push("errors");
  if (result.capped) flags.push("capped");
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

function describeFlags(flags: string[]): string {
  const parts: string[] = [];
  if (flags.includes("errors")) {
    parts.push("one or more `/jobs` calls failed during pre-warm");
  }
  if (flags.includes("capped")) {
    parts.push(
      "the 90-day terminal-RO count hit the pre-warm cap (high-volume shop; tail of the window was not warmed)"
    );
  }
  return parts.join("; ");
}

export async function maybeAlertOnPrewarmAnomalies(
  db: any,
  shopId: number,
  tekmetricShopId: number,
  result: PrewarmJobsCacheResult,
  // Pre-warm completion timestamp captured by the caller. Optional for
  // backwards compatibility with any future callers that don't have it
  // handy, but the prewarm function itself always passes it so the email
  // body's "Pre-warm completed at" matches the persisted shop record.
  completedAt?: Date
): Promise<MaybeAlertResult> {
  const alertedKey = buildAlertedKey(result);

  const collection = db.collection(COLLECTION_NAME);
  await collection
    .createIndex({ shopId: 1 }, { unique: true, name: "uniq_shopId" })
    .catch(() => {});

  // Auto-clear: a clean re-warm (no errors, not capped) drops any existing
  // dedup row for this shop so a future regression to the same anomaly state
  // re-pages instead of being silently suppressed. Mirrors the stuck-shop
  // alerter in `app/api/cron/tekmetric-backfill-health/route.ts`, which
  // deletes `tekmetric_backfill_health_alerts` rows for shops that are no
  // longer stuck (see the `resolvedShopIds` block).
  if (!alertedKey) {
    const cleared = await collection.deleteOne({ shopId });
    if (cleared.deletedCount && cleared.deletedCount > 0) {
      console.log(
        `[TekmetricJobsPrewarmAlert] Shop ${shopId} (tek ${tekmetricShopId}): clean re-warm cleared dedup row`
      );
    }
    return { alerted: false, suppressed: false, alertedKey: null, emailed: 0 };
  }

  const now = new Date();
  const completionTs = completedAt ?? now;
  const existing = await collection.findOne({ shopId });

  // Suppression: same anomaly state already paged → don't re-page even if
  // an admin re-warms via the platform-admin UI. We still touch
  // `lastSeenAt` so ops can tell the dedup row is live.
  if (existing && existing.alertedKey === alertedKey) {
    await collection.updateOne(
      { shopId },
      {
        $set: {
          lastSeenAt: now,
          lastSeenResult: {
            errors: result.errors,
            capped: result.capped,
            rosCached: result.rosCached,
            terminalRosFound: result.terminalRosFound,
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
      "[TekmetricJobsPrewarmAlert] No platform admins configured; alert logged only"
    );
  } else {
    const baseUrl = process.env.REPLIT_DEV_DOMAIN
      ? `https://${process.env.REPLIT_DEV_DOMAIN}`
      : process.env.NEXT_PUBLIC_APP_URL || "";
    const syncHealthLink = baseUrl
      ? `${baseUrl}/platform-admin/sync-health`
      : "/platform-admin/sync-health";
    const completedAtIso = completionTs.toISOString();
    const subjectLabel = flags.includes("errors") && flags.includes("capped")
      ? "errors + capped"
      : flags[0];

    const html = `
      <div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;line-height:1.5">
        <h2>Tekmetric Jobs-Cache Pre-Warm Anomaly</h2>
        <p>The onboarding pre-warm for <strong>${escapeHtml(shopName)}</strong>
          (MOS shop <code>${shopId}</code>, Tekmetric shop <code>${tekmetricShopId}</code>)
          finished with one or more anomalies that will affect the very first backfill chunk:</p>
        <p><strong>${escapeHtml(describeFlags(flags))}.</strong></p>
        <table style="border-collapse:collapse;border:1px solid #ddd;font-size:13px">
          <tbody>
            <tr>
              <td style="padding:6px 12px;border:1px solid #ddd"><strong>MOS shop ID</strong></td>
              <td style="padding:6px 12px;border:1px solid #ddd"><code>${shopId}</code></td>
            </tr>
            <tr>
              <td style="padding:6px 12px;border:1px solid #ddd"><strong>Tekmetric shop ID</strong></td>
              <td style="padding:6px 12px;border:1px solid #ddd"><code>${tekmetricShopId}</code></td>
            </tr>
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
            <tr>
              <td style="padding:6px 12px;border:1px solid #ddd"><strong>Terminal ROs found</strong></td>
              <td style="padding:6px 12px;border:1px solid #ddd">${result.terminalRosFound}</td>
            </tr>
            <tr>
              <td style="padding:6px 12px;border:1px solid #ddd"><strong>ROs newly cached</strong></td>
              <td style="padding:6px 12px;border:1px solid #ddd">${result.rosCached}</td>
            </tr>
            <tr>
              <td style="padding:6px 12px;border:1px solid #ddd"><strong>Jobs cached</strong></td>
              <td style="padding:6px 12px;border:1px solid #ddd">${result.jobsCached}</td>
            </tr>
          </tbody>
        </table>
        <p style="margin-top:12px">
          <a href="${escapeHtml(syncHealthLink)}">Open the platform-admin sync-health page →</a>
        </p>
        <p style="margin-top:16px;color:#666;font-size:13px">
          Sent by <code>lib/tekmetric-jobs-prewarm-alerter.ts</code>. Dedup is per-shop
          on the anomaly state (<code>${escapeHtml(alertedKey)}</code>) — re-warming via the
          UI on a shop in the same state is suppressed; you'll only be re-paged if a
          new failure mode appears.
        </p>
      </div>`;

    for (const admin of admins as Array<{ email: string }>) {
      try {
        await sendEmail({
          to: admin.email,
          subject: `[MOS] Tekmetric jobs-cache pre-warm anomaly (${subjectLabel}): ${shopName}`,
          html,
        });
        emailed++;
      } catch (err: any) {
        console.error(
          `[TekmetricJobsPrewarmAlert] Email send failed for ${admin.email}:`,
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
        tekmetricShopId,
        alertedKey,
        flags,
        lastAlertedAt: now,
        lastAlertedResult: {
          errors: result.errors,
          capped: result.capped,
          rosCached: result.rosCached,
          terminalRosFound: result.terminalRosFound,
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
    `[TekmetricJobsPrewarmAlert] Shop ${shopId} (tek ${tekmetricShopId}): alertedKey=${alertedKey} previousKey=${existing?.alertedKey ?? "none"} emailed=${emailed}`
  );

  return { alerted: true, suppressed: false, alertedKey, emailed };
}
