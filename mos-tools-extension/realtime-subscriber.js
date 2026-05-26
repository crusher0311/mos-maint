// Task #484: Supabase Realtime subscriber for the Detect Dog VHI overlay.
//
// Plain WebSocket implementation of the Phoenix Channels protocol that
// Supabase Realtime uses. Bundling @supabase/supabase-js into a content
// script is heavy and conflicts with MV3's CSP, so we speak the protocol
// directly. This file intentionally has no dependencies and exposes
// MosVhiRealtime as a global on the content script's window.
//
// Lifecycle:
//   MosVhiRealtime.subscribe({ supabaseUrl, supabaseAnonKey, token, topic,
//                              onMessage, onStatus })
//     → returns a `handle` with `.close()` and `.isOpen()`.
//
// Caller (vhi-coach.js) opens one subscription when the overlay mounts
// and closes it on overlay hide / VIN change. Reconnect is automatic
// with capped exponential backoff; on irrecoverable failure the caller's
// existing polling cadence handles staleness.

(function (root) {
  const HEARTBEAT_MS = 25_000;
  const BACKOFF_BASE_MS = 1_000;
  const BACKOFF_MAX_MS = 30_000;
  // Task #484: bound the reconnect loop so a permanent failure (bad
  // anon key, RLS deny, Supabase project down) eventually disables the
  // realtime path. The overlay's existing polling keeps working — we
  // just stop burning CPU trying to reopen a channel that won't open.
  const MAX_RECONNECT_ATTEMPTS = 6;
  // Coalesce inbound broadcast bursts so a webhook + backfill + plan
  // invalidate landing on the same VIN within a few hundred ms only
  // triggers one re-fetch instead of three.
  const INBOUND_COALESCE_MS = 300;

  function makeHandle(opts) {
    const {
      supabaseUrl,
      supabaseAnonKey,
      token,
      topic,
      onMessage,
      onStatus,
    } = opts;

    if (!supabaseUrl || !supabaseAnonKey || !token || !topic) {
      throw new Error("MosVhiRealtime.subscribe missing required option");
    }

    const wsBase = supabaseUrl.replace(/^http/, "ws").replace(/\/$/, "");
    // `vsn=1.0.0` matches the Phoenix v1 protocol that Supabase realtime
    // server speaks; the apikey query param is required for the WS upgrade.
    const wsUrl = `${wsBase}/realtime/v1/websocket?apikey=${encodeURIComponent(
      supabaseAnonKey
    )}&vsn=1.0.0`;
    const channelTopic = `realtime:${topic}`;

    let ws = null;
    let closedByUser = false;
    let gaveUp = false;
    let joined = false;
    let heartbeatTimer = null;
    let reconnectTimer = null;
    let coalesceTimer = null;
    let lastCoalescedMsg = null;
    let attempt = 0;
    let refCounter = 1;
    let currentToken = token;
    let tokenRefreshUsed = false;

    function nextRef() {
      return String(refCounter++);
    }

    function emitStatus(s, detail) {
      if (typeof onStatus === "function") {
        try {
          onStatus(s, detail);
        } catch (_) {}
      }
    }

    function clearTimers() {
      if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
      }
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      if (coalesceTimer) {
        clearTimeout(coalesceTimer);
        coalesceTimer = null;
        lastCoalescedMsg = null;
      }
    }

    function scheduleReconnect() {
      if (closedByUser || gaveUp) return;
      if (attempt >= MAX_RECONNECT_ATTEMPTS) {
        gaveUp = true;
        emitStatus("gave_up", { attempts: attempt });
        return;
      }
      const delay = Math.min(
        BACKOFF_MAX_MS,
        BACKOFF_BASE_MS * Math.pow(2, Math.min(attempt, 6))
      );
      attempt += 1;
      emitStatus("reconnecting", { delayMs: delay, attempt });
      reconnectTimer = setTimeout(connect, delay);
    }

    function maybeRefreshToken() {
      if (tokenRefreshUsed) return false;
      if (typeof opts.refreshToken !== "function") return false;
      tokenRefreshUsed = true;
      Promise.resolve()
        .then(opts.refreshToken)
        .then(function (next) {
          if (!next || typeof next !== "string") return;
          currentToken = next;
          attempt = 0; // reset backoff after a fresh token
          if (ws) {
            try { ws.close(); } catch (_) {}
          }
          // 'close' handler will scheduleReconnect with the new token
        })
        .catch(function () {});
      return true;
    }

    function send(payload) {
      if (!ws || ws.readyState !== 1) return false;
      try {
        ws.send(JSON.stringify(payload));
        return true;
      } catch (_) {
        return false;
      }
    }

    function joinChannel() {
      joined = false;
      send({
        topic: channelTopic,
        event: "phx_join",
        // `access_token` here is what RLS sees as `auth.jwt()`.
        payload: {
          config: {
            broadcast: { self: false, ack: false },
            presence: { key: "" },
          },
          access_token: currentToken,
        },
        ref: nextRef(),
      });
    }

    function startHeartbeat() {
      clearInterval(heartbeatTimer);
      heartbeatTimer = setInterval(() => {
        send({
          topic: "phoenix",
          event: "heartbeat",
          payload: {},
          ref: nextRef(),
        });
      }, HEARTBEAT_MS);
    }

    function connect() {
      clearTimers();
      try {
        ws = new WebSocket(wsUrl);
      } catch (err) {
        emitStatus("error", { message: err && err.message });
        scheduleReconnect();
        return;
      }

      ws.addEventListener("open", () => {
        attempt = 0;
        emitStatus("open");
        joinChannel();
        startHeartbeat();
      });

      ws.addEventListener("message", (evt) => {
        let msg = null;
        try {
          msg = JSON.parse(evt.data);
        } catch (_) {
          return;
        }
        if (!msg || msg.topic !== channelTopic) return;

        if (msg.event === "phx_reply") {
          const status = msg.payload && msg.payload.status;
          if (!joined && status === "ok") {
            joined = true;
            emitStatus("joined");
          } else if (status === "error") {
            emitStatus("join_error", msg.payload);
            // Auth-shaped errors get one shot at a token refresh; everything
            // else falls through to normal reconnect/give-up logic.
            const reason = String(
              (msg.payload && (msg.payload.reason || msg.payload.response)) || ""
            ).toLowerCase();
            if (
              /token|jwt|expired|unauthor|access denied/.test(reason) &&
              maybeRefreshToken()
            ) {
              return;
            }
          }
          return;
        }

        if (msg.event === "broadcast") {
          const evtName =
            (msg.payload && msg.payload.event) || "vhi.updated";
          const data = msg.payload && msg.payload.payload;
          // Coalesce a burst of broadcasts into one delivered message.
          lastCoalescedMsg = { event: evtName, payload: data };
          if (coalesceTimer) return;
          coalesceTimer = setTimeout(function () {
            const out = lastCoalescedMsg;
            lastCoalescedMsg = null;
            coalesceTimer = null;
            if (typeof onMessage === "function" && out) {
              try { onMessage(out); } catch (_) {}
            }
          }, INBOUND_COALESCE_MS);
        }
      });

      ws.addEventListener("close", () => {
        clearTimers();
        emitStatus("closed");
        if (!closedByUser) scheduleReconnect();
      });

      ws.addEventListener("error", (err) => {
        emitStatus("error", { message: err && err.message });
        // 'close' will follow; reconnect there.
      });
    }

    connect();

    return {
      isOpen: function () {
        return joined && ws && ws.readyState === 1;
      },
      close: function () {
        closedByUser = true;
        clearTimers();
        if (ws) {
          try {
            send({
              topic: channelTopic,
              event: "phx_leave",
              payload: {},
              ref: nextRef(),
            });
          } catch (_) {}
          try {
            ws.close();
          } catch (_) {}
          ws = null;
        }
      },
    };
  }

  root.MosVhiRealtime = {
    subscribe: function (opts) {
      return makeHandle(opts);
    },
  };
})(typeof window !== "undefined" ? window : globalThis);
