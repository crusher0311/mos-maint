/**
 * Tiny in-memory Mongo stand-in shared across the route-level cron smoke
 * tests under `tests/`.
 *
 * The route handlers under `app/api/cron/` are exercised end-to-end (auth
 * gate, collection reads, alert upserts/deletes, and `sendEmail` payloads)
 * by swapping `__deps.getDb` and `__deps.sendEmail` on each route via its
 * test seam. The fake DB built here is intentionally minimal — it only
 * implements the operators and methods the cron routes actually use, so a
 * test can seed a tiny world, run the real handler, and assert on both the
 * resulting documents and the recorded operations log.
 *
 * If a route starts using a new operator or method (e.g. `$gt`,
 * `aggregate`), extend the matcher / collection here in one place rather
 * than copying the helper into another smoke test.
 */

export type Doc = Record<string, any>;

export type Op =
  | { op: "find"; collection: string; filter: any; opts?: any }
  | { op: "findOne"; collection: string; filter: any; opts?: any }
  | { op: "createIndex"; collection: string; spec: any; opts?: any }
  | { op: "updateOne"; collection: string; filter: any; update: any; opts?: any }
  | { op: "deleteMany"; collection: string; filter: any }
  | { op: "bulkWrite"; collection: string; ops: any[] };

export function matchesFilter(doc: Doc, filter: any): boolean {
  for (const [k, v] of Object.entries(filter || {})) {
    if (k === "$or" && Array.isArray(v)) {
      if (!v.some((f) => matchesFilter(doc, f))) return false;
      continue;
    }
    if (v && typeof v === "object" && !Array.isArray(v)) {
      const opKeys = Object.keys(v);
      const isOpExpr = opKeys.length > 0 && opKeys.every((kk) => kk.startsWith("$"));
      if (isOpExpr) {
        if ("$in" in v) {
          if (!(v as any).$in.includes(doc[k])) return false;
        }
        if ("$exists" in v) {
          const exists = doc[k] !== undefined && doc[k] !== null;
          if (exists !== (v as any).$exists) return false;
        }
        if ("$ne" in v) {
          if (doc[k] === (v as any).$ne) return false;
        }
        continue;
      }
    }
    if (doc[k] !== v) return false;
  }
  return true;
}

export type FakeDb = {
  ops: Op[];
  collections: Record<string, Doc[]>;
  db: {
    collection(name: string): {
      find(filter?: any, opts?: any): { toArray: () => Promise<Doc[]> };
      findOne(filter?: any, opts?: any): Promise<Doc | null>;
      createIndex(spec: any, opts?: any): Promise<string>;
      updateOne(
        filter: any,
        update: any,
        opts?: any,
      ): Promise<{ matchedCount: number; modifiedCount: number; upsertedCount: number }>;
      deleteMany(filter: any): Promise<{ deletedCount: number }>;
      bulkWrite(
        bulkOps: any[],
      ): Promise<{ matchedCount: number; modifiedCount: number; upsertedCount: number }>;
    };
  };
};

export function makeFakeDb(seed: Record<string, Doc[]>): FakeDb {
  // Defensive shallow copy so tests can keep their seed arrays clean.
  const collections: Record<string, Doc[]> = {};
  for (const [name, docs] of Object.entries(seed)) {
    collections[name] = docs.map((d) => ({ ...d }));
  }
  const ops: Op[] = [];
  return {
    ops,
    collections,
    db: {
      collection(name: string) {
        if (!collections[name]) collections[name] = [];
        const data = collections[name];
        return {
          find(filter: any = {}, opts?: any) {
            ops.push({ op: "find", collection: name, filter, opts });
            const matched = data.filter((d) => matchesFilter(d, filter));
            return {
              toArray: async () => matched.map((d) => ({ ...d })),
            };
          },
          async findOne(filter: any = {}, opts?: any) {
            ops.push({ op: "findOne", collection: name, filter, opts });
            const found = data.find((d) => matchesFilter(d, filter));
            return found ? { ...found } : null;
          },
          async createIndex(spec: any, opts?: any) {
            ops.push({ op: "createIndex", collection: name, spec, opts });
            return opts?.name || "fake_index";
          },
          async updateOne(filter: any, update: any, opts?: any) {
            ops.push({ op: "updateOne", collection: name, filter, update, opts });
            const idx = data.findIndex((d) => matchesFilter(d, filter));
            if (idx >= 0) {
              Object.assign(data[idx], update.$set || {});
              return { matchedCount: 1, modifiedCount: 1, upsertedCount: 0 };
            }
            if (opts?.upsert) {
              data.push({
                ...filter,
                ...(update.$setOnInsert || {}),
                ...(update.$set || {}),
              });
              return { matchedCount: 0, modifiedCount: 0, upsertedCount: 1 };
            }
            return { matchedCount: 0, modifiedCount: 0, upsertedCount: 0 };
          },
          async deleteMany(filter: any) {
            ops.push({ op: "deleteMany", collection: name, filter });
            let deleted = 0;
            for (let i = data.length - 1; i >= 0; i--) {
              if (matchesFilter(data[i], filter)) {
                data.splice(i, 1);
                deleted++;
              }
            }
            return { deletedCount: deleted };
          },
          async bulkWrite(bulkOps: any[]) {
            ops.push({ op: "bulkWrite", collection: name, ops: bulkOps });
            let upserted = 0;
            let modified = 0;
            for (const b of bulkOps) {
              if (b.updateOne) {
                const { filter, update, upsert } = b.updateOne;
                const idx = data.findIndex((d) => matchesFilter(d, filter));
                if (idx >= 0) {
                  Object.assign(data[idx], update.$set || {});
                  modified++;
                } else if (upsert) {
                  data.push({
                    ...filter,
                    ...(update.$setOnInsert || {}),
                    ...(update.$set || {}),
                  });
                  upserted++;
                }
              }
            }
            return {
              matchedCount: modified,
              modifiedCount: modified,
              upsertedCount: upserted,
            };
          },
        };
      },
    },
  };
}
