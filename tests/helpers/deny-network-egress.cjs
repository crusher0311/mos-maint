/**
 * Preload guard for aggregate offline suites.
 *
 * The relay-service contract tests are the only aggregate child allowed to
 * open sockets, and only to loopback. Every provider hostname, external IP,
 * and non-loopback socket remains denied before a connection is attempted.
 */
const http = require("node:http");
const https = require("node:https");
const net = require("node:net");
const tls = require("node:tls");

const allowLoopback = process.env.PROTRACTOR_OFFLINE_ALLOW_LOOPBACK === "true";
const original = {
  httpRequest: http.request,
  httpGet: http.get,
  httpsRequest: https.request,
  httpsGet: https.get,
  connect: net.connect,
  createConnection: net.createConnection,
  tlsConnect: tls.connect,
  fetch: globalThis.fetch,
};

function hostFromTarget(target) {
  if (typeof target === "string") {
    try {
      return new URL(target).hostname;
    } catch {
      return target;
    }
  }
  if (target instanceof URL) return target.hostname;
  if (target && typeof target === "object") {
    return target.hostname || target.host || "";
  }
  return "";
}

function isLoopback(target) {
  const host = String(hostFromTarget(target)).replace(/^\[|\]$/g, "").toLowerCase();
  if (host.startsWith("/")) return true;
  if (host === "localhost" || host === "::1") return true;
  const octets = host.split(".");
  return octets.length === 4 &&
    octets[0] === "127" &&
    octets.slice(1).every(part => /^\d+$/.test(part) && Number(part) <= 255);
}

function assertAllowed(target) {
  if (!allowLoopback || !isLoopback(target)) {
    throw new Error("Network egress denied by aggregate offline Protractor regression");
  }
}

function requestGuard(originalRequest) {
  return function guardedRequest(target, ...args) {
    assertAllowed(target);
    return originalRequest.call(this, target, ...args);
  };
}

function socketGuard(originalConnect) {
  return function guardedSocket(...args) {
    const target = args[0] && typeof args[0] === "object"
      ? args[0]
      : {
          // net.connect(port, host) uses the second argument for the host;
          // an omitted host means the loopback default, which tsx uses for
          // its local transform server.
          host: typeof args[1] === "string"
            ? args[1]
            : typeof args[0] === "string"
              ? args[0]
              : "127.0.0.1",
        };
    assertAllowed(target);
    return originalConnect.apply(this, args);
  };
}

http.request = requestGuard(original.httpRequest);
http.get = requestGuard(original.httpGet);
https.request = requestGuard(original.httpsRequest);
https.get = requestGuard(original.httpsGet);
net.connect = socketGuard(original.connect);
net.createConnection = socketGuard(original.createConnection);
tls.connect = socketGuard(original.tlsConnect);
globalThis.fetch = async function guardedFetch(target, ...args) {
  assertAllowed(target);
  return original.fetch(target, ...args);
};