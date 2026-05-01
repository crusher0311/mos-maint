import {
  pgTable,
  serial,
  text,
  timestamp,
  varchar,
  integer,
  jsonb,
  index,
  bigint,
  boolean,
} from "drizzle-orm/pg-core";

/**
 * Tekmetric Open-Jobs Migration — persistence layer.
 *
 * Ports the proven HCAC migration console snippets in
 * `scripts/one-off/tekmetric-open-jobs-migration-2026-04-30/` into a
 * platform-admin-only Detect Dog feature. One row in
 * `tekmetric_migration_runs` per (sourceShopId → destShopId) attempt;
 * dump JSON, mapping JSON, and per-step audit entries are linked by runId.
 *
 * Retention: dump and mapping rows carry an `expires_at` column populated
 * 30 days after creation. PII (customer name / phone / email / VIN) lives
 * in `dump.payload` so a nightly purge job can DELETE WHERE expires_at <
 * NOW() to satisfy the documented 30-day retention policy.
 */

export const tekmetricMigrationRuns = pgTable(
  "tekmetric_migration_runs",
  {
    id: serial("id").primaryKey(),
    // Tekmetric numeric shop ids — bigint to be safe vs Tekmetric ids growing.
    sourceShopId: bigint("source_shop_id", { mode: "number" }).notNull(),
    sourceShopName: varchar("source_shop_name", { length: 255 }),
    destShopId: bigint("dest_shop_id", { mode: "number" }).notNull(),
    destShopName: varchar("dest_shop_name", { length: 255 }),
    // 'created' | 'dumping' | 'dumped' | 'loading_core' | 'loaded_core'
    //  | 'loading_extras' | 'completed' | 'failed'
    status: varchar("status", { length: 50 }).notNull().default("created"),
    // Last phase the orchestrator touched (matches snippet names).
    lastPhase: varchar("last_phase", { length: 50 }),
    // Free-form counts: { rosListed, rosDumped, rosCreated, rosReused,
    //                      rosFailed, jobsCreated, inspectionsCreated,
    //                      photosCreated, photosFailed, overridesNeeded }
    counts: jsonb("counts").notNull().default({}),
    // Last error string (truncated) for at-a-glance triage in the UI.
    lastError: text("last_error"),
    // Operator identity (Mongo user _id or email).
    createdBy: varchar("created_by", { length: 255 }).notNull(),
    createdByEmail: varchar("created_by_email", { length: 255 }),
    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    sourceShopIdx: index("tek_mig_runs_source_shop_idx").on(
      table.sourceShopId,
    ),
    destShopIdx: index("tek_mig_runs_dest_shop_idx").on(table.destShopId),
    statusIdx: index("tek_mig_runs_status_idx").on(table.status),
    createdAtIdx: index("tek_mig_runs_created_at_idx").on(table.createdAt),
  }),
);

export const tekmetricMigrationDumps = pgTable(
  "tekmetric_migration_dumps",
  {
    id: serial("id").primaryKey(),
    runId: integer("run_id")
      .notNull()
      .references(() => tekmetricMigrationRuns.id, { onDelete: "cascade" }),
    // Full Snippet-1 dump payload:
    //   { schema, schemaVersion, dumpedAt, source, counts, repairOrders }
    payload: jsonb("payload").notNull(),
    rosCount: integer("ros_count").notNull().default(0),
    // 30-day retention. Nightly purge: DELETE WHERE expires_at < NOW().
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    runIdx: index("tek_mig_dumps_run_idx").on(table.runId),
    expiresAtIdx: index("tek_mig_dumps_expires_at_idx").on(table.expiresAt),
  }),
);

export const tekmetricMigrationMappings = pgTable(
  "tekmetric_migration_mappings",
  {
    id: serial("id").primaryKey(),
    runId: integer("run_id")
      .notNull()
      .references(() => tekmetricMigrationRuns.id, { onDelete: "cascade" }),
    // Snippet-2 mapping payload:
    //   { schema, schemaVersion, createdAt, source, dest, counts, mapping, failures }
    mapping: jsonb("mapping").notNull(),
    // Separate failures column so the UI can render them without parsing
    // the whole mapping payload.
    failures: jsonb("failures").notNull().default([]),
    successesCount: integer("successes_count").notNull().default(0),
    failuresCount: integer("failures_count").notNull().default(0),
    reusedCount: integer("reused_count").notNull().default(0),
    confirmed: boolean("confirmed").notNull().default(false),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    runIdx: index("tek_mig_mappings_run_idx").on(table.runId),
    expiresAtIdx: index("tek_mig_mappings_expires_at_idx").on(table.expiresAt),
  }),
);

export const tekmetricMigrationAudit = pgTable(
  "tekmetric_migration_audit",
  {
    id: serial("id").primaryKey(),
    runId: integer("run_id")
      .notNull()
      .references(() => tekmetricMigrationRuns.id, { onDelete: "cascade" }),
    phase: varchar("phase", { length: 50 }).notNull(),
    // 'started' | 'progress' | 'finished' | 'error' | 'override-clone' | etc.
    action: varchar("action", { length: 50 }).notNull(),
    // sourceRoId / destRoId / step / error etc.
    details: jsonb("details").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    runIdx: index("tek_mig_audit_run_idx").on(table.runId),
    phaseIdx: index("tek_mig_audit_phase_idx").on(table.phase),
    createdAtIdx: index("tek_mig_audit_created_at_idx").on(table.createdAt),
  }),
);
