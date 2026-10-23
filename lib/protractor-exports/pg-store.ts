import type { Collection, Document } from "mongodb";

/** Small, explicit persistence interface for the existing export engine.
 * Mongo-shaped calls are compiled to parameterized PG statements, never Mongo.
 * Unsupported operators fail rather than weakening a lease or revision fence. */
export interface ExportSql {
  unsafe(query: string, parameters?: any[]): Promise<any>;
}
export const exportTables = ["configs", "states", "hashes", "history", "health"] as const;
type Table = typeof exportTables[number];
type Row = Record<string, any>;

class Statement {
  parameters: any[] = [];
  bind(value: any, type = "jsonb") {
    if (value === undefined) throw new Error("Undefined export persistence value");
    // Bind serialized JSON as TEXT before casting. This avoids both JSON double
    // encoding and driver inference of native boolean/numeric parameter types.
    this.parameters.push(type === "jsonb" ? JSON.stringify(value) : value);
    return `$${this.parameters.length}::${type === "jsonb" ? "text::jsonb" : type}`;
  }
  path(key: string) {
    if (!/^[A-Za-z_]\w*(\.[A-Za-z_]\w*)*$/.test(key))
      throw new Error("Unsupported export field");
    return `'{${key.split(".").join(",")}}'`;
  }
  field(key: string) {
    this.path(key); // Validate identifiers before embedding constant field paths.
    return key === "_id" ? "id" : key.includes(".") ?
      `(doc #> ${this.path(key)})` : `(doc -> '${key}')`;
  }
  filter(query: Row): string {
    const parts = Object.entries(query).map(([key, value]) => {
      if (key === "$or" || key === "$and") {
        if (!Array.isArray(value) || !value.length) throw new Error("Empty export predicate");
        return `(${value.map(q => this.filter(q)).join(key === "$or" ? " OR " : " AND ")})`;
      }
      const field = this.field(key), type = key === "_id" ? "text" : "jsonb";
      if (value && typeof value === "object" && !(value instanceof Date) && !Array.isArray(value)) {
        return `(${Object.entries(value).map(([op, v]) => {
          if (op === "$exists") {
            if (typeof v !== "boolean") throw new Error("Invalid export existence predicate");
            return `${field} IS ${v ? "NOT " : ""}NULL`;
          }
          const operators: Record<string, string> = { $gt: ">", $lt: "<", $ne: "IS DISTINCT FROM" };
          if (!operators[op]) throw new Error("Unsupported export predicate");
          return `${field} ${operators[op]} ${this.bind(v, type)}`;
        }).join(" AND ")})`;
      }
      return `${field} = ${this.bind(value, type)}`;
    });
    return parts.length ? `(${parts.join(" AND ")})` : "TRUE";
  }
  update(update: Row, original = "doc", inserting = false) {
    for (const op of Object.keys(update))
      if (!["$set", "$unset", "$setOnInsert"].includes(op)) throw new Error("Unsupported export mutation");
    let expression = original;
    const set = { ...(inserting ? update.$setOnInsert : {}), ...update.$set };
    for (const [key, value] of Object.entries(set)) {
      if (key === "_id") throw new Error("Immutable export identity");
      expression = `jsonb_set(${expression}, ${this.path(key)}, ${this.bind(value)}, true)`;
    }
    for (const key of Object.keys(update.$unset ?? {})) {
      if (key === "_id") throw new Error("Immutable export identity");
      expression = `(${expression} #- ${this.path(key)})`;
    }
    return expression;
  }
  project(projection?: Row) {
    if (!projection || !Object.keys(projection).length) return "doc";
    const include = Object.entries(projection).filter(([, v]) => v === 1).map(([k]) => k);
    if (!include.length) {
      return Object.entries(projection).reduce((expr, [key, value]) => {
        if (value !== 0) throw new Error("Invalid export projection");
        return `(${expr} #- ${this.path(key)})`;
      }, "doc");
    }
    if (Object.entries(projection).some(([k, v]) => v !== 1 && k !== "_id"))
      throw new Error("Mixed export projection");
    const tree: Row = {};
    for (const key of [...include, ...(projection._id === 0 ? [] : ["_id"])]) {
      this.path(key);
      let node = tree;
      const parts = key.split(".");
      for (const part of parts.slice(0, -1)) node = node[part] ??= {};
      node[parts.at(-1)!] = key;
    }
    const render = (node: Row): string => `jsonb_strip_nulls(jsonb_build_object(${
      Object.entries(node).map(([key, value]) =>
        `'${key}', ${typeof value === "string" ? `(doc #> ${this.path(value)})` : render(value)}`).join(",")
    }))`;
    return render(tree);
  }
}

function hydrate(table: Table, doc: Row) {
  // Preserve the current engine's Date comparisons; nested pending timestamps
  // and confirmedAt are deliberately ISO strings, not Dates.
  const fields = table === "states" ? ["retryAt", "leaseUntil"] :
    table === "history" ? ["acceptedAt"] : table === "hashes" ? ["updatedAt"] :
    table === "health" ? ["seenAt"] : [];
  for (const field of fields) if (typeof doc[field] === "string") doc[field] = new Date(doc[field]);
  return doc;
}

export function pgExportCollection<T extends Document>(sql: ExportSql, table: Table): Collection<T> {
  if (!exportTables.includes(table)) throw new Error("Unknown export table");
  const relation = `protractor_export.${table}`;
  const run = (s: Statement, query: string) => sql.unsafe(query, s.parameters);
  const adapter = {
    find(query: Row, options?: { projection?: Row }) {
      let maximum = 100, order: Row = { _id: 1 };
      const cursor = {
        limit(n: number) {
          if (!Number.isInteger(n) || n < 1 || n > 1000) throw new Error("Invalid export read bound");
          maximum = n; return cursor;
        },
        sort(value: Row) { order = value; return cursor; },
        async toArray() {
          const s = new Statement(), where = s.filter(query), projection = s.project(options?.projection);
          const sort = Object.entries(order).map(([key, direction]) => {
            if (direction !== 1 && direction !== -1) throw new Error("Invalid export sort");
            return `${s.field(key)} ${direction === 1 ? "ASC" : "DESC"}`;
          }).join(",") || "id";
          const rows = await run(s, `SELECT ${projection} AS doc FROM ${relation}
            WHERE ${where} ORDER BY ${sort} LIMIT ${maximum}`);
          return rows.map((r: Row) => hydrate(table, r.doc));
        },
        async next() { maximum = 1; return (await cursor.toArray())[0] ?? null; },
      };
      return cursor;
    },
    async findOne(query: Row, options?: { projection?: Row }) {
      return adapter.find(query, options).next();
    },
    async insertOne(doc: Row) {
      if (typeof doc._id !== "string" || !doc._id) throw new Error("Export identity required");
      const s = new Statement();
      await run(s, `INSERT INTO ${relation}(id,doc) VALUES (${s.bind(doc._id, "text")},${s.bind(doc)})`);
      return { acknowledged: true, insertedId: doc._id };
    },
    async replaceOne(query: Row, doc: Row) {
      if (query._id !== doc._id) throw new Error("Immutable export identity");
      const s = new Statement(), where = s.filter(query);
      const rows = await run(s, `UPDATE ${relation} SET doc=${s.bind(doc)} WHERE ${where} RETURNING id`);
      return { acknowledged: true, matchedCount: rows.length, modifiedCount: rows.length };
    },
    async mutate(query: Row, update: Row, many: boolean, upsert = false) {
      const s = new Statement();
      if (upsert) {
        if (Object.keys(query).length !== 1 || typeof query._id !== "string")
          throw new Error("Export upsert requires exact identity");
        const seed = s.update(update, s.bind({ _id: query._id }), true);
        const existing = s.update(update, `${table}.doc`);
        return run(s, `INSERT INTO ${relation}(id,doc) VALUES (${s.bind(query._id, "text")},${seed})
          ON CONFLICT(id) DO UPDATE SET doc=${existing} RETURNING doc`);
      }
      const where = s.filter(query), expression = s.update(update);
      // Recheck the whole fence after concurrent writers release their row lock.
      return run(s, `UPDATE ${relation} SET doc=${expression} WHERE ${where}
        ${many ? "" : `AND id=(SELECT id FROM ${relation} WHERE ${where} ORDER BY id LIMIT 1)`}
        RETURNING doc`);
    },
    async updateOne(query: Row, update: Row, options?: { upsert?: boolean }) {
      const rows = await adapter.mutate(query, update, false, options?.upsert);
      return { acknowledged: true, matchedCount: rows.length, modifiedCount: rows.length };
    },
    async updateMany(query: Row, update: Row) {
      const rows = await adapter.mutate(query, update, true);
      return { acknowledged: true, matchedCount: rows.length, modifiedCount: rows.length };
    },
    async findOneAndUpdate(query: Row, update: Row, options: Row) {
      if (options.returnDocument !== "after") throw new Error("Export update requires after image");
      const rows = await adapter.mutate(query, update, false);
      return rows[0] ? hydrate(table, rows[0].doc) : null;
    },
  };
  // Only the methods above are supported. This preserves engine/API dependency
  // injection types without introducing a second, Mongo persistence path.
  return adapter as unknown as Collection<T>;
}

export async function checkPgExportSchema(sql: ExportSql) {
  const fail = () => { throw new Error("PostgreSQL export schema requires operator setup"); };
  const access = await sql.unsafe(`SELECT
    has_schema_privilege('protractor_export','USAGE') AS usable`);
  if (!access[0]?.usable) fail();
  const rows = await sql.unsafe(`SELECT c.relname AS name,a.attname AS column,
    format_type(a.atttypid,a.atttypmod) AS type,a.attnotnull AS required,
    coll.collname AS collation,c.relkind,
    (has_table_privilege(c.oid,'SELECT') AND has_table_privilege(c.oid,'INSERT')
      AND has_table_privilege(c.oid,'UPDATE') AND has_table_privilege(c.oid,'DELETE')) AS writable
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped
    LEFT JOIN pg_collation coll ON coll.oid=a.attcollation
    WHERE n.nspname='protractor_export'`);
  for (const table of exportTables) {
    if (!rows.some((r: Row) => r.name === table && r.column === "doc" && r.type === "jsonb" &&
      r.required && r.writable && r.relkind === "r") ||
      !rows.some((r: Row) => r.name === table && r.column === "id" && r.type === "text" &&
        r.required && r.collation === "C")) fail();
  }
  const indexes = await sql.unsafe(`SELECT idx.relname AS name,t.relname AS table,
    i.indisvalid AS valid,i.indisready AS ready,i.indisunique AS unique,
    i.indisprimary AS primary,i.indpred IS NULL AS whole,
    ARRAY(SELECT pg_get_indexdef(i.indexrelid,k,true)
      FROM generate_series(1,i.indnatts) AS k) AS keys
    ,ARRAY(SELECT i.indoption[k-1] FROM generate_series(1,i.indnatts) AS k) AS options
    ,ARRAY(SELECT co.collname FROM generate_series(1,i.indnatts) AS k
      LEFT JOIN pg_collation co ON co.oid=i.indcollation[k-1]) AS collations
    FROM pg_index i JOIN pg_class idx ON idx.oid=i.indexrelid
    JOIN pg_class t ON t.oid=i.indrelid JOIN pg_namespace n ON n.oid=t.relnamespace
    WHERE n.nspname='protractor_export'`);
  const normalize = (s: string) => s.replace(/::text(?:\[\])?/g, "")
    .replace(/ DESC| COLLATE "C"/g, "").replace(/[()\s]/g, "");
  const expected: Array<[string, string, string[], boolean]> = [
    ...exportTables.map(t => [`${t}_pkey`, t, ["id"], true] as [string, string, string[], boolean]),
    ["export_active", "configs", ["doc->'paused'", "doc->'revoked'", "id"], false],
    ["export_status", "states", ["doc->'enterpriseId'", "doc->'revision'", "doc->'shopId'"], false],
    ["export_retention", "states", ["doc#>'{pending,createdAt}'"], false],
    ["export_history_enterprise_accepted", "history", ["doc->'enterpriseId'", "(doc->'acceptedAt') DESC"], false],
    ["export_history_expiry", "history", ['(doc->>\'acceptedAt\') COLLATE "C"', "id"], false],
  ];
  for (const [name, table, keys, primary] of expected) {
    if (!indexes.some((i: Row) => i.name === name && i.table === table && i.valid &&
      i.ready && i.whole && i.primary === primary && i.unique === primary &&
      i.options.every((v: number, k: number) => v === (keys[k]?.endsWith(" DESC") ? 3 : 0)) &&
      (name !== "export_history_expiry" || i.collations[0] === "C") &&
      JSON.stringify(i.keys.map(normalize)) === JSON.stringify(keys.map(normalize))))
      throw new Error(`PostgreSQL export schema requires operator setup: ${name}`);
  }
  const marker = await sql.unsafe(`SELECT version FROM protractor_export.schema_version WHERE singleton=true`);
  if (marker.length !== 1 || marker[0].version !== 1)
    throw new Error("PostgreSQL export schema version incompatible");
}

/** Explicit bounded replacement for Mongo TTL; never deletes pending delivery state. */
export async function expirePgExportHistory(sql: ExportSql) {
  await sql.unsafe(`DELETE FROM protractor_export.history WHERE id IN (
    SELECT id FROM protractor_export.history
    WHERE (doc->>'acceptedAt') COLLATE "C" < $1
    ORDER BY (doc->>'acceptedAt') COLLATE "C",id LIMIT 1000
  )`, [new Date(Date.now() - 90 * 86400_000).toISOString()]);
}
