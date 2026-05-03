/**
 * Preload hook for tsx scripts that need to import code which transitively
 * pulls in `server-only`. The real `server-only` package's index throws on
 * load to enforce React Server Component boundaries — irrelevant for a
 * standalone Node CLI script. We intercept the resolver to return an
 * empty module instead.
 *
 * Usage: NODE_OPTIONS='--require ./scripts/_stubs/server-only-stub.cjs' tsx scripts/foo.ts
 */
const Module = require("node:module");
const path = require("node:path");

const STUB_PATH = path.join(__dirname, "_empty.cjs");
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === "server-only") return STUB_PATH;
  return origResolve.call(this, request, ...rest);
};
