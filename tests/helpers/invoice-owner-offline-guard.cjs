// Deny all TCP/TLS, HTTP and DNS, including loopback. Only our disposable PG
// Unix socket is permitted. Do not reuse this preload for operator tools.
const net = require("node:net");
const socket = process.env.INVOICE_OWNER_TEST_SOCKET;
if (!/^\/tmp\/invoice-owner-offline\.[A-Za-z0-9]+$/.test(socket || "")) {
  throw new Error("Missing disposable invoice-owner socket");
}
const deny = () => { throw new Error("Invoice-owner offline network denied"); };
const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  // net.connect normalizes arguments into an array before calling Socket.connect.
  const target = Array.isArray(args[0]) ? args[0][0] : args[0];
  const path = typeof target === "string" ? target : target?.path;
  if (path !== `${socket}/.s.PGSQL.5432`) return deny();
  return connect.apply(this, args);
};
for (const module of ["node:http", "node:https"]) {
  const api = require(module);
  api.request = api.get = deny;
}
require("node:tls").connect = deny;
globalThis.fetch = async () => deny();
for (const api of [require("node:dns"), require("node:dns/promises")]) {
  for (const key of Object.keys(api)) {
    if (key === "lookup" || key === "lookupService" || key.startsWith("resolve")) api[key] = deny;
  }
}
require("node:dgram").createSocket = deny;
