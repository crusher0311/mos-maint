import { getDb } from "../drizzle";
import {
  crmContacts,
  crmContactRoleTypes,
  crmContactAgencyAssignments,
  crmContactParentOrgAssignments,
  crmContactAccountAssignments,
  crmContactLocationAssignments,
  crmEntityNotes,
  crmEntityTasks,
  crmAgencies,
  crmParentOrganizations,
  crmAccounts,
  crmLocations,
} from "../schema";
import { eq, ilike, and, isNull, asc, or, sql, desc, inArray } from "drizzle-orm";

export class CrmContactRepository {
  private get db() { return getDb(); }

  async list(opts?: { status?: string; search?: string; includeArchived?: boolean; agencyId?: string; parentOrgId?: string; accountId?: string; locationId?: string }) {
    const conditions = [];
    if (!opts?.includeArchived) conditions.push(isNull(crmContacts.archivedAt));
    if (opts?.status) conditions.push(eq(crmContacts.status, opts.status));
    if (opts?.search) conditions.push(or(
      ilike(crmContacts.firstName, `%${opts.search}%`),
      ilike(crmContacts.lastName, `%${opts.search}%`),
      ilike(crmContacts.email, `%${opts.search}%`),
      ilike(crmContacts.phone, `%${opts.search}%`),
      ilike(crmContacts.title, `%${opts.search}%`)
    ));

    if (opts?.agencyId) {
      const assignedIds = await this.db.select({ contactId: crmContactAgencyAssignments.contactId })
        .from(crmContactAgencyAssignments).where(eq(crmContactAgencyAssignments.agencyId, opts.agencyId));
      const ids = assignedIds.map(r => r.contactId);
      if (ids.length === 0) return [];
      conditions.push(inArray(crmContacts.id, ids));
    }
    if (opts?.parentOrgId) {
      const assignedIds = await this.db.select({ contactId: crmContactParentOrgAssignments.contactId })
        .from(crmContactParentOrgAssignments).where(eq(crmContactParentOrgAssignments.parentOrgId, opts.parentOrgId));
      const ids = assignedIds.map(r => r.contactId);
      if (ids.length === 0) return [];
      conditions.push(inArray(crmContacts.id, ids));
    }
    if (opts?.accountId) {
      const assignedIds = await this.db.select({ contactId: crmContactAccountAssignments.contactId })
        .from(crmContactAccountAssignments).where(eq(crmContactAccountAssignments.accountId, opts.accountId));
      const ids = assignedIds.map(r => r.contactId);
      if (ids.length === 0) return [];
      conditions.push(inArray(crmContacts.id, ids));
    }
    if (opts?.locationId) {
      const assignedIds = await this.db.select({ contactId: crmContactLocationAssignments.contactId })
        .from(crmContactLocationAssignments).where(eq(crmContactLocationAssignments.locationId, opts.locationId));
      const ids = assignedIds.map(r => r.contactId);
      if (ids.length === 0) return [];
      conditions.push(inArray(crmContacts.id, ids));
    }

    return this.db.select().from(crmContacts)
      .where(conditions.length ? and(...conditions) : undefined)
      .orderBy(asc(crmContacts.lastName), asc(crmContacts.firstName));
  }

  async getById(id: string) {
    const rows = await this.db.select().from(crmContacts).where(eq(crmContacts.id, id)).limit(1);
    return rows[0] || null;
  }

  async create(data: Omit<typeof crmContacts.$inferInsert, "id" | "createdAt" | "updatedAt">) {
    const rows = await this.db.insert(crmContacts).values(data).returning();
    return rows[0];
  }

  async bulkCreate(items: Omit<typeof crmContacts.$inferInsert, "id" | "createdAt" | "updatedAt">[]) {
    if (items.length === 0) return [];
    const rows = await this.db.insert(crmContacts).values(items).returning();
    return rows;
  }

  async update(id: string, data: Partial<typeof crmContacts.$inferInsert>) {
    const rows = await this.db.update(crmContacts).set({ ...data, updatedAt: new Date() }).where(eq(crmContacts.id, id)).returning();
    return rows[0];
  }

  async archive(id: string) {
    return this.update(id, { archivedAt: new Date() } as any);
  }

  async restore(id: string) {
    return this.update(id, { archivedAt: null } as any);
  }

  async getStats() {
    const result = await this.db.select({
      total: sql<number>`count(*)::int`,
      active: sql<number>`count(*) filter (where ${crmContacts.status} = 'Active')::int`,
      inactive: sql<number>`count(*) filter (where ${crmContacts.status} != 'Active')::int`,
    }).from(crmContacts).where(isNull(crmContacts.archivedAt));
    return result[0];
  }

  async getAssignments(contactId: string) {
    const [agencies, parentOrgs, accounts, locations] = await Promise.all([
      this.db.select({
        id: crmContactAgencyAssignments.id,
        agencyId: crmContactAgencyAssignments.agencyId,
        agencyName: crmAgencies.name,
        roleTypeId: crmContactAgencyAssignments.roleTypeId,
        roleName: crmContactRoleTypes.name,
        isPrimary: crmContactAgencyAssignments.isPrimary,
        createdAt: crmContactAgencyAssignments.createdAt,
      }).from(crmContactAgencyAssignments)
        .leftJoin(crmAgencies, eq(crmContactAgencyAssignments.agencyId, crmAgencies.id))
        .leftJoin(crmContactRoleTypes, eq(crmContactAgencyAssignments.roleTypeId, crmContactRoleTypes.id))
        .where(eq(crmContactAgencyAssignments.contactId, contactId)),
      this.db.select({
        id: crmContactParentOrgAssignments.id,
        parentOrgId: crmContactParentOrgAssignments.parentOrgId,
        parentOrgName: crmParentOrganizations.name,
        roleTypeId: crmContactParentOrgAssignments.roleTypeId,
        roleName: crmContactRoleTypes.name,
        isPrimary: crmContactParentOrgAssignments.isPrimary,
        createdAt: crmContactParentOrgAssignments.createdAt,
      }).from(crmContactParentOrgAssignments)
        .leftJoin(crmParentOrganizations, eq(crmContactParentOrgAssignments.parentOrgId, crmParentOrganizations.id))
        .leftJoin(crmContactRoleTypes, eq(crmContactParentOrgAssignments.roleTypeId, crmContactRoleTypes.id))
        .where(eq(crmContactParentOrgAssignments.contactId, contactId)),
      this.db.select({
        id: crmContactAccountAssignments.id,
        accountId: crmContactAccountAssignments.accountId,
        accountName: crmAccounts.name,
        roleTypeId: crmContactAccountAssignments.roleTypeId,
        roleName: crmContactRoleTypes.name,
        isPrimary: crmContactAccountAssignments.isPrimary,
        createdAt: crmContactAccountAssignments.createdAt,
      }).from(crmContactAccountAssignments)
        .leftJoin(crmAccounts, eq(crmContactAccountAssignments.accountId, crmAccounts.id))
        .leftJoin(crmContactRoleTypes, eq(crmContactAccountAssignments.roleTypeId, crmContactRoleTypes.id))
        .where(eq(crmContactAccountAssignments.contactId, contactId)),
      this.db.select({
        id: crmContactLocationAssignments.id,
        locationId: crmContactLocationAssignments.locationId,
        locationName: crmLocations.name,
        roleTypeId: crmContactLocationAssignments.roleTypeId,
        roleName: crmContactRoleTypes.name,
        isPrimary: crmContactLocationAssignments.isPrimary,
        createdAt: crmContactLocationAssignments.createdAt,
      }).from(crmContactLocationAssignments)
        .leftJoin(crmLocations, eq(crmContactLocationAssignments.locationId, crmLocations.id))
        .leftJoin(crmContactRoleTypes, eq(crmContactLocationAssignments.roleTypeId, crmContactRoleTypes.id))
        .where(eq(crmContactLocationAssignments.contactId, contactId)),
    ]);
    return { agencies, parentOrgs, accounts, locations };
  }

  async addAgencyAssignment(data: { contactId: string; agencyId: string; roleTypeId?: string; isPrimary?: boolean }) {
    const rows = await this.db.insert(crmContactAgencyAssignments).values(data).returning();
    return rows[0];
  }

  async addParentOrgAssignment(data: { contactId: string; parentOrgId: string; roleTypeId?: string; isPrimary?: boolean }) {
    const rows = await this.db.insert(crmContactParentOrgAssignments).values(data).returning();
    return rows[0];
  }

  async addAccountAssignment(data: { contactId: string; accountId: string; roleTypeId?: string; isPrimary?: boolean }) {
    const rows = await this.db.insert(crmContactAccountAssignments).values(data).returning();
    return rows[0];
  }

  async addLocationAssignment(data: { contactId: string; locationId: string; roleTypeId?: string; isPrimary?: boolean }) {
    const rows = await this.db.insert(crmContactLocationAssignments).values(data).returning();
    return rows[0];
  }

  async removeAssignment(type: string, assignmentId: string) {
    const tableMap: Record<string, any> = {
      agency: crmContactAgencyAssignments,
      parentOrg: crmContactParentOrgAssignments,
      account: crmContactAccountAssignments,
      location: crmContactLocationAssignments,
    };
    const table = tableMap[type];
    if (!table) throw new Error("Invalid assignment type");
    return this.db.delete(table).where(eq(table.id, assignmentId));
  }
}

export class CrmContactRoleTypeRepository {
  private get db() { return getDb(); }

  async list() {
    return this.db.select().from(crmContactRoleTypes).orderBy(asc(crmContactRoleTypes.sortOrder), asc(crmContactRoleTypes.name));
  }

  async getById(id: string) {
    const rows = await this.db.select().from(crmContactRoleTypes).where(eq(crmContactRoleTypes.id, id)).limit(1);
    return rows[0] || null;
  }

  async create(data: Omit<typeof crmContactRoleTypes.$inferInsert, "id" | "createdAt">) {
    const rows = await this.db.insert(crmContactRoleTypes).values(data).returning();
    return rows[0];
  }

  async update(id: string, data: Partial<typeof crmContactRoleTypes.$inferInsert>) {
    const rows = await this.db.update(crmContactRoleTypes).set(data).where(eq(crmContactRoleTypes.id, id)).returning();
    return rows[0];
  }

  async delete(id: string) {
    return this.db.delete(crmContactRoleTypes).where(eq(crmContactRoleTypes.id, id));
  }
}

export class CrmEntityNoteRepository {
  private get db() { return getDb(); }

  async listByEntity(entityType: string, entityId: string) {
    return this.db.select().from(crmEntityNotes)
      .where(and(eq(crmEntityNotes.entityType, entityType), eq(crmEntityNotes.entityId, entityId)))
      .orderBy(desc(crmEntityNotes.createdAt));
  }

  async create(data: Omit<typeof crmEntityNotes.$inferInsert, "id" | "createdAt" | "updatedAt">) {
    const rows = await this.db.insert(crmEntityNotes).values(data).returning();
    return rows[0];
  }

  async update(id: string, data: { content: string }) {
    const rows = await this.db.update(crmEntityNotes).set({ ...data, updatedAt: new Date() }).where(eq(crmEntityNotes.id, id)).returning();
    return rows[0];
  }

  async delete(id: string) {
    return this.db.delete(crmEntityNotes).where(eq(crmEntityNotes.id, id));
  }
}

export class CrmEntityTaskRepository {
  private get db() { return getDb(); }

  async listByEntity(entityType: string, entityId: string) {
    return this.db.select().from(crmEntityTasks)
      .where(and(eq(crmEntityTasks.entityType, entityType), eq(crmEntityTasks.entityId, entityId)))
      .orderBy(asc(crmEntityTasks.status), desc(crmEntityTasks.createdAt));
  }

  async create(data: Omit<typeof crmEntityTasks.$inferInsert, "id" | "createdAt" | "updatedAt">) {
    const rows = await this.db.insert(crmEntityTasks).values(data).returning();
    return rows[0];
  }

  async update(id: string, data: Partial<typeof crmEntityTasks.$inferInsert>) {
    const rows = await this.db.update(crmEntityTasks).set({ ...data, updatedAt: new Date() }).where(eq(crmEntityTasks.id, id)).returning();
    return rows[0];
  }

  async complete(id: string) {
    return this.update(id, { status: "Completed", completedAt: new Date() } as any);
  }

  async delete(id: string) {
    return this.db.delete(crmEntityTasks).where(eq(crmEntityTasks.id, id));
  }
}

export const contactRepo = new CrmContactRepository();
export const contactRoleTypeRepo = new CrmContactRoleTypeRepository();
export const entityNoteRepo = new CrmEntityNoteRepository();
export const entityTaskRepo = new CrmEntityTaskRepository();
