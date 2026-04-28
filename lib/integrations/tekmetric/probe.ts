// Reusable on-call probe helpers for Tekmetric shops.
//
// These helpers exist so that any future "is this stuck shop reachable?"
// check goes through the SAME safe path, instead of being re-implemented
// inline in a one-off script (the failure mode that bit task #23 — see
// the REGRESSION GUARD note below).
//
// Two functions live here:
//   - `probeTekmetricShop(tekmetricShopId, mosShopId)`: makes a single
//     low-cost Tekmetric request to confirm reachability and surface any
//     auth/credential failure. Returns `{ ok, detail }`.
//   - `recordProbeResult(db, mosShopId, probe, { source })`: persists the
//     probe outcome on DEDICATED `lastProbedAt` / `lastProbeOk` /
//     `lastProbeError` / `lastProbeNote` fields on the
//     `tekmetric_backfill_progress` row. It NEVER writes `lastRunAt` or
//     `lastError`.
//
// !!! REGRESSION GUARD — DO NOT REMOVE !!!
// The cron's fair-queue ordering in
// `app/api/cron/tekmetric-backfill/route.ts` sorts incomplete shops by
// `lastRunAt` (null first), and the auto-clear gate suppresses retries
// for `ERROR_AUTO_CLEAR_HOURS` after a `lastError` is set. A probe that
// stamps `lastRunAt` / `lastError` therefore:
//   (a) Demotes the shop from the high-priority "never_started" bucket
//       to the bottom of the "stalled" bucket.
//   (b) Blocks auto-clear for the full 6h window.
// Task #23's original restart script did exactly this and had to be
// recovered by bypassing the cron entirely (task #36 →
// `scripts/drive-task-23-restarted-shops.ts`). Task #46 fixed the
// regression by splitting probe-only fields off; this module is the
// canonical place for that pattern. Future probe helpers MUST go through
// `recordProbeResult` and MUST NOT touch `lastRunAt` / `lastError`.

import type { Db } from "mongodb";
import { tekmetricRequest } from "./client";

export interface TekmetricProbeResult {
  ok: boolean;
  detail: string;
}

/**
 * Issue a single low-cost Tekmetric request against the given shop to
 * confirm the shop is reachable with the current credentials. Uses
 * `/repair-orders?shop=<id>&page=0&size=1` because that's the same
 * endpoint the backfill cron uses, so an auth/credential failure here
 * mirrors what the cron would see.
 *
 * Never throws — failures are returned as `{ ok: false, detail }` so the
 * caller can record them via `recordProbeResult`.
 */
export async function probeTekmetricShop(
  tekmetricShopId: number,
  mosShopId: number,
): Promise<TekmetricProbeResult> {
  try {
    const data = await tekmetricRequest<{ totalElements?: number; content?: any[] }>(
      `/repair-orders?shop=${tekmetricShopId}&page=0&size=1`,
      {},
      mosShopId,
    );
    const total = data?.totalElements ?? data?.content?.length ?? 0;
    return { ok: true, detail: `reachable; totalElements=${total}` };
  } catch (err: any) {
    const raw = err?.message ? String(err.message) : String(err);
    return { ok: false, detail: raw.slice(0, 300) };
  }
}

/**
 * Persist a probe outcome on the `tekmetric_backfill_progress` row for
 * `mosShopId`. Writes ONLY to the dedicated probe fields:
 *   - `lastProbedAt`
 *   - `lastProbeOk`
 *   - `lastProbeError`  (null when ok)
 *   - `lastProbeNote`   (human-readable, includes the `source` tag)
 *
 * It deliberately does NOT touch `lastRunAt` or `lastError` — see the
 * REGRESSION GUARD comment at the top of this file for why.
 *
 * `source` should identify the caller (e.g. `"probe-script"`,
 * `"oncall-cli"`, `"task-23"`) so the note is greppable later.
 */
export async function recordProbeResult(
  db: Db,
  mosShopId: number,
  probe: TekmetricProbeResult,
  options: { source: string; at?: Date } = { source: "probe" },
): Promise<void> {
  const now = options.at ?? new Date();
  const message = probe.ok
    ? `Tekmetric reachable (${probe.detail})`
    : `Tekmetric NOT reachable: ${probe.detail}`;

  await db.collection("tekmetric_backfill_progress").updateOne(
    { shopId: mosShopId },
    {
      $set: {
        shopId: mosShopId,
        lastProbedAt: now,
        lastProbeOk: probe.ok,
        lastProbeError: probe.ok ? null : message,
        lastProbeNote: `${options.source} probe at ${now.toISOString()}: ${message}`,
      },
    },
    { upsert: true },
  );
}
