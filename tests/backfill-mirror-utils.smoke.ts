/**
 * Task #1018 — regression tests for the Mongo→PG backfill mirror fixes.
 *
 * Covers the two empirically-confirmed prod failure modes:
 *   1. UNDEFINED_VALUE: absent Mongo fields reaching postgres-js as
 *      `undefined` — every param must compile to a bindable value (null).
 *   2. Tuple expansion: arrays/objects (e.g. support_tickets.messages)
 *      rendered as SQL tuples instead of ONE jsonb parameter.
 * Plus: enum-safe support_tickets mapping and error-cause visibility.
 *
 * Pure unit test — compiles SQL with PgDialect, no DB connection needed.
 */
import { PgDialect } from "drizzle-orm/pg-core";
import {
  buildMirrorUpsert,
  describeMirrorError,
  mirrorParam,
  safeEnum,
  TICKET_CATEGORIES,
  TICKET_PRIORITIES,
  TICKET_STATUSES,
} from "../scripts/backfill-mirror-utils";

let failures = 0;
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) {
    console.log(`  ✓ ${name}`);
  } else {
    failures++;
    console.error(`  ✗ ${name}`, detail !== undefined ? detail : "");
  }
}

const dialect = new PgDialect();
const compile = (stmt: ReturnType<typeof buildMirrorUpsert>) =>
  dialect.sqlToQuery(stmt);

console.log("[1] undefined-value hardening");
{
  // A doc with missing optional fields — mimics a legacy pre_vehicles row.
  const values: Record<string, unknown> = {
    backfill_mongo_id: "abc123",
    shop_id: 54,
    vin: undefined, // absent Mongo field
    year: undefined,
    make: "Toyota",
    declined: undefined,
    payload: { _id: "abc123", make: "Toyota" },
  };
  const q = compile(buildMirrorUpsert("pre_normalized_vehicles", values));
  check(
    "no undefined params reach the driver",
    q.params.every((p) => p !== undefined),
    q.params,
  );
  check(
    "absent fields bind as null",
    q.params[2] === null && q.params[3] === null && q.params[5] === null,
    q.params,
  );
  check(
    "insert-or-skip conflict on backfill_mongo_id",
    q.sql.includes(`on conflict ("backfill_mongo_id") do nothing`) ||
      q.sql.includes(`ON CONFLICT ("backfill_mongo_id") DO NOTHING`),
    q.sql,
  );
}

console.log("[2] jsonb params: arrays bind as ONE parameter, not a tuple");
{
  const messages = [
    { author: "user", text: "help", sentAt: new Date("2026-08-01T00:00:00Z") },
    { author: "support", text: "on it" },
  ];
  const values: Record<string, unknown> = {
    mongo_id: "0123456789abcdef01234567",
    ticket_number: "T-1001",
    subject: "Printer on fire",
    messages,
    metadata: { foo: "bar", nested: { a: 1 } },
  };
  const q = compile(
    buildMirrorUpsert("support_tickets", values, {
      conflictKey: ["ticket_number"],
    }),
  );
  // 5 columns → exactly 5 params: the array must NOT expand.
  check("exactly one param per column", q.params.length === 5, {
    n: q.params.length,
    sql: q.sql,
  });
  const msgParam = q.params[3];
  check(
    "messages binds as a JSON string",
    typeof msgParam === "string" && JSON.parse(msgParam as string).length === 2,
    msgParam,
  );
  check("jsonb cast present in SQL", /::jsonb/.test(q.sql), q.sql);
  check(
    "no empty-tuple / tuple rendering",
    !q.sql.includes("()") && !/\(\$\d+, \$\d+\)\s*,/.test(q.sql),
    q.sql,
  );
  check(
    "ON CONFLICT refreshes non-key columns",
    /on conflict \("ticket_number"\) do update set/i.test(q.sql),
    q.sql,
  );
}

console.log("[3] mirrorParam edge cases");
{
  const d = new Date("2026-08-02T12:00:00Z");
  const qDate = compile(buildMirrorUpsert("t", { a: d }, { conflictKey: ["a"] }));
  check("Date passes through untouched", qDate.params[0] === d, qDate.params);
  // ObjectId-like object with toJSON serializes inside jsonb payloads.
  const oidLike = { toJSON: () => "65f0c0ffee0ddba11ca75123" };
  const qOid = compile(
    buildMirrorUpsert("t", { payload: { _id: oidLike } }, { conflictKey: ["payload"] }),
  );
  check(
    "ObjectId-like toJSON respected in payload",
    typeof qOid.params[0] === "string" &&
      (qOid.params[0] as string).includes("65f0c0ffee0ddba11ca75123"),
    qOid.params,
  );
  // nested undefined keys are dropped by JSON.stringify, not sent as undefined
  const qNested = compile(
    buildMirrorUpsert("t", { payload: { a: undefined, b: 1 } }, { conflictKey: ["payload"] }),
  );
  check(
    "nested undefined dropped in jsonb",
    qNested.params[0] === `{"b":1}`,
    qNested.params,
  );
}

console.log("[4] support_tickets enum-safe mapping");
{
  const acct = safeEnum("account", TICKET_CATEGORIES, "general");
  check("unknown category 'account' → general", acct.value === "general");
  check("original category preserved", acct.original === "account");
  check(
    "known category passes through",
    safeEnum("billing", TICKET_CATEGORIES, "general").value === "billing",
  );
  check(
    "status 'resolved' survives",
    safeEnum("resolved", TICKET_STATUSES, "open").value === "resolved",
  );
  check(
    "status 'closed' survives",
    safeEnum("closed", TICKET_STATUSES, "open").value === "closed",
  );
  check(
    "null priority falls back without recording an original",
    (() => {
      const r = safeEnum(null, TICKET_PRIORITIES, "medium");
      return r.value === "medium" && r.original === null;
    })(),
  );
}

console.log("[5] error visibility includes cause + SQLSTATE");
{
  const pgErr = Object.assign(new Error("null value in column violates not-null"), {
    code: "23502",
  });
  const wrapped = Object.assign(new Error("Failed query: INSERT ..."), {
    cause: pgErr,
  });
  const msg = describeMirrorError(wrapped);
  check("outer message present", msg.includes("Failed query"), msg);
  check("cause message present", msg.includes("not-null"), msg);
  check("SQLSTATE present", msg.includes("23502"), msg);
  check(
    "UNDEFINED_VALUE code surfaces",
    describeMirrorError(
      Object.assign(new Error("Undefined values are not allowed"), {
        code: "UNDEFINED_VALUE",
      }),
    ).includes("UNDEFINED_VALUE"),
  );
}

if (failures) {
  console.error(`\n${failures} check(s) FAILED`);
  process.exit(1);
}
console.log("\nAll backfill-mirror-utils checks passed.");
