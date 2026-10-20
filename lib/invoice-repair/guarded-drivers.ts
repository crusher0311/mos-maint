import type { InvoiceFence as CoordinatorFence } from "./fence";
type InvoiceFence = Pick<CoordinatorFence, "run" | "retainUnknown"> & { isScoped?: () => boolean };
const databaseFences = new WeakMap<object, InvoiceFence>();
export const databaseFence = (db: object) => databaseFences.get(db);

/** Keep native Query objects: Proxying postgres-js Query breaks its binding. */
function guardQuery(query: any, fence: InvoiceFence) {
  if (!query || typeof query.handle !== "function") return query;
  const handle = query.handle.bind(query);
  let admitted = false;
  query.handle = function () {
    if (admitted) return;
    admitted = true;
    const text = Array.isArray(query.strings) ? query.strings.join(" ") : String(query.strings);
    if (/(^|;)\s*(?:begin|start\s+transaction|commit|rollback|prepare\s+transaction)\b/i.test(text)
      && !fence.isScoped?.()) {
      query.reject(Error("Use begin() for whole-transaction invoice fencing"));
      return;
    }
    void fence.run(async () => {
      await handle();
      return Promise.prototype.then.call(query, (v: unknown) => v);
    }).catch(error => query.reject(error));
  };
  // Streaming lifetime cannot be inferred from promise settlement. Reporting
  // uses DECLARE/FETCH inside begin(), which holds exclusion until COMMIT.
  for (const method of ["cursor", "readable", "writable"])
    query[method] = () => { throw Error("Use a fenced transaction with bounded DECLARE/FETCH"); };
  return query;
}

export function guardPostgres<T extends object>(client: T, fence: InvoiceFence): T {
  return new Proxy(client, {
    apply(target: any, self, args) {
      return guardQuery(Reflect.apply(target, self, args), fence);
    },
    get(target: any, property) {
      const value = Reflect.get(target, property, target);
      if (["unsafe", "file"].includes(String(property)))
        return (...args: any[]) => guardQuery(value.apply(target, args), fence);
      if (["begin", "savepoint"].includes(String(property))) {
        return (...args: any[]) => fence.run(() => value.apply(target, args.map(arg =>
          typeof arg === "function" ? (tx: any) => arg(guardPostgres(tx, fence)) : arg)));
      }
      if (property === "reserve")
        return () => { throw Error("Unscoped reserved connections are not repair-fenced"); };
      if (["listen", "notify"].includes(String(property)))
        return (...args: any[]) => fence.run(() => value.apply(target, args));
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

const cursorConsumers = new Set(["toArray", "next", "tryNext", "hasNext", "forEach", "count", "explain", "readBufferedDocuments"]);
function guardCursor(cursor: any, fence: InvoiceFence): any {
  return new Proxy(cursor, {
    get(target, key) {
      if (key === Symbol.asyncIterator) return async function* () {
        // Each continuation, including reads served from driver buffers, checks
        // the durable fence; a getMore is never an unchecked back door.
        for (;;) {
          const item = await fence.run(() => target.next());
          if (item === null) return;
          yield item;
        }
      };
      if (key === "stream") return () => { throw Error("Unbounded Mongo streams are not repair-fenced"); };
      const value = Reflect.get(target, key, target);
      if (typeof value !== "function") return value;
      if (key === "clone") return (...args: any[]) => guardCursor(value.apply(target, args), fence);
      if (cursorConsumers.has(String(key))) return (...args: any[]) => fence.run(() => value.apply(target, args));
      return (...args: any[]) => {
        const result = value.apply(target, args);
        return result === target ? guardCursor(result, fence) : result;
      };
    },
  });
}
const cursorFactories = new Set(["find", "aggregate", "listIndexes", "listSearchIndexes"]);
// Authentication must remain available to authorize recovery. It never reads
// invoice rows. Aggregation and raw commands are fenced even on these stores.
const authOnlyCollections = new Set(["sessions", "users"]);
function guardCollection(collection: any, fence: InvoiceFence): any {
  return new Proxy(collection, {
    get(target, key) {
      const value = Reflect.get(target, key, target);
      if (typeof value !== "function") return value;
      const authRead = authOnlyCollections.has(target.collectionName) && key === "findOne";
      if (cursorFactories.has(String(key)))
        return (...args: any[]) => guardCursor(value.apply(target, args), fence);
      if (key === "watch") return () => { throw Error("Change streams need a separately verified repair boundary"); };
      if (["initializeOrderedBulkOp", "initializeUnorderedBulkOp"].includes(String(key)))
        return () => { throw Error("Use fenced bulkWrite"); };
      if (key === "rename") return (...args: any[]) =>
        fence.run(async () => guardCollection(await value.apply(target, args), fence));
      if (authRead) return value.bind(target);
      return (...args: any[]) => fence.run(() => Promise.resolve(value.apply(target, args)));
    },
  });
}

export function guardMongoDb<T extends object>(db: T, fence: InvoiceFence): T {
  const coordinator = fence;
  fence = {
    isScoped: () => coordinator.isScoped?.() ?? false,
    retainUnknown: () => coordinator.retainUnknown(),
    run: async work => {
      const marker = await (db as any).collection("invoice_repair_installation").findOne({ _id: "coordinator" });
      if (marker && (marker.protocol !== 1 || typeof marker.installationKey !== "string"))
        throw Error("Invalid Mongo repair coordinator binding");
      return coordinator.run(work, marker?.installationKey ?? null);
    },
  };
  const proxy = new Proxy(db, {
    get(target: any, key) {
      const value = Reflect.get(target, key, target);
      if (key === "collection") return (...args: any[]) => {
        if (args[0] === "invoice_repair_installation") throw Error("Repair binding is not an application collection");
        return guardCollection(value.apply(target, args), fence);
      };
      if (["aggregate", "listCollections", "runCursorCommand"].includes(String(key)))
        return (...args: any[]) => guardCursor(value.apply(target, args), fence);
      if (key === "admin") return () => {
        const admin = value.call(target);
        return new Proxy(admin, { get(object, member) {
          const method = Reflect.get(object, member, object);
          return typeof method === "function"
            ? (...args: any[]) => fence.run(() => Promise.resolve(method.apply(object, args))) : method;
        } });
      };
      if (["command", "createCollection", "dropCollection", "dropDatabase", "renameCollection", "collections"].includes(String(key)))
        return (...args: any[]) => fence.run(async () => {
          const result = await value.apply(target, args);
          if (key === "createCollection") return guardCollection(result, fence);
          if (key === "collections") return result.map((c: any) => guardCollection(c, fence));
          return result;
        });
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  databaseFences.set(proxy, fence);
  return proxy;
}
export function guardMongoClient<T extends object>(client: T, fence: InvoiceFence): T {
  return new Proxy(client, {
    get(target: any, key) {
      const value = Reflect.get(target, key, target);
      if (key === "db") return (...args: any[]) => guardMongoDb(value.apply(target, args), fence);
      if (key === "startSession") return (...args: any[]) => {
        const session = value.apply(target, args);
        const transaction = session.withTransaction.bind(session);
        session.withTransaction = (...params: any[]) => fence.run(() => transaction(...params));
        // Manual transactions can outlive a statement's shared lock.
        const start = session.startTransaction.bind(session);
        let inManagedTransaction = false;
        session.startTransaction = (...params: any[]) => {
          if (!inManagedTransaction) throw Error("Use withTransaction for fenced Mongo sessions");
          return start(...params);
        };
        session.withTransaction = (...params: any[]) => fence.run(async () => {
          inManagedTransaction = true;
          try { return await transaction(...params); } finally { inManagedTransaction = false; }
        });
        return session;
      };
      if (key === "bulkWrite") return (...args: any[]) => fence.run(() => value.apply(target, args));
      if (key === "watch") return () => { throw Error("Unscoped client change streams are not repair-fenced"); };
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
