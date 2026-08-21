// MOS Tools — AutoFlow DVI bridge (MAIN world).
//
// AutoFlow runs TWO generations of its DVI at once:
//
//  v3 (legacy, *.autotext.me): a jQuery/PHP app. Its UI writes through a
//  single same-origin endpoint (/Admin/dvi_v3/request.php) authenticated by
//  the logged-in session cookie, and keeps all per-item state (results_id,
//  tech_id, statuses, notes) in a page-global `defaults` object. We reuse the
//  page's own `$.fn.request` / `$.fn.requestRVH` helpers for writes.
//
//  v4 (app.autoflow.com/shop/<n>/dvi/<id>): a Laravel + Inertia SPA. There is
//  no `defaults` and no jQuery request helper. Reads come from the Inertia
//  page payload (embedded in `#app[data-page]` and re-fetchable with
//  `X-Inertia` headers). Writes are plain JSON POSTs to
//  `/shop/<shop>/dvi/<statusId>/results/<inspecId>` guarded by Laravel's
//  XSRF-TOKEN cookie (HAR-confirmed 2026-07-19):
//    - a minimal body {inspec_id, status_id, inspec_status} creates/updates
//      the result and RETURNS the full result object (incl. results_id);
//    - AutoFlow's own UI then POSTs that full object back with notes/
//      recommendation merged in — we mirror that exact two-step dance.
//
// This bridge runs in the page's MAIN world and talks to the isolated-world
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

  // ==================== v4 (Inertia) support ====================

  function v4Match() {
    return window.location.pathname.match(/^\/shop\/(\d+)\/dvi\/(\d+)/);
  }

  function isV4Dvi() {
    return !!v4Match() && !getDefaults();
  }

  function readXsrfToken() {
    try {
      var m = document.cookie.match(/(?:^|;\s*)XSRF-TOKEN=([^;]+)/);
      return m ? decodeURIComponent(m[1]) : null;
    } catch (e) {
      return null;
    }
  }

  function getInertiaPageAttr() {
    try {
      var el = document.getElementById("app");
      var raw = el && el.getAttribute("data-page");
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      return null;
    }
  }

  // Fetch a FRESH copy of the Inertia page payload (the data-page attribute
  // is a boot-time snapshot and goes stale after in-page edits). Falls back
  // to the attribute snapshot if the fetch fails.
  function fetchInertiaPage() {
    var attr = getInertiaPageAttr();
    var headers = {
      "X-Inertia": "true",
      "X-Requested-With": "XMLHttpRequest",
      Accept: "text/html, application/xhtml+xml",
    };
    if (attr && attr.version) headers["X-Inertia-Version"] = String(attr.version);
    return fetch(window.location.pathname + window.location.search, {
      method: "GET",
      credentials: "same-origin",
      headers: headers,
    })
      .then(function (r) {
        var ct = (r.headers.get("content-type") || "").toLowerCase();
        if (!r.ok || ct.indexOf("json") === -1) throw new Error("non_inertia_response");
        return r.json();
      })
      .catch(function () {
        return attr; // stale but better than nothing
      });
  }

  // Shape-agnostic deep scan of the Inertia props: AutoFlow's exact prop
  // nesting is an implementation detail we don't control, but DVI sheet
  // items always carry {inspec_id, inspec_name} and per-item results always
  // carry {results_id, inspec_id, inspec_status}. Collect both wherever they
  // live and join them on inspec_id.
  function scanV4Page(page) {
    var items = {}; // inspec_id -> { name, sheetId }
    var results = {}; // inspec_id -> { resultsId, status, notes, techId }
    var seen = typeof WeakSet !== "undefined" ? new WeakSet() : null;
    var MAX_NODES = 200000;
    var count = 0;

    function walk(node) {
      if (!node || typeof node !== "object") return;
      if (seen) {
        if (seen.has(node)) return;
        seen.add(node);
      }
      if (++count > MAX_NODES) return;
      if (Array.isArray(node)) {
        for (var i = 0; i < node.length; i++) walk(node[i]);
        return;
      }
      if (node.inspec_id != null && typeof node.inspec_name === "string") {
        var id = String(node.inspec_id);
        items[id] = items[id] || {};
        items[id].name = node.inspec_name;
        if (node.sheet_id != null) items[id].sheetId = String(node.sheet_id);
      }
      if (node.results_id != null && node.inspec_id != null) {
        var rid = String(node.inspec_id);
        results[rid] = {
          resultsId: String(node.results_id),
          status:
            node.inspec_status !== undefined && node.inspec_status !== null
              ? String(node.inspec_status)
              : "",
          notes: typeof node.notes === "string" ? node.notes : "",
          techId: node.tech_id != null ? String(node.tech_id) : "",
        };
      }
      for (var k in node) {
        if (Object.prototype.hasOwnProperty.call(node, k)) walk(node[k]);
      }
    }

    walk(page && page.props ? page.props : page);
    return { items: items, results: results };
  }

  function readDviV4() {
    var m = v4Match();
    if (!m) return Promise.resolve({ ok: false, error: "not_v4_dvi" });
    var statusId = m[2];
    return fetchInertiaPage().then(function (page) {
      if (!page) return { ok: false, error: "no_inertia_page" };
      var scanned = scanV4Page(page);
      var out = [];
      var sheetId = null;
      Object.keys(scanned.items).forEach(function (inspecId) {
        var it = scanned.items[inspecId];
        var r = scanned.results[inspecId] || {};
        if (it.sheetId && !sheetId) sheetId = it.sheetId;
        out.push({
          inspecId: inspecId,
          name: it.name,
          status: r.status || "",
          resultsId: r.resultsId || "",
          techId: r.techId || "",
          notes: r.notes || "",
        });
      });
      if (out.length === 0) return { ok: false, error: "v4_no_items" };
      return { ok: true, statusId: statusId, sheetId: sheetId, items: out, v4: true };
    });
  }

  // v4 write: translate the v3-style update_sheet params the content script
  // sends into the v4 results POST. Two-step (HAR-confirmed): first POST the
  // minimal status body — the server creates/updates the result and returns
  // the FULL result object — then, if we have notes to write, merge them into
  // that returned object and POST it back verbatim (exactly what AutoFlow's
  // own saveResultFields does).
  function writeSheetV4(params, requestId) {
    var m = v4Match();
    var xsrf = readXsrfToken();
    if (!m) return post("MOS_AF_WRITE_RESULT", requestId, { ok: false, error: "not_v4_dvi" });
    if (!xsrf) return post("MOS_AF_WRITE_RESULT", requestId, { ok: false, error: "no_xsrf_token" });
    var shopNum = m[1];
    var statusId = String(params.status_id || m[2]);
    var inspecId = String(params.inspec_id || "");
    if (!inspecId) return post("MOS_AF_WRITE_RESULT", requestId, { ok: false, error: "no_inspec_id" });
    var url = "/shop/" + shopNum + "/dvi/" + statusId + "/results/" + inspecId;
    var headers = {
      "Content-Type": "application/json",
      Accept: "application/json, text/plain, */*",
      "X-Requested-With": "XMLHttpRequest",
      "X-XSRF-TOKEN": xsrf,
    };

    function doPost(body) {
      return fetch(url, {
        method: "POST",
        credentials: "same-origin",
        headers: headers,
        body: JSON.stringify(body),
      }).then(function (r) {
        if (!r.ok) throw new Error("http_" + r.status);
        return r.json();
      });
    }

    var statusBody = {
      inspec_id: Number(inspecId),
      status_id: Number(statusId),
      inspec_status: Number(params.inspec_status),
    };

    doPost(statusBody)
      .then(function (resp) {
        var result = resp && resp.data && resp.data.result;
        var notes = typeof params.notes === "string" ? params.notes : "";
        if (!notes || !result || typeof result !== "object") {
          return { ok: true, data: resp };
        }
        var full = {};
        for (var k in result) {
          if (Object.prototype.hasOwnProperty.call(result, k)) full[k] = result[k];
        }
        full.notes = notes;
        return doPost(full).then(function (resp2) {
          return { ok: true, data: resp2 };
        });
      })
      .then(function (out) {
        post("MOS_AF_WRITE_RESULT", requestId, out);
      })
      .catch(function (e) {
        post("MOS_AF_WRITE_RESULT", requestId, {
          ok: false,
          error: String((e && e.message) || e),
        });
      });
  }

  // ---------- v4 RVH (recommendations) support ----------
  //
  // v4 DOES have the RVH concept: the CustomerView SPA ships Rvh Vue
  // components (build/assets/Rvh3.js, publicly fetchable) that write through
  // Laravel routes named `rvh.create` / `rvh.update` / `rvh.delete` /
  // `rvh.items` (verified 2026-08-12 against app.autoflow.com/build assets):
  //   - create: axios.post(route('rvh.create', {shop_id}), item)
  //     with item = { type, details, notes, status_id, ... } (type 0=Concern,
  //     1=Information, 2=Service — same enum as v3's add_rvh select);
  //   - delete: axios.delete(route('rvh.delete', {shop_id, id}));
  //   - list:   axios.get(route('rvh.items', {shop_id, status_id})) →
  //     resp.data.data.items (each item carries rvh_id).
  // route() is Ziggy: the page exposes the route table on globalThis.Ziggy
  // (or a #ziggy-routes-json script tag), so we resolve the concrete URI at
  // runtime instead of hardcoding a path AutoFlow could move.

  function getZiggy() {
    try {
      if (window.Ziggy && window.Ziggy.routes) return window.Ziggy;
    } catch (e) {}
    try {
      var el = document.getElementById("ziggy-routes-json");
      if (el && el.textContent) {
        var z = JSON.parse(el.textContent);
        if (z && z.routes) return z;
      }
    } catch (e) {}
    return null;
  }

  // Resolve a named Ziggy route to a same-origin path with {param}s filled.
  // Returns null when the route table or the named route is unavailable.
  function resolveZiggyRoute(name, params) {
    var z = getZiggy();
    var def = z && z.routes && z.routes[name];
    if (!def || !def.uri) return null;
    var uri = String(def.uri).replace(/\{(\w+)\??\}/g, function (_, p) {
      return params && params[p] != null ? encodeURIComponent(String(params[p])) : "";
    });
    if (uri.indexOf("{") !== -1) return null; // unfilled required param
    return "/" + uri.replace(/^\/+/, "").replace(/\/+$/, "");
  }

  function v4RvhHeaders(xsrf) {
    return {
      "Content-Type": "application/json",
      Accept: "application/json, text/plain, */*",
      "X-Requested-With": "XMLHttpRequest",
      "X-XSRF-TOKEN": xsrf,
    };
  }

  // Deep-scan a create response for the created entry's rvh_id (response
  // shape is not pinned by the SPA — its own UI ignores the body and just
  // re-fetches the list).
  function findRvhId(node, depth) {
    if (!node || typeof node !== "object" || (depth || 0) > 6) return null;
    if (node.rvh_id != null) return node.rvh_id;
    for (var k in node) {
      if (!Object.prototype.hasOwnProperty.call(node, k)) continue;
      var found = findRvhId(node[k], (depth || 0) + 1);
      if (found != null) return found;
    }
    return null;
  }

  // Fallback id recovery: list the DVI's RVH entries and pick the newest one
  // whose details match what we just created.
  function lookupRvhIdByDetails(shopNum, statusId, details, xsrf) {
    var url = resolveZiggyRoute("rvh.items", { shop_id: shopNum, status_id: statusId });
    if (!url) return Promise.resolve(null);
    return fetch(url, {
      method: "GET",
      credentials: "same-origin",
      headers: v4RvhHeaders(xsrf),
    })
      .then(function (r) {
        if (!r.ok) throw new Error("http_" + r.status);
        return r.json();
      })
      .then(function (resp) {
        var items =
          (resp && resp.data && resp.data.data && resp.data.data.items) ||
          (resp && resp.data && resp.data.items) ||
          (resp && resp.items) ||
          [];
        var best = null;
        for (var i = 0; i < items.length; i++) {
          var it = items[i];
          if (!it || it.rvh_id == null) continue;
          if (String(it.details || "") !== String(details || "")) continue;
          if (best == null || Number(it.rvh_id) > Number(best)) best = it.rvh_id;
        }
        return best;
      })
      .catch(function () {
        return null;
      });
  }

  // v4 write: translate the v3-style requestRVH params (add_rvh/delete_rvh)
  // into the SPA's rvh.create / rvh.delete routes.
  function writeRvhV4(params, requestId) {
    var m = v4Match();
    var xsrf = readXsrfToken();
    if (!m) return post("MOS_AF_WRITE_RESULT", requestId, { ok: false, error: "not_v4_dvi" });
    if (!xsrf) return post("MOS_AF_WRITE_RESULT", requestId, { ok: false, error: "no_xsrf_token" });
    var shopNum = m[1];
    var statusId = String(params.status_id || m[2]);
    var reqType = String(params.request_type || "");

    if (reqType === "delete_rvh") {
      var rvhId = params.rvh_id != null ? String(params.rvh_id) : "";
      if (!rvhId) return post("MOS_AF_WRITE_RESULT", requestId, { ok: false, error: "no_rvh_id" });
      var delUrl = resolveZiggyRoute("rvh.delete", { shop_id: shopNum, id: rvhId });
      if (!delUrl)
        return post("MOS_AF_WRITE_RESULT", requestId, { ok: false, error: "rvh_route_unresolved_v4" });
      fetch(delUrl, {
        method: "DELETE",
        credentials: "same-origin",
        headers: v4RvhHeaders(xsrf),
      })
        .then(function (r) {
          if (!r.ok) throw new Error("http_" + r.status);
          post("MOS_AF_WRITE_RESULT", requestId, { ok: true, data: { success: 1 } });
        })
        .catch(function (e) {
          post("MOS_AF_WRITE_RESULT", requestId, {
            ok: false,
            error: String((e && e.message) || e),
          });
        });
      return;
    }

    if (reqType !== "add_rvh")
      return post("MOS_AF_WRITE_RESULT", requestId, { ok: false, error: "rvh_unsupported_v4" });

    var createUrl = resolveZiggyRoute("rvh.create", { shop_id: shopNum });
    if (!createUrl)
      return post("MOS_AF_WRITE_RESULT", requestId, { ok: false, error: "rvh_route_unresolved_v4" });
    var details = typeof params.details === "string" ? params.details : "";
    var body = {
      type: params.type != null && params.type !== "" ? Number(params.type) : 0,
      details: details,
      notes: typeof params.notes === "string" ? params.notes : "",
      status_id: Number(statusId),
    };
    fetch(createUrl, {
      method: "POST",
      credentials: "same-origin",
      headers: v4RvhHeaders(xsrf),
      body: JSON.stringify(body),
    })
      .then(function (r) {
        if (!r.ok) throw new Error("http_" + r.status);
        return r.json().catch(function () {
          return null;
        });
      })
      .then(function (resp) {
        var rvhId = findRvhId(resp, 0);
        if (rvhId != null) return { rvh_id: rvhId };
        // Body didn't carry the id — recover it from the list so undo works.
        return lookupRvhIdByDetails(shopNum, statusId, details, xsrf).then(function (found) {
          return { rvh_id: found };
        });
      })
      .then(function (data) {
        post("MOS_AF_WRITE_RESULT", requestId, { ok: true, data: data });
      })
      .catch(function (e) {
        post("MOS_AF_WRITE_RESULT", requestId, {
          ok: false,
          error: String((e && e.message) || e),
        });
      });
  }

  // ==================== v3 (legacy jQuery) support ====================

  // Flatten the DVI into a list of items the content script can match against
  // VHI maintenance data. Names come from the loaded sheet; per-item result
  // state (status / notes / results_id / tech_id) comes from `defaults.results`.
  function readDvi() {
    var d = getDefaults();
    if (!d) return { ok: false, error: "no_defaults" };
    var statusId =
      d.status_id || (d.loadedsheet && d.loadedsheet.status_id) || null;
    // sheet_id is sent by AutoFlow's own update_sheet payload (confirmed in
    // jquery.atme.notes.js: params["sheet_id"] = sheet_id). Surface it so the
    // content script can include it on writes.
    var sheetId =
      d.sheet_id || (d.loadedsheet && d.loadedsheet.sheet_id) || null;
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
        resultsId: r.results_id || "",
        techId: r.tech_id || "",
        notes: r.notes || "",
      });
    });
    return {
      ok: true,
      statusId: statusId ? String(statusId) : null,
      sheetId: sheetId ? String(sheetId) : null,
      items: items,
    };
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

  function expectedRvhAction(params) {
    var operation = String((params && (params.action || params.request)) || "write-rvh")
      .replace(/[^a-z0-9_-]/gi, "")
      .slice(0, 32);
    return "autoflow:" + (operation || "write-rvh");
  }

  async function consumeWriteGrant(authorization, expectedAction) {
    if (!authorization || !authorization.grant) return false;
    try {
      var response = await fetch(
        "https://mos.tools/api/extension/action-grant/consume",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            grant: authorization.grant,
            provider: "autoflow",
            action: expectedAction,
          }),
        }
      );
      var data = await response.json().catch(function () { return {}; });
      return response.ok && data && data.consumed === true;
    } catch (_) {
      return false;
    }
  }

  window.addEventListener("message", async function (e) {
    if (e.source !== window) return;
    var m = e.data;
    if (!m || typeof m !== "object" || !m.type) return;
    if (m.type === "MOS_AF_READ_DVI") {
      if (isV4Dvi()) {
        readDviV4().then(function (res) {
          post("MOS_AF_DVI_DATA", m.requestId, res);
        });
      } else {
        post("MOS_AF_DVI_DATA", m.requestId, readDvi());
      }
    } else if (m.type === "MOS_AF_WRITE_SHEET") {
      if (!(await consumeWriteGrant(m.authorization, "autoflow:write-dvi-sheet"))) {
        post("MOS_AF_WRITE_RESULT", m.requestId, { ok: false, error: "authorization_required" });
        return;
      }
      if (isV4Dvi()) {
        writeSheetV4(m.params || {}, m.requestId);
      } else {
        doRequest("request", m.params || {}, m.requestId);
      }
    } else if (m.type === "MOS_AF_WRITE_RVH") {
      if (!(await consumeWriteGrant(m.authorization, expectedRvhAction(m.params)))) {
        post("MOS_AF_WRITE_RESULT", m.requestId, { ok: false, error: "authorization_required" });
        return;
      }
      if (isV4Dvi()) {
        writeRvhV4(m.params || {}, m.requestId);
      } else {
        doRequest("requestRVH", m.params || {}, m.requestId);
      }
    }
  });

  post("MOS_AF_BRIDGE_READY", null, { ok: true });
  console.log("[MOS Tools] AutoFlow DVI bridge (MAIN world) ready");
})();
