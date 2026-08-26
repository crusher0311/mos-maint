import postgres from "postgres";
import { checkMissedOpportunityMongoIndexes } from "../lib/data/repositories/missed-opportunities";

const REQUIRED_INDEXES = {
  work_order_range: [
    "normalized_work_orders USING btree (shop_id, COALESCE(closed_date, completed_date))",
  ],
  payment_parent_join: [
    "normalized_payments USING btree (shop_id, work_order_id)",
    "normalized_payments USING btree (work_order_id)",
  ],
  service_job_parent_join: [
    "normalized_service_jobs USING btree (shop_id, work_order_id)",
    "normalized_service_jobs USING btree (work_order_id)",
  ],
  line_item_parent_join: [
    "normalized_line_items USING btree (service_job_id)",
  ],
  cached_plan_lookup: [
    "cached_plans_pkey USING btree (shop_id, vin)",
    "cached_plans USING btree (shop_id, vin)",
  ],
  recommendation_event_range: [
    "recommendation_events USING btree (shop_id, received_at)",
  ],
} as const;

const RECOMMENDED_INDEXES = {
  plan_view_range: [
    "viewed_vins USING btree (shop_id, last_viewed_at)",
  ],
} as const;

const REQUIRED_TABLES = [
  "normalized_work_orders",
  "normalized_payments",
  "normalized_service_jobs",
  "normalized_line_items",
  "cached_plans",
  "recommendation_events",
  "viewed_vins",
] as const;

async function main() {
  const connectionString = process.env.DATAONE_DATABASE_URL || process.env.DATABASE_URL;
  if (!connectionString) throw new Error("Missing DATAONE_DATABASE_URL or DATABASE_URL");
  const schema = process.env.REPORTING_DATABASE_SCHEMA || "public";

  const sql = postgres(connectionString, {
    max: 1,
    connect_timeout: 15,
    idle_timeout: 5,
    connection: { application_name: "reporting-readiness-read-only" },
  });
  try {
    await sql`SET default_transaction_read_only = on`;
    const rows = await sql<{
      indexname: string;
      indexdef: string;
      indisvalid: boolean;
      indisready: boolean;
    }[]>`
      SELECT idx.relname AS indexname,
        pg_get_indexdef(i.indexrelid) AS indexdef,
        i.indisvalid,
        i.indisready
      FROM pg_index i
      JOIN pg_class idx ON idx.oid=i.indexrelid
      JOIN pg_class tbl ON tbl.oid=i.indrelid
      JOIN pg_namespace ns ON ns.oid=tbl.relnamespace
      WHERE ns.nspname=${schema}
        AND tbl.relname=ANY(${sql.array([...REQUIRED_TABLES])})
      ORDER BY idx.relname
    `;
    const failures: string[] = [];
    const readyRows = rows
      .filter((row) => row.indisvalid && row.indisready)
      .map((row) => ({
        ...row,
        normalizedDefinition: row.indexdef
          .replaceAll('"', "")
          .replaceAll(`${schema}.`, "")
          .replace(/\s+/g, " "),
      }));

    for (const [requirement, expectedShapes] of Object.entries(REQUIRED_INDEXES)) {
      const match = readyRows.find((row) =>
        expectedShapes.some((shape) => row.normalizedDefinition.includes(shape)),
      );
      console.log(`${match ? "OK" : "MISSING_OR_INVALID"} ${requirement}${match ? ` (${match.indexname})` : ""}`);
      if (!match) failures.push(requirement);
    }
    for (const [requirement, expectedShapes] of Object.entries(RECOMMENDED_INDEXES)) {
      const match = readyRows.find((row) =>
        expectedShapes.some((shape) => row.normalizedDefinition.includes(shape)),
      );
      console.log(`${match ? "OK" : "OPTIONAL_MISSING"} ${requirement}${match ? ` (${match.indexname})` : ""}`);
    }
    const mongo = await checkMissedOpportunityMongoIndexes();
    console.log(`${mongo.reportCache ? "OK" : "MISSING"} missed_opportunity_report_cache_index`);
    console.log(`${mongo.planCache ? "OK" : "MISSING"} missed_opportunity_plan_cache_index`);
    if (!mongo.reportCache) failures.push("missed_opportunity_report_cache_index");
    if (!mongo.planCache) failures.push("missed_opportunity_plan_cache_index");
    if (failures.length) {
      console.error(
        "Reporting prerequisites are incomplete. Have an operator apply the relevant concurrent index migrations; this check never changes the database.",
      );
      process.exitCode = 1;
    } else {
      console.log("Required reporting query indexes are ready. Optional stages remain deadline-bounded. No database changes were made.");
    }
    console.log("Readiness check completed without changing PostgreSQL or MongoDB.");
  } finally {
    await sql.end();
  }
}

main()
  .then(() => process.exit(process.exitCode ?? 0))
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });