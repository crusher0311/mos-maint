// MOS Tools — pure undo-snapshot logic (Task #1086).
//
// Before an AI-driven write (Enhance Notes, DVI pre-fill, Add VHI
// recommendations) is applied, the extension captures the pre-write values
// into a durable snapshot (chrome.storage.local, owned by the background).
// This module holds the PURE logic — keys, pruning, revert-op construction —
// so it can be unit-tested under node without chrome APIs.
//
// Loaded three ways:
//   * content scripts (tekmetric/autoflow adapters) via manifest.json — sets
//     a global `MosUndoCore`;
//   * background.js (ES module) via a side-effect import — reads
//     `globalThis.MosUndoCore`;
//   * tsx smoke tests via createRequire (module.exports guard below).
(function (root) {
  const UNDO_MAX_ENTRIES = 20;
  const UNDO_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24h

  // Snapshot shape:
  // {
  //   provider: 'tekmetric' | 'autoflow',
  //   shopId, roId,                    // strings/numbers — the SMS-side ids
  //   kind: 'dvi_prefill' | 'enhance_notes' | 'add_vhi_recommendations',
  //   createdAt: epoch ms,
  //   label: human summary,
  //   items: [...]                     // per-kind originals (see builders)
  // }
  function makeUndoKey(snap) {
    return [snap.provider, snap.shopId, snap.roId, snap.kind].map(String).join(":");
  }

  // Prune a stored { key -> snapshot } map: drop entries older than
  // maxAgeMs, then keep only the newest maxEntries. Returns a NEW map.
  function pruneUndoSnapshots(map, now, opts) {
    const maxEntries = (opts && opts.maxEntries) || UNDO_MAX_ENTRIES;
    const maxAgeMs = (opts && opts.maxAgeMs) || UNDO_MAX_AGE_MS;
    const entries = Object.entries(map || {}).filter(
      ([, s]) => s && typeof s.createdAt === "number" && now - s.createdAt <= maxAgeMs
    );
    entries.sort((a, b) => b[1].createdAt - a[1].createdAt);
    const out = {};
    for (const [k, s] of entries.slice(0, maxEntries)) out[k] = s;
    return out;
  }

  function summarizeSnapshot(snap) {
    const n = Array.isArray(snap.items) ? snap.items.length : 0;
    const what =
      snap.kind === "enhance_notes"
        ? `enhanced note${n === 1 ? "" : "s"}`
        : snap.kind === "dvi_prefill"
          ? `pre-filled DVI item${n === 1 ? "" : "s"}`
          : snap.kind === "sidepanel_add_job"
            ? `job${n === 1 ? "" : "s"} added to RO`
            : `added recommendation${n === 1 ? "" : "s"}`;
    return `${n} ${what}`;
  }

  // Task #1094 — partial-undo bookkeeping for side-panel add snapshots.
  // Given a snapshot's items and the set of job ids that were successfully
  // deleted, return the items that must STAY in the snapshot so a later
  // retry can still remove them. Items without a jobId are kept (they were
  // never attempted). Id comparison is string-based — page-API ids come back
  // as numbers or strings depending on the caller.
  function remainingUndoItems(items, revertedJobIds) {
    if (!Array.isArray(items)) return [];
    const done = new Set((revertedJobIds || []).map(String));
    return items.filter((it) => !(it && it.jobId != null && done.has(String(it.jobId))));
  }

  // Build the ordered AutoFlow revert operations for a snapshot. The content
  // script executes these through the same MAIN-world bridge write paths the
  // apply used (writeAutoflowSheet / writeAutoflowRvh).
  //
  //   dvi_prefill / enhance_notes items:
  //     { inspecId, prevStatus, prevNotes, resultsId, techId }
  //   add_vhi_recommendations items:
  //     { rvhId, title }
  function buildAutoflowRevertOps(snap) {
    const ops = [];
    if (!snap || !Array.isArray(snap.items)) return ops;
    if (snap.kind === "add_vhi_recommendations") {
      // Verified against AutoFlow's public jquery.atme.rvh.js (2026-08-12):
      // the page's own $.fn.deleteRVH posts exactly
      // { status_id, rvh_id, request_type: 'delete_rvh' } via $.fn.requestRVH,
      // which resolves only on success:1 — so this op mirrors the native
      // delete path 1:1.
      for (const it of snap.items) {
        if (it && it.rvhId != null) {
          ops.push({
            type: "rvh_delete",
            params: {
              request_type: "delete_rvh",
              rvh_id: String(it.rvhId),
              status_id: String(snap.statusId || snap.roId),
            },
            label: it.title || "recommendation",
          });
        }
      }
      return ops;
    }
    // Sheet write-back: restore original status + notes on each item.
    for (const it of snap.items) {
      if (!it || it.inspecId == null) continue;
      const params = {
        request_type: "update_sheet",
        status_id: String(snap.statusId || snap.roId),
        inspec_id: String(it.inspecId),
        notes: typeof it.prevNotes === "string" ? it.prevNotes : "",
      };
      // Only restore a status the item actually had — an empty prevStatus
      // means "unset", and sending inspec_status='' would coerce to 0 (RED).
      if (it.prevStatus !== "" && it.prevStatus != null) params.inspec_status = it.prevStatus;
      if (snap.sheetId) params.sheet_id = snap.sheetId;
      if (it.resultsId) params.results_id = it.resultsId;
      if (it.techId) params.prev_tech_id = it.techId;
      ops.push({ type: "sheet", params, label: it.name || `item ${it.inspecId}` });
    }
    return ops;
  }

  const api = {
    UNDO_MAX_ENTRIES,
    UNDO_MAX_AGE_MS,
    makeUndoKey,
    pruneUndoSnapshots,
    summarizeSnapshot,
    remainingUndoItems,
    buildAutoflowRevertOps,
  };

  root.MosUndoCore = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
