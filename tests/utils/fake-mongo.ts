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
  | { op: "insertOne"; collection: string; doc: any }
  | { op: "deleteMany"; collection: string; filter: any }
  | { op: "bulkWrite"; collection: string; ops: any[] }
  | { op: "aggregate"; collection: string; pipeline: any[] };

/** Resolve a (possibly nested) dot-path on a document. */
function getPath(doc: any, path: string): any {
  if (doc == null) return undefined;
  if (!path.includes(".")) return doc[path];
  return path.split(".").reduce<any>((o, k) => (o == null ? o : o[k]), doc);
}

export function matchesFilter(doc: Doc, filter: any): boolean {
  for (const [k, v] of Object.entries(filter || {})) {
    if (k === "$or" && Array.isArray(v)) {
      if (!v.some((f) => matchesFilter(doc, f))) return false;
      continue;
    }
    const fieldVal = getPath(doc, k);
    if (v && typeof v === "object" && !Array.isArray(v) && !(v instanceof Date)) {
      const opKeys = Object.keys(v);
      const isOpExpr = opKeys.length > 0 && opKeys.every((kk) => kk.startsWith("$"));
      if (isOpExpr) {
        if ("$in" in v) {
          if (!(v as any).$in.includes(fieldVal)) return false;
        }
        if ("$exists" in v) {
          const exists = fieldVal !== undefined && fieldVal !== null;
          if (exists !== (v as any).$exists) return false;
        }
        if ("$ne" in v) {
          if (fieldVal === (v as any).$ne) return false;
        }
        if ("$gte" in v) {
          if (!(fieldVal != null && fieldVal >= (v as any).$gte)) return false;
        }
        if ("$gt" in v) {
          if (!(fieldVal != null && fieldVal > (v as any).$gt)) return false;
        }
        if ("$lte" in v) {
          if (!(fieldVal != null && fieldVal <= (v as any).$lte)) return false;
        }
        if ("$lt" in v) {
          if (!(fieldVal != null && fieldVal < (v as any).$lt)) return false;
        }
        continue;
      }
    }
    if (fieldVal !== v) return false;
  }
  return true;
}

/**
 * Resolve an aggregation expression:
 *   - "$field.path"      → value at that path on the doc
 *   - { $ifNull: [a, b]} → a if non-null, otherwise b
 *   - literals           → returned as-is
 */
function resolveExpr(expr: any, doc: any): any {
  if (typeof expr === "string" && expr.startsWith("$")) {
    return getPath(doc, expr.slice(1));
  }
  if (expr && typeof expr === "object" && !Array.isArray(expr) && !(expr instanceof Date)) {
    if ("$ifNull" in expr) {
      const [a, b] = expr.$ifNull;
      const av = resolveExpr(a, doc);
      return av != null ? av : resolveExpr(b, doc);
    }
  }
  return expr;
}

/**
 * Minimal aggregation pipeline runner. Supports just the stages the cron
 * routes actually use today: $match (delegated to matchesFilter against the
 * projected doc), $project (literal field selection + $ifNull), and $group
 * (with `$sum: 1` / `$sum: "$field"`). Extend as routes need more.
 */
function runAggregate(data: Doc[], pipeline: any[]): Doc[] {
  let docs: Doc[] = data.map((d) => ({ ...d }));
  for (const stage of pipeline) {
    if (stage.$match) {
      docs = docs.filter((d) => matchesFilter(d, stage.$match));
    } else if (stage.$project) {
      docs = docs.map((d) => {
        const out: Doc = {};
        const projectIdExplicit = "_id" in stage.$project;
        if (!projectIdExplicit || stage.$project._id !== 0) {
          if (d._id !== undefined) out._id = d._id;
        }
        for (const [k, v] of Object.entries(stage.$project)) {
          if (k === "_id") continue;
          if (v === 1 || v === true) {
            out[k] = getPath(d, k);
          } else {
            out[k] = resolveExpr(v, d);
          }
        }
        return out;
      });
    } else if (stage.$group) {
      const { _id: idExpr, ...accs } = stage.$group as Record<string, any>;
      const groups = new Map<string, Doc>();
      for (const d of docs) {
        const key = resolveExpr(idExpr, d);
        const keyStr = JSON.stringify(key ?? null);
        if (!groups.has(keyStr)) groups.set(keyStr, { _id: key });
        const g = groups.get(keyStr)!;
        for (const [accKey, accExpr] of Object.entries(accs)) {
          if (accExpr && typeof accExpr === "object" && "$sum" in accExpr) {
            const inc =
              typeof accExpr.$sum === "number"
                ? accExpr.$sum
                : Number(resolveExpr(accExpr.$sum, d) ?? 0);
            g[accKey] = ((g[accKey] as number) || 0) + (Number.isFinite(inc) ? inc : 0);
          }
        }
      }
      docs = Array.from(groups.values());
    } else {
      throw new Error(`fake-mongo: unsupported aggregate stage ${JSON.stringify(Object.keys(stage))}`);
    }
  }
  return docs;
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
      insertOne(doc: any): Promise<{ insertedId: any }>;
      deleteMany(filter: any): Promise<{ deletedCount: number }>;
      bulkWrite(
        bulkOps: any[],
      ): Promise<{ matchedCount: number; modifiedCount: number; upsertedCount: number }>;
      aggregate(pipeline: any[]): { toArray: () => Promise<Doc[]> };
    };
  };
};

export function makeFakeDb(seed: Record<string, Doc[]>): FakeDb {
  // Defensive shallow copy so tests can keep their seed arrays clean.
  const collections: Record<string, Doc[]> = {};
  for (const [name, docs] of Object.entries(seed)) {
    collections[name] = docs.map((d) => ({ ...d }));
  }
  // Track unique-index key sets per collection so insertOne can simulate
  // the duplicate-key (E11000) behavior the cron routes rely on for dedup.
  const uniqueIndexes: Record<string, string[][]> = {};
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
            if (opts?.unique) {
              if (!uniqueIndexes[name]) uniqueIndexes[name] = [];
              uniqueIndexes[name].push(Object.keys(spec));
            }
            return opts?.name || "fake_index";
          },
          async insertOne(doc: any) {
            ops.push({ op: "insertOne", collection: name, doc });
            // Enforce any unique indexes registered on this collection so
            // routes that rely on E11000 for dedup can be exercised.
            for (const keys of uniqueIndexes[name] || []) {
              const conflict = data.find((existing) =>
                keys.every((k) => getPath(existing, k) === getPath(doc, k)),
              );
              if (conflict) {
                const err: any = new Error(
                  `E11000 duplicate key error on ${name} (${keys.join(",")})`,
                );
                err.code = 11000;
                throw err;
              }
            }
            data.push({ ...doc });
            return { insertedId: doc._id ?? data.length };
          },
          aggregate(pipeline: any[]) {
            ops.push({ op: "aggregate", collection: name, pipeline });
            const result = runAggregate(data, pipeline);
            return {
              toArray: async () => result.map((d) => ({ ...d })),
            };
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
