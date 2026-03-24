import {
  pgTable,
  text,
  varchar,
  timestamp,
  integer,
  boolean,
  index,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { crmAgencies, crmParentOrganizations, crmAccounts, crmLocations } from "./crm-accounts";

export const crmContacts = pgTable("crm_contacts", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  firstName: text("first_name").notNull(),
  lastName: text("last_name").notNull(),
  email: text("email"),
  phone: text("phone"),
  mobile: text("mobile"),
  title: text("title"),
  department: text("department"),
  status: text("status").notNull().default("Active"),
  avatar: text("avatar"),
  notes: text("notes"),
  address: text("address"),
  city: text("city"),
  state: text("state"),
  zip: text("zip"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
  archivedAt: timestamp("archived_at"),
}, (table) => ({
  statusIdx: index("crm_contacts_status_idx").on(table.status),
  emailIdx: index("crm_contacts_email_idx").on(table.email),
  nameIdx: index("crm_contacts_name_idx").on(table.lastName, table.firstName),
}));

export const crmContactRoleTypes = pgTable("crm_contact_role_types", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  name: text("name").notNull().unique(),
  description: text("description"),
  sortOrder: integer("sort_order").default(0),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const crmContactAgencyAssignments = pgTable("crm_contact_agency_assignments", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  contactId: varchar("contact_id").notNull().references(() => crmContacts.id, { onDelete: "cascade" }),
  agencyId: varchar("agency_id").notNull().references(() => crmAgencies.id, { onDelete: "cascade" }),
  roleTypeId: varchar("role_type_id").references(() => crmContactRoleTypes.id),
  isPrimary: boolean("is_primary").default(false),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => ({
  contactIdx: index("crm_contact_agency_assign_contact_idx").on(table.contactId),
  agencyIdx: index("crm_contact_agency_assign_agency_idx").on(table.agencyId),
}));

export const crmContactParentOrgAssignments = pgTable("crm_contact_parent_org_assignments", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  contactId: varchar("contact_id").notNull().references(() => crmContacts.id, { onDelete: "cascade" }),
  parentOrgId: varchar("parent_org_id").notNull().references(() => crmParentOrganizations.id, { onDelete: "cascade" }),
  roleTypeId: varchar("role_type_id").references(() => crmContactRoleTypes.id),
  isPrimary: boolean("is_primary").default(false),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => ({
  contactIdx: index("crm_contact_parent_org_assign_contact_idx").on(table.contactId),
  parentOrgIdx: index("crm_contact_parent_org_assign_org_idx").on(table.parentOrgId),
}));

export const crmContactAccountAssignments = pgTable("crm_contact_account_assignments", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  contactId: varchar("contact_id").notNull().references(() => crmContacts.id, { onDelete: "cascade" }),
  accountId: varchar("account_id").notNull().references(() => crmAccounts.id, { onDelete: "cascade" }),
  roleTypeId: varchar("role_type_id").references(() => crmContactRoleTypes.id),
  isPrimary: boolean("is_primary").default(false),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => ({
  contactIdx: index("crm_contact_account_assign_contact_idx").on(table.contactId),
  accountIdx: index("crm_contact_account_assign_account_idx").on(table.accountId),
}));

export const crmContactLocationAssignments = pgTable("crm_contact_location_assignments", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  contactId: varchar("contact_id").notNull().references(() => crmContacts.id, { onDelete: "cascade" }),
  locationId: varchar("location_id").notNull().references(() => crmLocations.id, { onDelete: "cascade" }),
  roleTypeId: varchar("role_type_id").references(() => crmContactRoleTypes.id),
  isPrimary: boolean("is_primary").default(false),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => ({
  contactIdx: index("crm_contact_location_assign_contact_idx").on(table.contactId),
  locationIdx: index("crm_contact_location_assign_loc_idx").on(table.locationId),
}));

export const crmEntityNotes = pgTable("crm_entity_notes", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  entityType: text("entity_type").notNull(),
  entityId: varchar("entity_id").notNull(),
  content: text("content").notNull(),
  createdBy: text("created_by"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (table) => ({
  entityIdx: index("crm_entity_notes_entity_idx").on(table.entityType, table.entityId),
}));

export const crmEntityTasks = pgTable("crm_entity_tasks", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  entityType: text("entity_type").notNull(),
  entityId: varchar("entity_id").notNull(),
  title: text("title").notNull(),
  description: text("description"),
  status: text("status").notNull().default("Open"),
  priority: text("priority").notNull().default("Medium"),
  dueDate: timestamp("due_date"),
  assignedTo: text("assigned_to"),
  createdBy: text("created_by"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
  completedAt: timestamp("completed_at"),
}, (table) => ({
  entityIdx: index("crm_entity_tasks_entity_idx").on(table.entityType, table.entityId),
  statusIdx: index("crm_entity_tasks_status_idx").on(table.status),
}));

export type CrmContact = typeof crmContacts.$inferSelect;
export type CrmContactRoleType = typeof crmContactRoleTypes.$inferSelect;
export type CrmContactAgencyAssignment = typeof crmContactAgencyAssignments.$inferSelect;
export type CrmContactParentOrgAssignment = typeof crmContactParentOrgAssignments.$inferSelect;
export type CrmContactAccountAssignment = typeof crmContactAccountAssignments.$inferSelect;
export type CrmContactLocationAssignment = typeof crmContactLocationAssignments.$inferSelect;
export type CrmEntityNote = typeof crmEntityNotes.$inferSelect;
export type CrmEntityTask = typeof crmEntityTasks.$inferSelect;
