// Test-only module boundary replacements. The entry point, lifecycle, BullMQ,
// ioredis, processor and export engine are deliberately NOT replaced.
const Module = require("node:module");
const path = require("node:path");
const load = Module._load;
const root = process.cwd();
Module._load = function (id, parent, main) {
  const parentFile = parent?.filename || "";
  const absolute = (id.startsWith(".") ? path.resolve(path.dirname(parentFile), id) : id).replace(/\.ts$/, "");
  if (absolute === path.join(root, "lib/protractor-exports/store") ||
      id === "@/lib/protractor-exports/store" ||
      id === "@/lib/data/repositories/protractor-exports")
    return require("./export-worker-fixture.ts").store;
  if (parentFile === path.join(root, "lib/protractor-exports/engine.ts")) {
    if (id === "./authorization") return { authorizeShop: async () => {} };
    if (id === "./sources") return { sourcePage: async () => { throw Error("Unexpected source read"); } };
    if (id === "./transport") return require("./export-worker-fixture.ts").transport;
  }
  // Fail closed rather than allowing a future entry-point import to load a real
  // database, scheduler, or provider. Queue registrations are also checked in Redis.
  if (/^(?:mongodb|postgres|pg|dotenv)(?:\/|$)/.test(id) ||
      /(?:start-worker|workers\/worker|lib\/queue)/.test(absolute))
    throw Error("Forbidden export integration module");
  return load.call(this, id, parent, main);
};
