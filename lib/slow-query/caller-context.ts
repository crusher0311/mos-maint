/**
 * Slow-query caller attribution (task #1162).
 *
 * An AsyncLocalStorage store carries a caller tag (normalized route path or
 * explicit cron/job name) through the async call tree so the slow-query
 * tracker can record WHO ran a slow operation, not just which process.
 *
 * Design constraints:
 *   - Zero overhead when tracking is disabled: the HTTP hook checks the kill
 *     switch per request and falls straight through; `runWithSlowQueryCaller`
 *     skips the ALS `run` entirely.
 *   - Bundle-safe: no top-level node imports. `async_hooks`/`http` are loaded
 *     lazily via eval("require") (same pattern as src/instrumentation.ts) so
 *     this module can be pulled into any server bundle without webpack
 *     resolving Node-only deps at build time, and unit-tested under plain tsx.
 *   - Low cardinality: dynamic path segments (numeric ids, Mongo ObjectIds,
 *     UUIDs, VINs) are collapsed to placeholders so the dashboard groups by
 *     route, not by record id.
 *
 * Entry points that set the tag:
 *   - `installSlowQueryCallerTagging()` — called once from
 *     src/instrumentation.ts; patches http.Server.prototype.emit so EVERY
 *     inbound request (web API routes AND the cron scheduler's internal
 *     `/api/cron/*` invocations — cron jobs run via HTTP) executes inside an
 *     ALS context tagged with its normalized path.
 *   - `runWithSlowQueryCaller(tag, fn)` — explicit wrapper for non-HTTP
 *     entry points (queue processors, scripts) that want attribution.
 */
import { slowQueryTrackingEnabled } from "./core";

type Als = {
  getStore: () => string | undefined;
  run: <T>(store: string, fn: () => T) => T;
};

let als: Als | null = null;
let alsInitTried = false;

function getAls(): Als | null {
  if (!alsInitTried) {
    alsInitTried = true;
    try {
      const nodeRequire = eval("require") as NodeRequire;
      const { AsyncLocalStorage } = nodeRequire("async_hooks");
      als = new AsyncLocalStorage();
    } catch {
      als = null; // non-Node runtime — attribution silently unavailable
    }
  }
  return als;
}

/** Current caller tag, or null when outside any tagged context. */
export function getSlowQueryCaller(): string | null {
  const a = getAls();
  if (!a) return null;
  const v = a.getStore();
  return typeof v === "string" && v ? v : null;
}

/**
 * Run `fn` with an explicit caller tag (cron/job/script name). When tracking
 * is disabled or ALS is unavailable this is a plain call — no ALS frame is
 * created, so the disabled hot path costs one env read.
 */
export function runWithSlowQueryCaller<T>(caller: string, fn: () => T): T {
  const a = getAls();
  if (!a || !slowQueryTrackingEnabled()) return fn();
  const tag = String(caller || "").slice(0, 200);
  if (!tag) return fn();
  return a.run(tag, fn);
}

// ---------------------------------------------------------------------------
// Path normalization — match against the App Router's real route templates.
//
// Security invariant: a request path VALUE is never persisted. The stored
// tag is built exclusively from route-template literals and `:param`
// placeholders. Any segment that binds a dynamic template param — or any
// path that matches no known template — is fully redacted, so route-embedded
// secrets (enrollment codes in /api/join/[code], webhook tokens in
// /api/webhooks/*/[token], VINs, ids) can never reach the slow_queries table
// or the platform-admin dashboard.
// ---------------------------------------------------------------------------

type TemplateSeg =
  | { kind: "literal"; value: string }
  | { kind: "dynamic"; name: string }
  | { kind: "catchall"; name: string };

interface RouteTemplate {
  segs: TemplateSeg[];
  literalCount: number;
  hasCatchAll: boolean;
}

let templatesCache: RouteTemplate[] | null = null;
let templatesTried = false;

/** Walk the app/ directory for route/page entry files → URL templates. */
function loadRouteTemplates(): RouteTemplate[] {
  if (templatesTried) return templatesCache || [];
  templatesTried = true;
  try {
    const nodeRequire = eval("require") as NodeRequire;
    const fs = nodeRequire("fs") as typeof import("fs");
    const nodePath = nodeRequire("path") as typeof import("path");
    const appDir = nodePath.join(process.cwd(), "app");
    if (!fs.existsSync(appDir)) return (templatesCache = []);
    const out: RouteTemplate[] = [];
    const ENTRY_RE = /^(route|page)\.(ts|tsx|js|jsx|mjs)$/;
    const walk = (dir: string, segs: TemplateSeg[]) => {
      let entries: import("fs").Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      let isEndpoint = false;
      for (const e of entries) {
        if (e.isFile() && ENTRY_RE.test(e.name)) isEndpoint = true;
      }
      if (isEndpoint) {
        out.push({
          segs,
          literalCount: segs.filter((s) => s.kind === "literal").length,
          hasCatchAll: segs.some((s) => s.kind === "catchall"),
        });
      }
      for (const e of entries) {
        if (!e.isDirectory()) continue;
        const name = e.name;
        if (name.startsWith("_")) continue; // private folders
        if (name.startsWith("(") && name.endsWith(")")) {
          walk(nodePath.join(dir, name), segs); // route group — no URL segment
          continue;
        }
        if (name.startsWith("@")) {
          walk(nodePath.join(dir, name), segs); // parallel slot — no URL segment
          continue;
        }
        let seg: TemplateSeg;
        const catchAll = /^\[\[?\.\.\.(.+?)\]?\]$/.exec(name);
        const dynamic = /^\[(.+)\]$/.exec(name);
        if (catchAll) {
          seg = { kind: "catchall", name: catchAll[1] };
          // Optional catch-all [[...x]] also matches the bare parent path.
          if (name.startsWith("[[")) {
            out.push({
              segs,
              literalCount: segs.filter((s) => s.kind === "literal").length,
              hasCatchAll: false,
            });
          }
        } else if (dynamic) {
          seg = { kind: "dynamic", name: dynamic[1] };
        } else {
          seg = { kind: "literal", value: name };
        }
        walk(nodePath.join(dir, name), [...segs, seg]);
      }
    };
    walk(appDir, []);
    // Most-specific first: more literals wins, catch-alls last.
    out.sort(
      (a, b) =>
        Number(a.hasCatchAll) - Number(b.hasCatchAll) ||
        b.literalCount - a.literalCount,
    );
    templatesCache = out;
    return out;
  } catch {
    return (templatesCache = []);
  }
}

/** Test seam: force template reload (e.g. after chdir in tests). */
export function __resetRouteTemplates(): void {
  templatesCache = null;
  templatesTried = false;
}

function matchTemplate(segments: string[], tpl: RouteTemplate): string | null {
  const n = tpl.segs.length;
  if (tpl.hasCatchAll ? segments.length < n : segments.length !== n) return null;
  const outSegs: string[] = [];
  for (let i = 0; i < n; i++) {
    const t = tpl.segs[i];
    if (t.kind === "literal") {
      if (segments[i] !== t.value) return null;
      outSegs.push(t.value);
    } else if (t.kind === "dynamic") {
      outSegs.push(`:${t.name}`);
    } else {
      outSegs.push(`:${t.name}*`); // catch-all consumes the remainder
      break;
    }
  }
  return "/" + outSegs.join("/");
}

/**
 * Normalize a request URL to a low-cardinality, value-free caller tag by
 * matching it against the App Router's route templates. Unmatched paths are
 * fully redacted to "/…" (never stored verbatim) — a tag is only as specific
 * as the route template that produced it.
 */
export function normalizeCallerPath(url: string | undefined | null): string | null {
  if (!url || typeof url !== "string") return null;
  let path = url;
  const q = path.indexOf("?");
  if (q !== -1) path = path.slice(0, q);
  const h = path.indexOf("#");
  if (h !== -1) path = path.slice(0, h);
  if (!path.startsWith("/")) {
    // Absolute-form URL (proxies) — extract the pathname.
    const m = /^[a-z][a-z0-9+.-]*:\/\/[^/]+(\/[^?#]*)?/i.exec(path);
    if (!m) return null;
    path = m[1] || "/";
  }
  const segments = path.split("/").filter(Boolean);
  if (segments.length === 0) return "/";
  for (const tpl of loadRouteTemplates()) {
    const matched = matchTemplate(segments, tpl);
    if (matched) return matched.length > 200 ? matched.slice(0, 200) : matched;
  }
  // No template matched (static assets, _next internals, 404 probes, or the
  // app dir is unavailable at runtime): redact the entire path rather than
  // risk persisting a value.
  return "/…";
}

// ---------------------------------------------------------------------------
// HTTP request tagging — one prototype patch covers every route handler.
// ---------------------------------------------------------------------------

const INSTALLED_FLAG = Symbol.for("mos.slowQueryCallerTagging");

/**
 * Patch http.Server.prototype.emit so 'request' events run inside an ALS
 * context tagged with the normalized request path. Installed once from
 * src/instrumentation.ts (Node runtime only). Next.js serves both dev and
 * standalone prod through node's http server, and emit is looked up on the
 * prototype at call time, so servers created before install are covered too.
 *
 * Returns true when the patch is (already) installed.
 */
export function installSlowQueryCallerTagging(): boolean {
  const a = getAls();
  if (!a) return false;
  try {
    const nodeRequire = eval("require") as NodeRequire;
    const http = nodeRequire("http") as typeof import("http");
    const proto = http.Server.prototype as any;
    if (proto[INSTALLED_FLAG]) return true;
    const origEmit = proto.emit;
    proto.emit = function patchedEmit(this: any, event: string, ...args: any[]) {
      if (event === "request" && slowQueryTrackingEnabled()) {
        try {
          const tag = normalizeCallerPath(args[0]?.url);
          if (tag) {
            return a.run(tag, () => origEmit.call(this, event, ...args));
          }
        } catch {
          /* never break request handling */
        }
      }
      return origEmit.call(this, event, ...args);
    };
    proto[INSTALLED_FLAG] = true;
    return true;
  } catch {
    return false;
  }
}
