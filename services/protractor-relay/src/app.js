import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { mkdirSync, openSync, readFileSync, renameSync, writeFileSync, closeSync, fsyncSync, existsSync, statSync } from "node:fs";
import { dirname } from "node:path";
import http from "node:http";
import https from "node:https";

const REQUEST_PATH = "/relay";
const ALLOWED_FIELDS = new Set([
  "type", "method", "path", "headers", "body", "bodyEncoding", "deadlineAtMs"
]);
const REST_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);
const HOP_BY_HOP = new Set([
  "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
  "te", "trailer", "transfer-encoding", "upgrade", "host", "content-length"
]);
const RELAY_HEADERS = new Set([
  "x-relay-timestamp", "x-relay-nonce", "x-relay-request-id", "x-relay-signature"
]);
const TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const REQUEST_ID = /^[A-Za-z0-9._:-]{8,128}$/;
const NONCE = /^[A-Za-z0-9_-]{16,128}$/;

class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const sha256 = value => createHash("sha256").update(value).digest("hex");
const json = (res, status, value, extra = {}) => {
  const body = Buffer.from(JSON.stringify(value));
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": body.length,
    "cache-control": "no-store",
    ...extra
  });
  res.end(body);
};

function log(level, event, fields = {}) {
  process.stdout.write(`${JSON.stringify({
    timestamp: new Date().toISOString(), level, event, ...fields
  })}\n`);
}

function createReplayStore(config) {
  const file = config.replayJournalPath || "/tmp/protractor-relay-replay.journal";
  const maxBytes = config.replayJournalMaxBytes || 10_485_760;
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const entries = new Map();
  const now = Date.now();
  if (existsSync(file)) {
    for (const line of readFileSync(file, "utf8").split("\n")) {
      try {
        const item = JSON.parse(line);
        if (typeof item.key === "string" && Number.isFinite(item.expires) && item.expires > now) {
          entries.set(item.key, item.expires);
        }
      } catch {
        // A torn final line is harmless; valid reservations remain protected.
      }
    }
  }
  const prune = current => {
    for (const [key, expires] of entries) if (expires <= current) entries.delete(key);
  };
  const compact = () => {
    const temporary = `${file}.tmp`;
    const content = [...entries].map(([key, expires]) => JSON.stringify({ key, expires })).join("\n") +
      (entries.size ? "\n" : "");
    writeFileSync(temporary, content, { mode: 0o600 });
    const fd = openSync(temporary, "r");
    try { fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(temporary, file);
    const directoryFd = openSync(dirname(file), "r");
    try { fsyncSync(directoryFd); } finally { closeSync(directoryFd); }
  };
  prune(now);
  compact();
  if (statSync(file).size > maxBytes) throw new Error("Replay journal exceeds configured maximum");
  let journalBytes = statSync(file).size;
  return {
    has(key, current) {
      prune(current);
      return entries.has(key);
    },
    reserve(keys, expires, current) {
      prune(current);
      if (keys.some(key => entries.has(key))) return false;
      if (entries.size + keys.length > config.replayMaxEntries) return { full: true };
      const line = keys.map(key => JSON.stringify({ key, expires })).join("\n") + "\n";
      if (journalBytes + Buffer.byteLength(line) > maxBytes) {
        compact();
        journalBytes = statSync(file).size;
        if (journalBytes + Buffer.byteLength(line) > maxBytes) return { full: true };
      }
      const fd = openSync(file, "a", 0o600);
      try { writeFileSync(fd, line); fsyncSync(fd); } finally { closeSync(fd); }
      const directoryFd = openSync(dirname(file), "r");
      try { fsyncSync(directoryFd); } finally { closeSync(directoryFd); }
      journalBytes += Buffer.byteLength(line);
      for (const key of keys) entries.set(key, expires);
      if (journalBytes >= maxBytes / 2) {
        compact();
        journalBytes = statSync(file).size;
      }
      return true;
    },
    compact
  };
}

function readLimited(stream, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let length = 0;
    let exceeded = false;
    stream.on("data", chunk => {
      if (exceeded) return;
      length += chunk.length;
      if (length > limit) {
        exceeded = true;
        reject(new HttpError(413, "request_too_large", "Request body exceeds limit"));
        stream.destroy();
        return;
      }
      chunks.push(chunk);
    });
    stream.on("end", () => {
      if (!exceeded) resolve(Buffer.concat(chunks));
    });
    stream.on("error", reject);
  });
}

function abortableDelay(ms, signal) {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(done, ms);
    const abort = () => {
      clearTimeout(timer);
      reject(new HttpError(499, "caller_disconnected", "Caller disconnected"));
    };
    function done() {
      if (signal) signal.removeEventListener("abort", abort);
      resolve();
    }
    if (signal) {
      if (signal.aborted) return abort();
      signal.addEventListener("abort", abort, { once: true });
    }
  });
}

/**
 * Authoritative physical-send pacer. The relay is the final process that can
 * create a Protractor socket, so it serializes upstream work here and waits
 * for a full cooldown after each completed/failed physical attempt.
 */
function createUpstreamPacer(config, now) {
  const minimumIntervalMs = config.upstreamMinIntervalMs ?? 1000;
  let tail = Promise.resolve();
  // A replacement process has no proof of the prior process's last dispatch.
  // Start with one full cooldown so a stop-then-start deployment cannot burst
  // across the process boundary.
  let nextAllowedAt = now() + minimumIntervalMs;
  return async function pace(payload, signal, send) {
    let releaseTurn;
    const previous = tail;
    tail = new Promise(resolve => { releaseTurn = resolve; });
    await previous;
    let physicalAttemptStarted = false;
    try {
      if (signal?.aborted) {
        throw new HttpError(499, "caller_disconnected", "Caller disconnected");
      }
      const waitMs = Math.max(0, nextAllowedAt - now());
      if (now() + waitMs >= payload.deadlineAtMs) {
        throw new HttpError(504, "caller_deadline_expired", "Caller deadline expired before upstream dispatch");
      }
      await abortableDelay(waitMs, signal);
      if (signal?.aborted) {
        throw new HttpError(499, "caller_disconnected", "Caller disconnected");
      }
      if (now() >= payload.deadlineAtMs) {
        throw new HttpError(504, "caller_deadline_expired", "Caller deadline expired before upstream dispatch");
      }
      physicalAttemptStarted = true;
      return await send();
    } finally {
      if (physicalAttemptStarted) {
        nextAllowedAt = now() + minimumIntervalMs;
      }
      releaseTurn();
    }
  };
}

function authenticate(req, rawBody, config, replayCache, now) {
  const timestamp = req.headers["x-relay-timestamp"];
  const nonce = req.headers["x-relay-nonce"];
  const requestId = req.headers["x-relay-request-id"];
  const supplied = req.headers["x-relay-signature"];
  if (typeof timestamp !== "string" || !/^\d{10}$/.test(timestamp) ||
      typeof nonce !== "string" || !NONCE.test(nonce) ||
      typeof requestId !== "string" || !REQUEST_ID.test(requestId) ||
      typeof supplied !== "string") {
    throw new HttpError(401, "invalid_auth", "Invalid authentication");
  }

  const ageMs = Math.abs(now() - Number(timestamp) * 1000);
  if (!Number.isFinite(ageMs) || ageMs > config.clockSkewSeconds * 1000) {
    throw new HttpError(401, "stale_request", "Request timestamp is outside the allowed window");
  }

  const canonical = [
    timestamp, nonce, requestId, "POST", REQUEST_PATH, sha256(rawBody)
  ].join("\n");
  const expected = createHmac("sha256", config.secret).update(canonical).digest();
  const match = /^sha256=([a-fA-F0-9]{64})$/.exec(supplied);
  const received = match ? Buffer.from(match[1], "hex") : Buffer.alloc(32);
  if (!timingSafeEqual(expected, received) || !match) {
    throw new HttpError(401, "invalid_auth", "Invalid authentication");
  }

  const replayKeys = [sha256(`request-id\0${requestId}`), sha256(`nonce\0${nonce}`)];
  const current = now();
  if (replayKeys.some(key => replayCache.has(key, current))) {
    throw new HttpError(409, "replayed_request", "Request has already been accepted");
  }
  const expires = Math.max(
    current + config.replayTtlSeconds * 1000,
    Number(timestamp) * 1000 + config.clockSkewSeconds * 1000
  );
  return { requestId, replayKeys, expires };
}

function duplicateHeaderKey(raw) {
  const marker = /"headers"\s*:\s*\{/.exec(raw);
  if (!marker) return false;
  let start = marker.index + marker[0].length - 1;
  let depth = 0;
  let quoted = false;
  let escaped = false;
  let end = -1;
  for (let i = start; i < raw.length; i++) {
    const c = raw[i];
    if (quoted) {
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') quoted = false;
    } else if (c === '"') quoted = true;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) { end = i; break; }
  }
  if (end < 0) return false;
  const seen = new Set();
  const section = raw.slice(start, end + 1);
  for (let i = 1; i < section.length - 1;) {
    while (/\s/.test(section[i])) i++;
    let previous = i - 1;
    while (previous > 0 && /\s/.test(section[previous])) previous--;
    if (section[i] !== '"' || (section[previous] !== "{" && section[previous] !== ",")) {
      i++;
      continue;
    }
    const begin = ++i;
    let escapedKey = false;
    while (i < section.length) {
      if (escapedKey) escapedKey = false;
      else if (section[i] === "\\") escapedKey = true;
      else if (section[i] === '"') break;
      i++;
    }
    const key = JSON.parse(`"${section.slice(begin, i)}"`).toLowerCase();
    i++;
    while (/\s/.test(section[i])) i++;
    if (section[i] !== ":") continue;
    if (seen.has(key)) return true;
    seen.add(key);
  }
  return false;
}

function parsePayload(raw) {
  if (duplicateHeaderKey(raw.toString("utf8"))) {
    throw new HttpError(400, "invalid_headers", "Duplicate header names are not allowed");
  }
  let value;
  try {
    value = JSON.parse(raw.toString("utf8"));
  } catch {
    throw new HttpError(400, "invalid_json", "Body must be valid JSON");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HttpError(400, "invalid_request", "Body must be an object");
  }
  for (const key of Object.keys(value)) {
    if (!ALLOWED_FIELDS.has(key)) {
      throw new HttpError(400, "invalid_request", `Unknown field: ${key}`);
    }
  }
  if (value.type !== "rest" && value.type !== "soap") {
    throw new HttpError(400, "invalid_type", "type must be rest or soap");
  }
  if (typeof value.method !== "string") {
    throw new HttpError(400, "invalid_method", "method is required");
  }
  const method = value.method.toUpperCase();
  if (value.method !== method || (value.type === "soap" ? method !== "POST" : !REST_METHODS.has(method))) {
    throw new HttpError(400, "invalid_method", "Method is not allowed for this request type");
  }
  if (typeof value.path !== "string" || value.path.length > 4096 ||
      /[\u0000-\u0020\u007f\\]/.test(value.path) || value.path.includes("#")) {
    throw new HttpError(400, "invalid_path", "Invalid IntegrationServices path");
  }
  const queryStart = value.path.indexOf("?");
  const pathname = queryStart < 0 ? value.path : value.path.slice(0, queryStart);
  const versionMatch = /^\/IntegrationServices\/(1\.0|2\.0)(?:\/|$)/.exec(pathname);
  let decodedPath = pathname;
  for (let iteration = 0; iteration < 5; iteration++) {
    let next;
    try { next = decodeURIComponent(decodedPath); } catch {
      throw new HttpError(400, "invalid_path", "Invalid percent encoding in path");
    }
    if (next === decodedPath) break;
    decodedPath = next;
    if (/(^|\/)\.{1,2}(?:\/|$)/.test(decodedPath) ||
        /(?:^|\/)[^/]*\\[^/]*(?:\/|$)/.test(decodedPath) ||
        /%2f|%5c/i.test(decodedPath)) {
      throw new HttpError(400, "invalid_path", "Encoded traversal is not allowed");
    }
  }
  if (!value.path.startsWith("/") || !versionMatch ||
      pathname.includes("//") || /%2f|%5c|(?:^|\/)\.{1,2}(?:\/|$)/i.test(pathname) ||
      value.path.includes("#")) {
    throw new HttpError(400, "invalid_path", "Only IntegrationServices 1.0/2.0 paths are allowed");
  }
  if (value.headers !== undefined &&
      (!value.headers || typeof value.headers !== "object" || Array.isArray(value.headers))) {
    throw new HttpError(400, "invalid_headers", "headers must be an object");
  }
  if (value.body !== undefined && typeof value.body !== "string") {
    throw new HttpError(400, "invalid_body", "body must be a string");
  }
  if (value.bodyEncoding !== undefined && !["utf8", "base64"].includes(value.bodyEncoding)) {
    throw new HttpError(400, "invalid_body_encoding", "bodyEncoding must be utf8 or base64");
  }
  if (!Number.isSafeInteger(value.deadlineAtMs) || value.deadlineAtMs <= 0) {
    throw new HttpError(400, "invalid_deadline", "deadlineAtMs must be a positive integer");
  }
  return { ...value, method, target: value.path, apiVersion: versionMatch[1] };
}

function decodeBody(payload, limit) {
  if (payload.body === undefined) return Buffer.alloc(0);
  let body;
  if (payload.bodyEncoding === "base64") {
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(payload.body)) {
      throw new HttpError(400, "invalid_body", "body is not valid canonical base64");
    }
    body = Buffer.from(payload.body, "base64");
  } else {
    body = Buffer.from(payload.body, "utf8");
  }
  if (body.length > limit) throw new HttpError(413, "upstream_body_too_large", "Upstream body exceeds limit");
  return body;
}

function outboundHeaders(input = {}, body) {
  const result = {};
  const connectionTokens = new Set();
  const connection = Object.entries(input).find(([key]) => key.toLowerCase() === "connection");
  if (connection && typeof connection[1] === "string") {
    for (const token of connection[1].split(",")) connectionTokens.add(token.trim().toLowerCase());
  }
  for (const [name, value] of Object.entries(input)) {
    const lower = name.toLowerCase();
    if (lower === "connection" || lower === "transfer-encoding" || connectionTokens.has(lower)) {
      throw new HttpError(400, "invalid_headers", "Connection and Transfer-Encoding are not permitted");
    }
    if (!TOKEN.test(name) || HOP_BY_HOP.has(lower) || RELAY_HEADERS.has(lower)) continue;
    if (typeof value !== "string" || /[\r\n]/.test(value)) {
      throw new HttpError(400, "invalid_headers", `Invalid header: ${name}`);
    }
    result[lower] = value;
  }
  if (body.length) result["content-length"] = String(body.length);
  return result;
}

function filteredResponseHeaders(headers) {
  const result = {};
  const connectionTokens = new Set(String(headers.connection || "").split(",").map(v => v.trim().toLowerCase()));
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() === "x-relay-error-code") continue;
    if (!HOP_BY_HOP.has(name) && !connectionTokens.has(name) && value !== undefined) result[name] = value;
  }
  return result;
}

function proxy(payload, body, config, incoming, signal, now) {
  return new Promise((resolve, reject) => {
    const target = new URL(config.upstream);
    const configuredTimeoutMs = payload.type === "soap"
      ? (config.soapTimeoutMs ?? config.timeoutMs ?? 120_000)
      : (config.restTimeoutMs ?? config.timeoutMs ?? 30_000);
    const callerRemainingMs = payload.deadlineAtMs - now();
    if (callerRemainingMs <= 0) {
      reject(new HttpError(504, "caller_deadline_expired", "Caller deadline expired before upstream dispatch"));
      return;
    }
    const timeoutMs = Math.min(configuredTimeoutMs, callerRemainingMs);
    const timeoutError = callerRemainingMs <= configuredTimeoutMs
      ? new HttpError(504, "caller_deadline_expired", "Caller deadline expired during upstream response")
      : new HttpError(504, "upstream_timeout", "Upstream deadline exceeded");
    const transport = target.protocol === "https:" ? https : http;
    const request = transport.request(target, {
      method: payload.method,
      path: payload.target,
      headers: outboundHeaders(payload.headers, body),
    }, response => {
      const chunks = [];
      let length = 0;
      response.on("data", chunk => {
        length += chunk.length;
        if (length > config.responseBodyLimit) {
          response.destroy(new HttpError(502, "upstream_response_too_large", "Upstream response exceeds limit"));
          return;
        }
        chunks.push(chunk);
      });
      response.on("end", () => {
        if (now() >= payload.deadlineAtMs) {
          reject(new HttpError(504, "caller_deadline_expired", "Caller deadline expired during upstream response"));
          return;
        }
        resolve({
          status: response.statusCode,
          headers: filteredResponseHeaders(response.headers),
          body: Buffer.concat(chunks)
        });
      });
      response.on("error", reject);
    });
    const timer = setTimeout(() => request.destroy(timeoutError), timeoutMs);
    const abort = () => request.destroy(new HttpError(499, "caller_disconnected", "Caller disconnected"));
    if (signal) signal.addEventListener("abort", abort, { once: true });
    request.on("close", () => {
      clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", abort);
    });
    request.on("error", reject);
    if (body.length) request.write(body);
    request.end();
  });
}

export function createRelayServer(options) {
  const config = options;
  const replayCache = options.replayStore || createReplayStore(config);
  let concurrent = 0;
  let ingress = 0;
  const maxIngress = config.maxConcurrentIngress || 64;
  const maxCallerDeadlineMs = config.maxCallerDeadlineMs ?? 180_000;
  const now = options.now || Date.now;
  const logger = options.logger || log;
  const paceUpstream = createUpstreamPacer(config, now);
  const server = http.createServer(async (req, res) => {
    const started = now();
    let requestId;
    try {
      const url = new URL(req.url, "http://relay");
      if (req.method === "GET" && url.pathname === "/healthz" && !url.search) {
        return json(res, 200, { status: "ok" }, { "x-relay-contract-version": "2" });
      }
      if (url.pathname !== REQUEST_PATH || url.search) {
        throw new HttpError(404, "not_found", "Not found");
      }
      if (ingress >= maxIngress) {
        throw new HttpError(503, "busy", "Relay ingress limit reached");
      }
      ingress++;
      var admitted = true;
      if (req.method !== "POST") {
        throw new HttpError(405, "method_not_allowed", "Only POST is allowed",);
      }
      const contentType = String(req.headers["content-type"] || "").toLowerCase().split(";", 1)[0].trim();
      if (contentType !== "application/json") {
        throw new HttpError(415, "unsupported_media_type", "Content-Type must be application/json");
      }
      const raw = await readLimited(req, config.requestBodyLimit);
      const reservation = authenticate(req, raw, config, replayCache, now);
      const payload = parsePayload(raw);
      const acceptedAt = now();
      if (payload.deadlineAtMs <= acceptedAt) {
        throw new HttpError(408, "caller_deadline_expired", "Caller deadline has expired");
      }
      if (payload.deadlineAtMs > acceptedAt + maxCallerDeadlineMs) {
        throw new HttpError(400, "invalid_deadline", "Caller deadline exceeds the allowed horizon");
      }
      const body = decodeBody(payload, config.requestBodyLimit);
      outboundHeaders(payload.headers, body);
      if (concurrent >= config.maxConcurrentUpstreams) {
        throw new HttpError(503, "busy", "Relay concurrency limit reached");
      }
      const reserved = replayCache.reserve(reservation.replayKeys, reservation.expires, now());
      if (reserved?.full) {
        throw new HttpError(503, "replay_journal_full", "Relay replay storage is full");
      }
      if (!reserved) {
        throw new HttpError(409, "replayed_request", "Request has already been accepted");
      }
      requestId = reservation.requestId;
      concurrent++;
      const callerAbort = new AbortController();
      const disconnected = () => { if (!req.complete) callerAbort.abort(); };
      const responseDisconnected = () => { if (!res.writableEnded) callerAbort.abort(); };
      req.on("aborted", disconnected);
      req.on("close", disconnected);
      res.on("close", responseDisconnected);
      let upstream;
      try {
        upstream = await paceUpstream(
          payload,
          callerAbort.signal,
          () => proxy(payload, body, config, req, callerAbort.signal, now),
        );
      } finally {
        concurrent--;
        req.off("aborted", disconnected);
        req.off("close", disconnected);
        res.off("close", responseDisconnected);
      }
      res.writeHead(upstream.status, { ...upstream.headers, "x-relay-request-id": requestId });
      res.end(upstream.body);
      logger("info", "relay_complete", {
        requestId, method: payload.method, apiVersion: payload.apiVersion,
        status: upstream.status, durationMs: now() - started
      });
    } catch (error) {
      const known = error instanceof HttpError;
      const status = known ? error.status : 502;
      const code = known ? error.code : "upstream_error";
      if (!res.headersSent) {
        // This marker distinguishes relay admission/auth/replay failures from
        // an HTTP status returned by Protractor itself.
        const marker = /^[a-z0-9_]+$/i.test(code) ? code : "upstream_error";
        json(res, status, { error: code, message: known ? error.message : "Upstream request failed" }, {
          "x-relay-error-code": marker
        });
      }
      else res.destroy();
      logger(status >= 500 ? "error" : "warn", "relay_rejected", {
        requestId, code, status, durationMs: now() - started,
        ...(known ? {} : { errorCode: error.code || "unknown", errorName: error.name || "Error" })
      });
    } finally {
      if (admitted) ingress--;
    }
  });
  // Leave one socket available to return an explicit 503 when the request
  // admission counter is full instead of silently dropping that connection.
  server.maxConnections = maxIngress + 1;
  server.requestTimeout = config.requestTimeoutMs || 10_000;
  server.headersTimeout = Math.min(server.requestTimeout, 10_000);
  server.keepAliveTimeout = 5_000;
  server.maxRequestsPerSocket = 100;
  return server;
}