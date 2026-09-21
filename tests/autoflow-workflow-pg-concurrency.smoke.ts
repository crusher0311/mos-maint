/**
 * Offline execution coverage for the real PG workflow CAS helper. The fake
 * Drizzle executor compiles the helper's SQL AST, then applies that predicate
 * atomically to an in-memory row; it never opens a database connection.
 *
 * Run:
 *   npx tsx tests/autoflow-workflow-pg-concurrency.smoke.ts
 */
import assert from "node:assert/strict";
import Module from "node:module";
import { PgDialect } from "drizzle-orm/pg-core";

type Row = {
  shopId: number;
  settings: Record<string, any> | null;
  sibling: string;
};

const rows = new Map<number, Row>([
  [432, {
    shopId: 432,
    settings: {
      autoflow: { apiKey: "secret-remains", domain: "shop.example", workflowRevision: null },
      unrelated: { enabled: true },
    },
    sibling: "untouched",
  }],
  [900, {
    shopId: 900,
    settings: { autoflow: { domain: "other.example" } },
    sibling: "also-untouched",
  }],
]);

const dialect = new PgDialect();
const compiled: Array<{ setSql: string; whereSql: string }> = [];

function queryOf(fragment: any) {
  return dialect.sqlToQuery(fragment);
}

const fakeDb = {
  update() {
    let values: any;
    let predicate: any;
    return {
      set(next: any) {
        values = next;
        return this;
      },
      where(next: any) {
        predicate = next;
        return this;
      },
      async returning() {
        const where = queryOf(predicate);
        const set = queryOf(values.settings);
        compiled.push({ setSql: set.sql, whereSql: where.sql });

        // Execute the actual generated predicate parameters. eq(mos_shop_id)
        // contributes the numeric id; the raw JSONB comparison contributes the
        // expected revision JSON. This check/update section has no await, just
        // like one atomic UPDATE statement.
        const shopId = where.params.find((value) =>
          typeof value === "number" && rows.has(value)
        ) as number | undefined;
        const revisionParam = where.params.find((value) =>
          typeof value === "string" && /^\d+$/.test(value)
        ) as string | undefined;
        const expectedRevision = revisionParam == null ? NaN : Number(revisionParam);
        const row = shopId == null ? undefined : rows.get(shopId);
        const storedRevision = row?.settings?.autoflow?.workflowRevision ?? 0;
        if (!row || storedRevision !== expectedRevision) return [];

        const payloadText = set.params.find((value) =>
          typeof value === "string" && value.includes("workflowRevision")
        ) as string | undefined;
        assert.ok(payloadText, "generated SET carries workflow payload JSON");
        const payload = JSON.parse(payloadText);
        row.settings = {
          ...(row.settings ?? {}),
          autoflow: {
            ...(row.settings?.autoflow ?? {}),
            ...payload,
          },
        };
        return [{ shopId }];
      },
    };
  },
};

const originalLoad = (Module as any)._load;
(Module as any)._load = function (request: string, parent: any, isMain: boolean) {
  if (request === "@/lib/db/drizzle" || request.endsWith("/lib/db/drizzle")) {
    return { getDb: () => fakeDb };
  }
  return originalLoad.call(this, request, parent, isMain);
};

async function main() {
  const { replaceAutoflowWorkflowIfRevision } = await import(
    "../lib/data/repositories/pg/identity"
  );
  const a = { active: ["Checkin"], closed: ["Close"], excluded: [] };
  const b = { active: ["Estimate"], closed: ["Close"], excluded: [] };

  const [one, two] = await Promise.all([
    replaceAutoflowWorkflowIfRevision(432, a, 0),
    replaceAutoflowWorkflowIfRevision("432", b, 0),
  ]);
  assert.deepEqual(
    [one.matchedCount, two.matchedCount].sort(),
    [0, 1],
    "two saves from the same revision have one winner",
  );
  assert.equal(rows.get(432)?.settings?.autoflow.workflowRevision, 1);
  assert.equal(rows.get(432)?.settings?.autoflow.apiKey, "secret-remains");
  assert.deepEqual(rows.get(432)?.settings?.unrelated, { enabled: true });
  assert.equal(rows.get(432)?.sibling, "untouched");

  const [reset, racingSave] = await Promise.all([
    replaceAutoflowWorkflowIfRevision(432, null, 1),
    replaceAutoflowWorkflowIfRevision(432, a, 1),
  ]);
  assert.deepEqual(
    [reset.matchedCount, racingSave.matchedCount].sort(),
    [0, 1],
    "reset/save races also have one winner",
  );
  assert.equal(rows.get(432)?.settings?.autoflow.workflowRevision, 2);

  const independent = await replaceAutoflowWorkflowIfRevision(900, a, 0);
  assert.equal(independent.matchedCount, 1);
  assert.equal(rows.get(900)?.settings?.autoflow.workflowRevision, 1);
  assert.equal(rows.get(432)?.settings?.autoflow.workflowRevision, 2);

  assert.ok(
    compiled.every(({ whereSql }) =>
      /mos_shop_id/.test(whereSql) &&
      /coalesce/i.test(whereSql) &&
      /workflowRevision/.test(whereSql)
    ),
    "real helper SQL filters by PG shop identity and coalesced workflow revision",
  );
  assert.ok(
    compiled.every(({ setSql }) =>
      /jsonb_set/i.test(setSql) && /autoflow/.test(setSql)
    ),
    "real helper SQL merges only the AutoFlow JSON object",
  );
  console.log("  ✓ PG workflow CAS SQL and races execute offline");
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    (Module as any)._load = originalLoad;
  });