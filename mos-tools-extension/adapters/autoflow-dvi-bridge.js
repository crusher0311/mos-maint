// MOS Tools — AutoFlow DVI bridge (MAIN world).
//
// AutoFlow's DVI is a jQuery/PHP app. Its own UI writes through a single
// same-origin endpoint (/Admin/dvi_v3/request.php) authenticated by the
// logged-in session cookie, and keeps all per-item state (results_id,
// tech_id, statuses, notes) in a page-global `defaults` object.
//
// This bridge runs in the page's MAIN world so it can (a) read `defaults`
// and (b) reuse the page's own `$.fn.request` / `$.fn.requestRVH` helpers to
// perform writes — that guarantees the cookie, headers and payload format
// exactly match what AutoFlow's UI sends. It talks to the isolated-world
// content script over window.postMessage, correlating by `requestId`.
(function () {
  function jq() {
    return window.jQuery || window.$ || null;
  }
  function getDefaults() {
    try {
      return window.defaults || null;
    } catch (e) {
      return null;
    }
  }

  // Flatten the DVI into a list of items the content script can match against
  // VHI maintenance data. Names come from the loaded sheet; per-item result
  // state (status / notes / results_id / tech_id) comes from `defaults.results`.
  function readDvi() {
    var d = getDefaults();
    if (!d) return { ok: false, error: "no_defaults" };
    var statusId =
      d.status_id || (d.loadedsheet && d.loadedsheet.status_id) || null;
    var names = (d.loadedsheet && d.loadedsheet.items) || {};
    var results = d.results || {};
    var items = [];
    Object.keys(names).forEach(function (inspecId) {
      var r = results[inspecId] || {};
      items.push({
        inspecId: String(inspecId),
        name: names[inspecId],
        status:
          r.inspec_status !== undefined && r.inspec_status !== null
            ? String(r.inspec_status)
            : "",
        subStatus: r.inspec_sub_status || "",
        resultsId: r.results_id || "",
        techId: r.tech_id || "",
        notes: r.notes || "",
      });
    });
    return { ok: true, statusId: statusId ? String(statusId) : null, items: items };
  }

  function post(type, requestId, payload) {
    try {
      window.postMessage({ type: type, requestId: requestId, payload: payload }, "*");
    } catch (e) {}
  }

  // Reuse the page's own request helper ($.fn.request -> request.php, or
  // $.fn.requestRVH for recommendations). Resolves with { ok, data }.
  function doRequest(fnName, params, requestId) {
    var $ = jq();
    if (!$ || !$.fn || typeof $.fn[fnName] !== "function") {
      post("MOS_AF_WRITE_RESULT", requestId, { ok: false, error: "no_" + fnName });
      return;
    }
    try {
      $.when($.fn[fnName](params)).then(
        function (data) {
          var ok = true;
          // request.php returns {"success":1,...} for update_sheet; add_rvh
          // returns {rvh_id:...} with no success flag — treat presence of a
          // response object as success unless an explicit success:0 is set.
          if (data && typeof data === "object" && "success" in data) {
            ok = !!data.success;
          }
          post("MOS_AF_WRITE_RESULT", requestId, { ok: ok, data: data });
        },
        function () {
          post("MOS_AF_WRITE_RESULT", requestId, { ok: false, error: "request_failed" });
        }
      );
    } catch (e) {
      post("MOS_AF_WRITE_RESULT", requestId, {
        ok: false,
        error: String((e && e.message) || e),
      });
    }
  }

  window.addEventListener("message", function (e) {
    if (e.source !== window) return;
    var m = e.data;
    if (!m || typeof m !== "object" || !m.type) return;
    if (m.type === "MOS_AF_READ_DVI") {
      post("MOS_AF_DVI_DATA", m.requestId, readDvi());
    } else if (m.type === "MOS_AF_WRITE_SHEET") {
      doRequest("request", m.params || {}, m.requestId);
    } else if (m.type === "MOS_AF_WRITE_RVH") {
      doRequest("requestRVH", m.params || {}, m.requestId);
    }
  });

  post("MOS_AF_BRIDGE_READY", null, { ok: true });
  console.log("[MOS Tools] AutoFlow DVI bridge (MAIN world) ready");
})();
