// Sales coaching trainer tables (task #987, feature/sales-coach branch).
// Mirrored in drizzle/0023_task987_sales_coach.sql and
// scripts/apply-normalized-migration.ts (hand-written migration path —
// db:generate is dead, see replit.md / drizzle-migration-path memory).
import {
  pgTable,
  varchar,
  text,
  integer,
  jsonb,
  timestamp,
  index,
  uniqueIndex,
  customType,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

// postgres-js returns bytea columns as Buffer / Uint8Array.
const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType() {
    return "bytea";
  },
});

export type SalesCoachScenarioType = "declined_work" | "large_estimate" | "routine";

export interface SalesCoachScenarioJob {
  title: string;
  status: string;
  total: number;
  laborTotal: number;
  partsTotal: number;
  laborHours: number | null;
  declined: boolean;
  declineReason: string | null;
}

export interface SalesCoachScenarioContext {
  vehicle: { year?: number; make?: string; model?: string } | null;
  customerFirstName: string | null;
  customerConcern: string | null;
  odometerIn: number | null;
  workOrderNumber: string | null;
  grandTotal: number;
  jobs: SalesCoachScenarioJob[];
  declinedTotal: number;
  provider: string | null;
  closedDate: string | null;
}

export const salesCoachScenarios = pgTable("sales_coach_scenarios", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  // UTC day the scenario was served for, "YYYY-MM-DD".
  scenarioDate: text("scenario_date").notNull(),
  scenarioType: text("scenario_type").notNull(),
  shopId: integer("shop_id").notNull(),
  // normalized_work_orders.id — unique so an RO is never re-served.
  workOrderId: varchar("work_order_id").notNull(),
  workOrderNumber: text("work_order_number"),
  context: jsonb("context").$type<SalesCoachScenarioContext>().notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => ({
  workOrderIdIdx: uniqueIndex("scs_work_order_id_idx").on(t.workOrderId),
  scenarioDateIdx: index("scs_scenario_date_idx").on(t.scenarioDate),
}));

export interface SalesCoachFeedback {
  score: number;
  summary: string;
  whatWorked: string[];
  toImprove: string[];
  suggestedPhrasing: string;
}

// Dashboard sales-script feature: structured script generated from an open
// estimate, cached per (workOrderId, contextHash) so repeat views are free
// and a changed estimate regenerates.
export interface SalesScript {
  opening: string;
  concernAcknowledgment: string | null;
  valuePoints: { job: string; talkingPoint: string }[];
  totalPresentation: string;
  deferredRecovery: string | null;
  close: string;
  fullScript: string;
}

export const salesScriptCache = pgTable("sales_script_cache", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  shopId: integer("shop_id").notNull(),
  workOrderId: varchar("work_order_id").notNull(),
  contextHash: text("context_hash").notNull(),
  script: jsonb("script").$type<SalesScript>().notNull(),
  model: text("model"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => ({
  woHashIdx: uniqueIndex("ssc_wo_hash_idx").on(t.workOrderId, t.contextHash),
  shopIdIdx: index("ssc_shop_id_idx").on(t.shopId),
}));

export const salesCoachSessions = pgTable("sales_coach_sessions", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  scenarioId: varchar("scenario_id").notNull().references(() => salesCoachScenarios.id),
  userEmail: text("user_email").notNull(),
  audio: bytea("audio"),
  audioMime: text("audio_mime"),
  audioBytes: integer("audio_bytes"),
  durationSec: integer("duration_sec"),
  transcript: text("transcript"),
  transcriptionProvider: text("transcription_provider"),
  feedback: jsonb("feedback").$type<SalesCoachFeedback>(),
  score: integer("score"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => ({
  scenarioIdIdx: index("scsn_scenario_id_idx").on(t.scenarioId),
  createdAtIdx: index("scsn_created_at_idx").on(t.createdAt),
}));
