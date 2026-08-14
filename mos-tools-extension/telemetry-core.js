// MOS Tools — pure telemetry helpers (Task #1112).
//
// Shared by the background worker, content scripts, and the side panel:
//   * per-signature throttling so a render-loop bug can't flood the
//     telemetry pipeline with thousands of identical client.error events;
//   * slow-call aggregation so a pathologically slow shop stays well
//     inside the server's 120/min per-shop rate limit (suppressed slow
//     calls are counted and folded into the next emitted event);
//   * privacy-safe error-message sanitizing (no URLs with query strings,
//     no emails, no long payload dumps, never a stack trace).
//
// Loaded three ways (same pattern as undo-core.js):
//   * content scripts via manifest.json — sets a global `MosTelemetryCore`;
//   * background.js (ES module) via a side-effect import;
//   * sidepanel.html via a plain <script> tag before sidepanel.js;
//   * tsx smoke tests via createRequire (module.exports guard below).
(function (root) {
  // Client-side slow-call threshold. The server enforces its own
  // (env-tunable) minimum and drops anything below it, so this only has
  // to be a sane default; it errs low rather than high.
  var SLOW_CALL_THRESHOLD_MS = 5000;

  // Strip anything that could carry page content or PII out of an error
  // message before it leaves the client. Best-effort and conservative:
  // query strings, emails, long digit runs, and anything beyond 200
  // chars are removed. NEVER returns a stack trace — callers must pass
  // `message` only.
  function sanitizeErrorMessage(msg) {
    try {
      var s = String(msg == null ? "" : msg);
      // First line only (some runtimes glue the stack onto message).
      s = s.split("\n")[0];
      // Drop query strings / fragments inside any embedded URL.
      s = s.replace(/([?#])[^\s"']*/g, "$1…");
      // Emails.
      s = s.replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, "[email]");
      // Long digit runs (phone numbers, RO ids, VIN-ish tails).
      s = s.replace(/\d{5,}/g, "[num]");
      s = s.trim();
      if (s.length > 200) s = s.slice(0, 200);
      return s || "unknown error";
    } catch (_) {
      return "unknown error";
    }
  }

  // Stable signature for throttling: surface + first 80 chars of the
  // sanitized message, lowercased with whitespace collapsed.
  function errorSignature(surface, message) {
    try {
      var m = sanitizeErrorMessage(message).toLowerCase().replace(/\s+/g, " ").slice(0, 80);
      return String(surface || "unknown") + "|" + m;
    } catch (_) {
      return String(surface || "unknown") + "|unknown";
    }
  }

  // Per-signature throttle with suppressed-count carry-over.
  //
  //   var t = createSignatureThrottle({ windowMs: 60000, maxPerWindow: 3 });
  //   var r = t.note("sig");   // -> { emit: true, suppressedSinceLastEmit: 0 }
  //
  // Within one window, the first `maxPerWindow` notes for a signature
  // emit; the rest are suppressed but counted. The next emitted note
  // reports how many were suppressed since the last emit, so aggregate
  // volume is preserved without flooding. Entries are pruned lazily and
  // the map is capped so a signature-churn bug can't grow memory.
  function createSignatureThrottle(opts) {
    var windowMs = (opts && opts.windowMs) || 60000;
    var maxPerWindow = (opts && opts.maxPerWindow) || 3;
    var maxSignatures = (opts && opts.maxSignatures) || 200;
    var buckets = Object.create(null);
    var size = 0;

    function note(sig, nowArg) {
      try {
        var now = typeof nowArg === "number" ? nowArg : Date.now();
        var key = String(sig || "unknown");
        var b = buckets[key];
        if (!b || now - b.windowStart >= windowMs) {
          if (!b) {
            if (size >= maxSignatures) {
              // Cheap reset — better to lose throttle memory than grow.
              buckets = Object.create(null);
              size = 0;
            }
            size += 1;
          }
          b = buckets[key] = { windowStart: now, emitted: 0, suppressed: b ? b.suppressed : 0 };
        }
        if (b.emitted < maxPerWindow) {
          b.emitted += 1;
          var suppressed = b.suppressed;
          b.suppressed = 0;
          return { emit: true, suppressedSinceLastEmit: suppressed };
        }
        b.suppressed += 1;
        return { emit: false, suppressedSinceLastEmit: 0 };
      } catch (_) {
        // Throttle failure must never block the caller; fail open.
        return { emit: true, suppressedSinceLastEmit: 0 };
      }
    }

    return { note: note };
  }

  // Install window-level error hooks (content scripts + side panel).
  //
  //   MosTelemetryCore.installErrorHooks({
  //     surface: "content",            // reported as payload.surface
  //     provider: "tekmetric",         // optional payload.provider
  //     requireExtensionOrigin: true,  // content scripts share the page's
  //                                    // window — only report errors whose
  //                                    // source is a chrome-extension:// file
  //     send: function (payload) { ... } // relay to background REPORT_TELEMETRY
  //   });
  //
  // Throttled per error signature (3 per 5 min) with suppressed counts
  // folded into the next emitted event. NEVER throws.
  function installErrorHooks(opts) {
    try {
      var target = (opts && opts.target) || (typeof window !== "undefined" ? window : null);
      if (!target || !opts || typeof opts.send !== "function") return;
      var surface = opts.surface || "unknown";
      var throttle = createSignatureThrottle({ windowMs: 5 * 60 * 1000, maxPerWindow: 3 });

      // Optional shop scope: `getScope()` returns the CURRENT shop
      // identifier at error time. It is baked into the throttle
      // signature, so when a persistent surface (the side panel) switches
      // shops, the new shop gets a fresh bucket — suppressed counts from
      // one shop can never fold into an event attributed to another.
      function currentScope() {
        try {
          if (typeof opts.getScope === "function") {
            var s = opts.getScope();
            return s == null ? null : String(s);
          }
        } catch (_) {}
        return null;
      }

      function report(rawMessage, sourceHint) {
        try {
          if (opts.requireExtensionOrigin) {
            var src = String(sourceHint || "");
            if (src.indexOf("chrome-extension://") === -1 && src.indexOf("moz-extension://") === -1) return;
          }
          var message = sanitizeErrorMessage(rawMessage);
          var scope = currentScope();
          var t = throttle.note((scope || "unknown") + "|" + errorSignature(surface, message));
          if (!t.emit) return;
          var payload = {
            surface: surface,
            message: message,
            count: 1 + (t.suppressedSinceLastEmit || 0),
          };
          if (opts.provider) payload.provider = opts.provider;
          if (scope) payload.smsShopId = scope;
          opts.send(payload);
        } catch (_) { /* never throw from telemetry */ }
      }

      target.addEventListener("error", function (e) {
        try {
          report(
            (e && (e.message || (e.error && e.error.message))) || "uncaught error",
            (e && e.filename) || (e && e.error && e.error.stack) || ""
          );
        } catch (_) {}
      });
      target.addEventListener("unhandledrejection", function (e) {
        try {
          var r = e && e.reason;
          report(
            (r && (r.message || String(r))) || "unhandled rejection",
            (r && r.stack) || ""
          );
        } catch (_) {}
      });
    } catch (_) { /* never throw from telemetry */ }
  }

  // Decide whether a THROWN MOS-fetch error (network failure, abort /
  // timeout, mid-retry crash) should emit an api.fetch_failure event,
  // and build its payload. Pure so it can be unit-tested; the caller
  // (background fetch proxy) emits inside its own try/catch so this can
  // never throw into the foreground path.
  //
  // Skips:
  //   * errors already reported at their throw site (marked
  //     `_mosTelemetryReported` — 401/503/!ok responses);
  //   * the telemetry endpoint itself (feedback loop).
  function buildThrownFetchFailure(endpoint, err, durationMs) {
    try {
      if (err && err._mosTelemetryReported) return { emit: false, payload: null };
      var ep = String(endpoint || "");
      if (ep.indexOf("/api/extension/telemetry") !== -1) return { emit: false, payload: null };
      return {
        emit: true,
        payload: {
          endpoint: ep || null,
          status: 0, // no HTTP response — thrown before/without one
          code: (err && err.code) || null,
          reason: sanitizeErrorMessage((err && err.message) || "fetch failed"),
          durationMs: typeof durationMs === "number" && durationMs >= 0 ? Math.round(durationMs) : null,
        },
      };
    } catch (_) {
      return { emit: false, payload: null };
    }
  }

  var api = {
    SLOW_CALL_THRESHOLD_MS: SLOW_CALL_THRESHOLD_MS,
    sanitizeErrorMessage: sanitizeErrorMessage,
    errorSignature: errorSignature,
    createSignatureThrottle: createSignatureThrottle,
    installErrorHooks: installErrorHooks,
    buildThrownFetchFailure: buildThrownFetchFailure,
  };

  root.MosTelemetryCore = api;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
