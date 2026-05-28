/**
 * Smoke test for the per-shop error-rate alerting marker (task #510).
 *
 * Locks in the JSON contract that Better Stack rules depend on:
 *   - Leading `[ShopErrorRate] ` token (substring match)
 *   - `group`, `shopId`, `status`, `code`, `path`, `method`, `message`,
 *     `ts` fields all present (group-by + threshold rules read these)
 *   - `SHOP_ERROR_MARKER_DISABLED=true` short-circuits (so it's never
 *     accidentally a hard dependency of a real code path)
 */

import { emitShopErrorEvent } from "../lib/alerts/shop-error-marker";

type Captured = { level: "error"; line: string };

function captureConsole(): { logs: Captured[]; restore: () => void } {
  const logs: Captured[] = [];
  const origErr = console.error;
  console.error = (...args: any[]) => {
    logs.push({ level: "error", line: args.map(String).join(" ") });
  };
  return {
    logs,
    restore: () => {
      console.error = origErr;
    },
  };
}

function assert(cond: any, msg: string) {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}

function parseMarker(line: string): any {
  const prefix = "[ShopErrorRate] ";
  assert(line.startsWith(prefix), `line missing prefix: ${line}`);
  return JSON.parse(line.slice(prefix.length));
}

(async () => {
  // 1) Basic emit with all fields populated.
  {
    const cap = captureConsole();
    try {
      emitShopErrorEvent({
        group: "EXT_AUTH_401",
        shopId: 112,
        status: 401,
        code: "TOKEN_INVALID",
        path: "/api/extension/plan",
        method: "GET",
        message: "Token not found in DB",
      });
    } finally {
      cap.restore();
    }
    assert(cap.logs.length === 1, "expected exactly one log line");
    const evt = parseMarker(cap.logs[0].line);
    assert(evt.group === "EXT_AUTH_401", "group preserved");
    assert(evt.shopId === 112, "shopId numeric");
    assert(evt.status === 401, "status preserved");
    assert(evt.code === "TOKEN_INVALID", "code preserved");
    assert(evt.path === "/api/extension/plan", "path preserved");
    assert(evt.method === "GET", "method preserved");
    assert(typeof evt.message === "string", "message string");
    assert(typeof evt.ts === "string", "ts present");
  }

  // 2) shopId=null is acceptable (degrades grouping but must not crash).
  {
    const cap = captureConsole();
    try {
      emitShopErrorEvent({
        group: "EXT_5XX",
        shopId: null,
        status: 503,
        code: "AUTH_LOOKUP_FAILED",
      });
    } finally {
      cap.restore();
    }
    const evt = parseMarker(cap.logs[0].line);
    assert(evt.shopId === null, "shopId null preserved");
    assert(evt.group === "EXT_5XX", "group preserved");
  }

  // 3) Kill switch silences the emit entirely.
  {
    const prev = process.env.SHOP_ERROR_MARKER_DISABLED;
    process.env.SHOP_ERROR_MARKER_DISABLED = "true";
    const cap = captureConsole();
    try {
      emitShopErrorEvent({
        group: "PLAN_BUILD_5XX",
        shopId: 1,
        status: 500,
      });
    } finally {
      cap.restore();
      if (prev === undefined) delete process.env.SHOP_ERROR_MARKER_DISABLED;
      else process.env.SHOP_ERROR_MARKER_DISABLED = prev;
    }
    assert(cap.logs.length === 0, "kill switch silences emit");
  }

  // 4) Long messages are truncated (Better Stack rule queries don't
  //    want multi-KB payloads — keep the marker bounded).
  {
    const cap = captureConsole();
    try {
      emitShopErrorEvent({
        group: "AUTOFLOW_WRITE_FAIL",
        shopId: 7,
        message: "x".repeat(2000),
      });
    } finally {
      cap.restore();
    }
    const evt = parseMarker(cap.logs[0].line);
    assert(typeof evt.message === "string" && evt.message.length <= 500, "message capped at 500 chars");
  }

  // 5) `extra` fields are merged onto the payload (e.g. RO id context).
  {
    const cap = captureConsole();
    try {
      emitShopErrorEvent({
        group: "SHOPWARE_WRITE_FAIL",
        shopId: 42,
        extra: { roId: "abc-123", retry: 2 },
      });
    } finally {
      cap.restore();
    }
    const evt = parseMarker(cap.logs[0].line);
    assert(evt.roId === "abc-123", "extra.roId merged");
    assert(evt.retry === 2, "extra.retry merged");
  }

  console.log("OK shop-error-marker.smoke");
})().catch((err) => {
  console.error("FAIL shop-error-marker.smoke:", err);
  process.exit(1);
});
