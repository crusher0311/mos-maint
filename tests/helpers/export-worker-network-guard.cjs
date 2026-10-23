// Loaded before tsx in both the test runner and workers. No DNS, TLS, UDP,
// external TCP or inherited fetch implementation can escape this fixture.
const net = require("node:net");
const deny = () => { throw Error("Export integration external network denied"); };
const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  const target = Array.isArray(args[0]) ? args[0][0] : args[0];
  const host = typeof target === "object" ? target?.host : args[1];
  const socket = process.env.EXPORT_FIXTURE_PG_SOCKET;
  const socketPath = typeof target === "object" ? target?.path : target;
  if (/^\/tmp\/export-pg\.[A-Za-z0-9]+$/.test(socket || "") &&
      socketPath === `${socket}/.s.PGSQL.5432`) return connect.apply(this, args);
  if (host !== "127.0.0.1") return deny();
  return connect.apply(this, args);
};
require("node:tls").connect = deny;
require("node:dgram").createSocket = deny;
globalThis.fetch = async () => deny();
for (const api of [require("node:dns"), require("node:dns/promises")])
  for (const key of Object.keys(api))
    if (key === "lookup" || key === "lookupService" || key.startsWith("resolve")) api[key] = deny;
// Node calls dns.lookup even for literal listen addresses; resolve this one
// locally without invoking the operating system resolver.
require("node:dns").lookup = (host, options, callback) => {
  if (host !== "127.0.0.1") return deny();
  const cb = typeof options === "function" ? options : callback;
  queueMicrotask(() => options?.all ? cb(null, [{ address: host, family: 4 }]) : cb(null, host, 4));
};
