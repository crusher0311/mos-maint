import {
  pgTable,
  text,
  varchar,
  timestamp,
  integer,
  boolean,
  jsonb,
  index,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { crmLocations, crmUserTypes } from "./crm-accounts";

export const onboardingStages = pgTable("onboarding_stages", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  name: text("name").notNull(),
  description: text("description"),
  color: text("color").default("#3c81c3"),
  sortOrder: integer("sort_order").notNull().default(0),
  isDefault: boolean("is_default").default(false),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  archivedAt: timestamp("archived_at"),
});

export const onboardingStageAssignments = pgTable("onboarding_stage_assignments", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  stageId: varchar("stage_id").notNull().references(() => onboardingStages.id, { onDelete: "cascade" }),
  assigneeEmail: text("assignee_email"),
  assigneeName: text("assignee_name"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => ({
  stageIdx: index("ob_stage_assignments_stage_idx").on(table.stageId),
}));

export const onboardingSteps = pgTable("onboarding_steps", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  name: text("name").notNull(),
  description: text("description"),
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  archivedAt: timestamp("archived_at"),
});

export const onboardingStageSteps = pgTable("onboarding_stage_steps", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  stageId: varchar("stage_id").notNull().references(() => onboardingStages.id, { onDelete: "cascade" }),
  stepId: varchar("step_id").notNull().references(() => onboardingSteps.id, { onDelete: "cascade" }),
  sortOrder: integer("sort_order").notNull().default(0),
}, (table) => ({
  stageIdx: index("ob_stage_steps_stage_idx").on(table.stageId),
  stepIdx: index("ob_stage_steps_step_idx").on(table.stepId),
}));

export const onboardingChecklists = pgTable("onboarding_checklists", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  name: text("name").notNull(),
  description: text("description"),
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  archivedAt: timestamp("archived_at"),
});

export const onboardingStepChecklists = pgTable("onboarding_step_checklists", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  stepId: varchar("step_id").notNull().references(() => onboardingSteps.id, { onDelete: "cascade" }),
  checklistId: varchar("checklist_id").notNull().references(() => onboardingChecklists.id, { onDelete: "cascade" }),
  sortOrder: integer("sort_order").notNull().default(0),
}, (table) => ({
  stepIdx: index("ob_step_checklists_step_idx").on(table.stepId),
  checklistIdx: index("ob_step_checklists_checklist_idx").on(table.checklistId),
}));

export const onboardingCards = pgTable("onboarding_cards", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  locationId: varchar("location_id").notNull().references(() => crmLocations.id, { onDelete: "cascade" }),
  stageId: varchar("stage_id").notNull().references(() => onboardingStages.id),
  assigneeEmail: text("assignee_email"),
  assigneeName: text("assignee_name"),
  notes: text("notes"),
  priority: text("priority").default("normal"),
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (table) => ({
  locationIdx: index("ob_cards_location_idx").on(table.locationId),
  stageIdx: index("ob_cards_stage_idx").on(table.stageId),
}));

export const onboardingCardProgress = pgTable("onboarding_card_progress", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  cardId: varchar("card_id").notNull().references(() => onboardingCards.id, { onDelete: "cascade" }),
  stepId: varchar("step_id").references(() => onboardingSteps.id),
  checklistId: varchar("checklist_id").references(() => onboardingChecklists.id),
  completed: boolean("completed").notNull().default(false),
  completedBy: text("completed_by"),
  completedAt: timestamp("completed_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => ({
  cardIdx: index("ob_card_progress_card_idx").on(table.cardId),
  stepIdx: index("ob_card_progress_step_idx").on(table.stepId),
}));

export const tours = pgTable("tours", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  name: text("name").notNull(),
  description: text("description"),
  targetPage: text("target_page"),
  status: text("status").notNull().default("draft"),
  steps: jsonb("steps").$type<Array<{ title: string; content: string; target?: string; placement?: string }>>().default(sql`'[]'::jsonb`),
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
  archivedAt: timestamp("archived_at"),
});

export const userTourProgress = pgTable("user_tour_progress", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").notNull(),
  tourId: varchar("tour_id").notNull().references(() => tours.id, { onDelete: "cascade" }),
  completed: boolean("completed").notNull().default(false),
  completedAt: timestamp("completed_at"),
  dismissed: boolean("dismissed").default(false),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => ({
  userIdx: index("user_tour_progress_user_idx").on(table.userId),
  tourIdx: index("user_tour_progress_tour_idx").on(table.tourId),
}));

export const onboardingGuidesContent = pgTable("onboarding_guides_content", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  title: text("title").notNull(),
  description: text("description"),
  category: text("category"),
  status: text("status").notNull().default("draft"),
  steps: jsonb("steps").$type<Array<{ title: string; content: string; imageUrl?: string }>>().default(sql`'[]'::jsonb`),
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
  archivedAt: timestamp("archived_at"),
});

export const userOnboardingGuideProgress = pgTable("user_onboarding_guide_progress", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").notNull(),
  guideId: varchar("guide_id").notNull().references(() => onboardingGuidesContent.id, { onDelete: "cascade" }),
  completed: boolean("completed").notNull().default(false),
  completedAt: timestamp("completed_at"),
  currentStep: integer("current_step").default(0),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => ({
  userIdx: index("user_guide_progress_user_idx").on(table.userId),
  guideIdx: index("user_guide_progress_guide_idx").on(table.guideId),
}));

export const workflowSequences = pgTable("workflow_sequences", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  name: text("name").notNull(),
  description: text("description"),
  triggerEvent: text("trigger_event"),
  status: text("status").notNull().default("draft"),
  steps: jsonb("steps").$type<Array<{ action: string; delayMinutes?: number; config?: Record<string, any> }>>().default(sql`'[]'::jsonb`),
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
  archivedAt: timestamp("archived_at"),
});

export const userWorkflowSequenceProgress = pgTable("user_workflow_sequence_progress", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").notNull(),
  sequenceId: varchar("sequence_id").notNull().references(() => workflowSequences.id, { onDelete: "cascade" }),
  currentStep: integer("current_step").default(0),
  status: text("status").notNull().default("pending"),
  startedAt: timestamp("started_at"),
  completedAt: timestamp("completed_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => ({
  userIdx: index("user_workflow_progress_user_idx").on(table.userId),
  sequenceIdx: index("user_workflow_progress_seq_idx").on(table.sequenceId),
}));

export const banners = pgTable("banners", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  title: text("title").notNull(),
  message: text("message").notNull(),
  type: text("type").notNull().default("info"),
  linkUrl: text("link_url"),
  linkText: text("link_text"),
  status: text("status").notNull().default("draft"),
  startsAt: timestamp("starts_at"),
  endsAt: timestamp("ends_at"),
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
  archivedAt: timestamp("archived_at"),
});

export const userBannerProgress = pgTable("user_banner_progress", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").notNull(),
  bannerId: varchar("banner_id").notNull().references(() => banners.id, { onDelete: "cascade" }),
  dismissed: boolean("dismissed").notNull().default(false),
  dismissedAt: timestamp("dismissed_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => ({
  userIdx: index("user_banner_progress_user_idx").on(table.userId),
  bannerIdx: index("user_banner_progress_banner_idx").on(table.bannerId),
}));

export const userFavorites = pgTable("user_favorites", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").notNull(),
  itemType: text("item_type").notNull(),
  itemId: varchar("item_id").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => ({
  userIdx: index("user_favorites_user_idx").on(table.userId),
  itemIdx: index("user_favorites_item_idx").on(table.itemType, table.itemId),
}));

export const contentAssignments = pgTable("content_assignments", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  contentType: text("content_type").notNull(),
  contentId: varchar("content_id").notNull(),
  userTypeId: varchar("user_type_id").references(() => crmUserTypes.id, { onDelete: "cascade" }),
  assignAll: boolean("assign_all").default(false),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => ({
  contentIdx: index("content_assignments_content_idx").on(table.contentType, table.contentId),
  userTypeIdx: index("content_assignments_user_type_idx").on(table.userTypeId),
}));

export type OnboardingStage = typeof onboardingStages.$inferSelect;
export type OnboardingStageAssignment = typeof onboardingStageAssignments.$inferSelect;
export type OnboardingStep = typeof onboardingSteps.$inferSelect;
export type OnboardingStageStep = typeof onboardingStageSteps.$inferSelect;
export type OnboardingChecklist = typeof onboardingChecklists.$inferSelect;
export type OnboardingStepChecklist = typeof onboardingStepChecklists.$inferSelect;
export type OnboardingCard = typeof onboardingCards.$inferSelect;
export type OnboardingCardProgress = typeof onboardingCardProgress.$inferSelect;
export type Tour = typeof tours.$inferSelect;
export type UserTourProgress = typeof userTourProgress.$inferSelect;
export type OnboardingGuideContent = typeof onboardingGuidesContent.$inferSelect;
export type UserOnboardingGuideProgress = typeof userOnboardingGuideProgress.$inferSelect;
export type WorkflowSequence = typeof workflowSequences.$inferSelect;
export type UserWorkflowSequenceProgress = typeof userWorkflowSequenceProgress.$inferSelect;
export type Banner = typeof banners.$inferSelect;
export type UserBannerProgress = typeof userBannerProgress.$inferSelect;
export type UserFavorite = typeof userFavorites.$inferSelect;
export type ContentAssignment = typeof contentAssignments.$inferSelect;
