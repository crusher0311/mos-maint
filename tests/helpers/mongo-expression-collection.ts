import assert from "node:assert/strict";

type Row = Record<string, any>;

const REMOVE = Symbol("mongo-remove");

function clone<T>(value: T): T {
  if (value instanceof Date) return new Date(value.getTime()) as T;
  if (Array.isArray(value)) return value.map(clone) as T;
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, clone(item)]),
    ) as T;
  }
  return value;
}

function get(row: Row, path: string): any {
  return path.split(".").reduce((value, key) => value?.[key], row);
}

function set(row: Row, path: string, value: any): void {
  const keys = path.split(".");
  const last = keys.pop()!;
  let target = row;
  for (const key of keys) target = target[key] ??= {};
  if (value === REMOVE) delete target[last];
  else target[last] = value;
}

function compare(left: any, right: any): number {
  const a = left instanceof Date ? left.getTime() : left;
  const b = right instanceof Date ? right.getTime() : right;
  if (a === b) return 0;
  if (a === undefined || b === undefined || a === null || b === null) return Number.NaN;
  return a < b ? -1 : a > b ? 1 : 0;
}

function expression(value: any, row: Row, now: Date): any {
  if (value === "$$NOW") return now;
  if (value === "$$REMOVE") return REMOVE;
  if (typeof value === "string" && value.startsWith("$")) return get(row, value.slice(1));
  if (Array.isArray(value)) return value.map(item => expression(item, row, now));
  if (!value || typeof value !== "object" || value instanceof Date) return value;

  const entries = Object.entries(value);
  if (entries.length !== 1 || !entries[0][0].startsWith("$")) {
    return Object.fromEntries(entries.map(([key, item]) => [key, expression(item, row, now)]));
  }
  const [operator, argument] = entries[0];
  const args = () => expression(argument, row, now);
  switch (operator) {
    // MongoDB does not promise short-circuit evaluation for these boolean
    // operators. Evaluate every operand so malformed-record tests catch any
    // arithmetic that was left outside a type/range guard.
    case "$and": {
      const values = (argument as any[]).map(item => Boolean(expression(item, row, now)));
      return values.every(Boolean);
    }
    case "$or": {
      const values = (argument as any[]).map(item => Boolean(expression(item, row, now)));
      return values.some(Boolean);
    }
    case "$eq": { const [a, b] = args(); return compare(a, b) === 0; }
    case "$ne": { const [a, b] = args(); return compare(a, b) !== 0; }
    case "$gt": { const [a, b] = args(); return compare(a, b) > 0; }
    case "$gte": { const [a, b] = args(); return compare(a, b) >= 0; }
    case "$lt": { const [a, b] = args(); return compare(a, b) < 0; }
    case "$lte": { const [a, b] = args(); return compare(a, b) <= 0; }
    case "$in": {
      const [item, values] = args();
      return values.some((value: any) => compare(item, value) === 0);
    }
    case "$add": {
      const values = args();
      assert.ok(
        values.every((item: any) => typeof item === "number" && Number.isFinite(item)),
        "$add requires finite numeric operands",
      );
      return values.reduce((sum: number, item: number) => sum + item, 0);
    }
    case "$subtract": {
      const [a, b] = args();
      assert.ok(
        [a, b].every(item => typeof item === "number" && Number.isFinite(item)),
        "$subtract requires finite numeric operands",
      );
      return a - b;
    }
    case "$max": {
      const values = args();
      assert.ok(
        values.every((item: any) => typeof item === "number" && Number.isFinite(item)),
        "$max requires finite numeric operands",
      );
      return Math.max(...values);
    }
    case "$ifNull": {
      const values = argument as any[];
      const first = expression(values[0], row, now);
      return first === null || first === undefined ? expression(values[1], row, now) : first;
    }
    case "$type": {
      const evaluated = args();
      if (evaluated === undefined) return "missing";
      if (evaluated === null) return "null";
      if (evaluated instanceof Date) return "date";
      if (Array.isArray(evaluated)) return "array";
       if (typeof evaluated === "bigint") return "long";
       if (typeof evaluated === "number") return Number.isInteger(evaluated) ? "int" : "double";
      return typeof evaluated;
    }
    case "$isArray": return Array.isArray(args());
    case "$literal": return clone(argument);
    case "$cond": {
      const [condition, yes, no] = argument as any[];
      return expression(condition, row, now)
        ? expression(yes, row, now)
        : expression(no, row, now);
    }
    case "$switch": {
      const spec = argument as any;
      const branch = spec.branches.find((item: any) => expression(item.case, row, now));
      return expression(branch ? branch.then : spec.default, row, now);
    }
    case "$dateAdd": {
      const spec = argument as any;
      const start = expression(spec.startDate, row, now);
      const amount = expression(spec.amount, row, now);
      const multipliers: Record<string, number> = {
        millisecond: 1,
        second: 1_000,
        minute: 60_000,
        hour: 3_600_000,
        day: 86_400_000,
      };
      assert.ok(start instanceof Date, "$dateAdd requires a Date");
      assert.ok(spec.unit in multipliers, `unsupported $dateAdd unit ${spec.unit}`);
       assert.ok(
         typeof amount === "number" && Number.isFinite(amount),
         "$dateAdd requires a finite numeric amount",
       );
       return new Date(start.getTime() + amount * multipliers[spec.unit]);
    }
    case "$concatArrays": return args().flat();
    case "$mergeObjects": return Object.assign({}, ...args());
    case "$slice": {
      const values = args();
      return values.length === 2
        ? values[0].slice(values[1] < 0 ? values[1] : 0, values[1] < 0 ? undefined : values[1])
        : values[0].slice(values[1], values[1] + values[2]);
    }
    default: throw new Error(`unsupported Mongo expression ${operator}`);
  }
}

function matches(row: Row, filter: Row, now: Date): boolean {
  return Object.entries(filter).every(([path, expected]) => {
    if (path === "$expr") return Boolean(expression(expected, row, now));
    if (path === "$and") return (expected as any[]).every(item => matches(row, item, now));
    if (path === "$or") return (expected as any[]).some(item => matches(row, item, now));
    const actual = get(row, path);
    if (expected && typeof expected === "object" && !(expected instanceof Date)) {
      return Object.entries(expected).every(([operator, operand]) => {
        if (operator === "$exists") return (actual !== undefined) === operand;
        if (operator === "$type") {
          if (operand === "number") return typeof actual === "number";
          if (operand === "int") return typeof actual === "number" && Number.isInteger(actual);
          if (operand === "long") return typeof actual === "bigint";
          if (operand === "double") return typeof actual === "number" && !Number.isInteger(actual);
          if (operand === "date") return actual instanceof Date;
          if (operand === "array") return Array.isArray(actual);
          return typeof actual === operand;
        }
        if (operator === "$ne") return compare(actual, operand) !== 0;
        if (operator === "$eq") return compare(actual, operand) === 0;
        if (operator === "$gt") return compare(actual, operand) > 0;
        if (operator === "$gte") return compare(actual, operand) >= 0;
        if (operator === "$lt") return compare(actual, operand) < 0;
        if (operator === "$lte") return compare(actual, operand) <= 0;
        throw new Error(`unsupported Mongo filter operator ${operator}`);
      });
    }
    return compare(actual, expected) === 0;
  });
}

function applyUpdate(row: Row, update: any, now: Date, inserted: boolean): void {
  const stages = Array.isArray(update) ? update : [update];
  for (const stage of stages) {
    const source = clone(row);
    if (stage.$setOnInsert && inserted) {
      for (const [path, value] of Object.entries(stage.$setOnInsert)) set(row, path, clone(value));
    }
    if (stage.$set) {
      for (const [path, value] of Object.entries(stage.$set)) {
        set(row, path, expression(value, source, now));
      }
    }
    if (stage.$unset) {
      for (const path of Object.keys(stage.$unset)) set(row, path, REMOVE);
    }
    const unsupported = Object.keys(stage).filter(
      key => !["$set", "$setOnInsert", "$unset"].includes(key),
    );
    assert.deepEqual(unsupported, [], `unsupported Mongo update stages: ${unsupported.join(", ")}`);
  }
}

export function createMongoExpressionCollection(
  initialRow: Row,
  options: {
    now?: () => Date;
    afterFindOneAndUpdate?: () => Error | undefined;
  } = {},
) {
  const row = clone(initialRow);
  const calls: Array<{ method: string; filter: any; update?: any; options?: any }> = [];
  const currentTime = () => clone(options.now?.() ?? new Date());

  const collection = {
    calls,
    row,
    async updateOne(filter: any, update: any, updateOptions: any = {}) {
      calls.push({ method: "updateOne", filter, update, options: updateOptions });
      let inserted = false;
      if (!matches(row, filter, currentTime())) {
        if (!updateOptions.upsert) return { matchedCount: 0, modifiedCount: 0 };
        inserted = true;
        for (const [key, value] of Object.entries(filter)) {
          if (!key.startsWith("$") && !(value && typeof value === "object")) set(row, key, value);
        }
      }
      applyUpdate(row, update, currentTime(), inserted);
      return { matchedCount: inserted ? 0 : 1, modifiedCount: 1, upsertedCount: inserted ? 1 : 0 };
    },
    async findOneAndUpdate(filter: any, update: any, updateOptions: any = {}) {
      calls.push({ method: "findOneAndUpdate", filter, update, options: updateOptions });
      if (!matches(row, filter, currentTime())) return null;
      applyUpdate(row, update, currentTime(), false);
      const committed = clone(row);
      const postCommitError = options.afterFindOneAndUpdate?.();
      if (postCommitError) throw postCommitError;
      return committed;
    },
    async findOne(filter: any) {
      calls.push({ method: "findOne", filter });
      return matches(row, filter, currentTime()) ? clone(row) : null;
    },
  };
  return collection;
}