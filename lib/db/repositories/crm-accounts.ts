import { getDb } from "../drizzle";
import {
  crmAgencies,
  crmCorporateBranding,
  crmBrandingThemes,
  crmParentOrganizations,
  crmAccounts,
  crmLocations,
  crmUserTypes,
  crmAgencyPricingPackages,
} from "../schema";
import { eq, ilike, and, isNull, desc, asc, or, sql } from "drizzle-orm";

export class CrmAgencyRepository {
  private get db() { return getDb(); }

  async list(opts?: { status?: string; search?: string; includeArchived?: boolean }) {
    const conditions = [];
    if (!opts?.includeArchived) conditions.push(isNull(crmAgencies.archivedAt));
    if (opts?.status) conditions.push(eq(crmAgencies.status, opts.status));
    if (opts?.search) conditions.push(or(
      ilike(crmAgencies.name, `%${opts.search}%`),
      ilike(crmAgencies.slug, `%${opts.search}%`),
      ilike(crmAgencies.contactEmail, `%${opts.search}%`)
    ));
    return this.db.select().from(crmAgencies)
      .where(conditions.length ? and(...conditions) : undefined)
      .orderBy(asc(crmAgencies.name));
  }

  async getById(id: string) {
    const rows = await this.db.select().from(crmAgencies).where(eq(crmAgencies.id, id)).limit(1);
    return rows[0] || null;
  }

  async create(data: Omit<typeof crmAgencies.$inferInsert, "id" | "createdAt">) {
    const rows = await this.db.insert(crmAgencies).values(data).returning();
    return rows[0];
  }

  async update(id: string, data: Partial<typeof crmAgencies.$inferInsert>) {
    const rows = await this.db.update(crmAgencies).set(data).where(eq(crmAgencies.id, id)).returning();
    return rows[0];
  }

  async archive(id: string) {
    return this.update(id, { archivedAt: new Date() } as any);
  }

  async restore(id: string) {
    return this.update(id, { archivedAt: null } as any);
  }
}

export class CrmCorporateBrandingRepository {
  private get db() { return getDb(); }

  async get() {
    const rows = await this.db.select().from(crmCorporateBranding).limit(1);
    return rows[0] || null;
  }

  async upsert(data: Partial<typeof crmCorporateBranding.$inferInsert>) {
    const existing = await this.get();
    if (existing) {
      const rows = await this.db.update(crmCorporateBranding)
        .set({ ...data, updatedAt: new Date() })
        .where(eq(crmCorporateBranding.id, existing.id))
        .returning();
      return rows[0];
    }
    const rows = await this.db.insert(crmCorporateBranding).values(data as any).returning();
    return rows[0];
  }
}

export class CrmBrandingThemeRepository {
  private get db() { return getDb(); }

  async list() {
    return this.db.select().from(crmBrandingThemes).orderBy(asc(crmBrandingThemes.name));
  }

  async getById(id: string) {
    const rows = await this.db.select().from(crmBrandingThemes).where(eq(crmBrandingThemes.id, id)).limit(1);
    return rows[0] || null;
  }

  async create(data: Omit<typeof crmBrandingThemes.$inferInsert, "id" | "createdAt">) {
    const rows = await this.db.insert(crmBrandingThemes).values(data).returning();
    return rows[0];
  }

  async update(id: string, data: Partial<typeof crmBrandingThemes.$inferInsert>) {
    const rows = await this.db.update(crmBrandingThemes).set(data).where(eq(crmBrandingThemes.id, id)).returning();
    return rows[0];
  }

  async delete(id: string) {
    return this.db.delete(crmBrandingThemes).where(and(eq(crmBrandingThemes.id, id), eq(crmBrandingThemes.isLocked, false)));
  }
}

export class CrmParentOrgRepository {
  private get db() { return getDb(); }

  async list(opts?: { agencyId?: string; status?: string; search?: string; includeArchived?: boolean }) {
    const conditions = [];
    if (!opts?.includeArchived) conditions.push(isNull(crmParentOrganizations.archivedAt));
    if (opts?.agencyId) conditions.push(eq(crmParentOrganizations.agencyId, opts.agencyId));
    if (opts?.status) conditions.push(eq(crmParentOrganizations.status, opts.status));
    if (opts?.search) conditions.push(ilike(crmParentOrganizations.name, `%${opts.search}%`));
    return this.db.select().from(crmParentOrganizations)
      .where(conditions.length ? and(...conditions) : undefined)
      .orderBy(asc(crmParentOrganizations.name));
  }

  async getById(id: string) {
    const rows = await this.db.select().from(crmParentOrganizations).where(eq(crmParentOrganizations.id, id)).limit(1);
    return rows[0] || null;
  }

  async create(data: Omit<typeof crmParentOrganizations.$inferInsert, "id" | "createdAt">) {
    const rows = await this.db.insert(crmParentOrganizations).values(data).returning();
    return rows[0];
  }

  async update(id: string, data: Partial<typeof crmParentOrganizations.$inferInsert>) {
    const rows = await this.db.update(crmParentOrganizations).set(data).where(eq(crmParentOrganizations.id, id)).returning();
    return rows[0];
  }

  async archive(id: string) {
    return this.update(id, { archivedAt: new Date() } as any);
  }
}

export class CrmAccountRepository {
  private get db() { return getDb(); }

  async list(opts?: { parentOrgId?: string; agencyId?: string; status?: string; plan?: string; search?: string; includeArchived?: boolean }) {
    const conditions = [];
    if (!opts?.includeArchived) conditions.push(isNull(crmAccounts.archivedAt));
    if (opts?.parentOrgId) conditions.push(eq(crmAccounts.parentOrganizationId, opts.parentOrgId));
    if (opts?.agencyId) conditions.push(eq(crmAccounts.agencyId, opts.agencyId));
    if (opts?.status) conditions.push(eq(crmAccounts.status, opts.status));
    if (opts?.plan) conditions.push(eq(crmAccounts.plan, opts.plan));
    if (opts?.search) conditions.push(ilike(crmAccounts.name, `%${opts.search}%`));
    return this.db.select().from(crmAccounts)
      .where(conditions.length ? and(...conditions) : undefined)
      .orderBy(asc(crmAccounts.name));
  }

  async getById(id: string) {
    const rows = await this.db.select().from(crmAccounts).where(eq(crmAccounts.id, id)).limit(1);
    return rows[0] || null;
  }

  async create(data: Omit<typeof crmAccounts.$inferInsert, "id" | "createdAt">) {
    const rows = await this.db.insert(crmAccounts).values(data).returning();
    return rows[0];
  }

  async update(id: string, data: Partial<typeof crmAccounts.$inferInsert>) {
    const rows = await this.db.update(crmAccounts).set(data).where(eq(crmAccounts.id, id)).returning();
    return rows[0];
  }

  async archive(id: string) {
    return this.update(id, { archivedAt: new Date() } as any);
  }

  async getStats() {
    const result = await this.db.select({
      total: sql<number>`count(*)::int`,
      active: sql<number>`count(*) filter (where ${crmAccounts.status} = 'Active')::int`,
      inactive: sql<number>`count(*) filter (where ${crmAccounts.status} != 'Active')::int`,
    }).from(crmAccounts).where(isNull(crmAccounts.archivedAt));
    return result[0];
  }
}

export class CrmLocationRepository {
  private get db() { return getDb(); }

  async list(opts?: { accountId?: string; search?: string; includeArchived?: boolean }) {
    const conditions = [];
    if (!opts?.includeArchived) conditions.push(isNull(crmLocations.archivedAt));
    if (opts?.accountId) conditions.push(eq(crmLocations.accountId, opts.accountId));
    if (opts?.search) conditions.push(or(
      ilike(crmLocations.name, `%${opts.search}%`),
      ilike(crmLocations.city, `%${opts.search}%`)
    ));
    return this.db.select().from(crmLocations)
      .where(conditions.length ? and(...conditions) : undefined)
      .orderBy(asc(crmLocations.name));
  }

  async getById(id: string) {
    const rows = await this.db.select().from(crmLocations).where(eq(crmLocations.id, id)).limit(1);
    return rows[0] || null;
  }

  async create(data: Omit<typeof crmLocations.$inferInsert, "id" | "createdAt">) {
    const rows = await this.db.insert(crmLocations).values(data).returning();
    return rows[0];
  }

  async update(id: string, data: Partial<typeof crmLocations.$inferInsert>) {
    const rows = await this.db.update(crmLocations).set(data).where(eq(crmLocations.id, id)).returning();
    return rows[0];
  }

  async archive(id: string) {
    return this.update(id, { archivedAt: new Date() } as any);
  }
}

export class CrmUserTypeRepository {
  private get db() { return getDb(); }

  async list(opts?: { bucket?: string }) {
    const conditions = [];
    if (opts?.bucket) conditions.push(eq(crmUserTypes.bucket, opts.bucket));
    return this.db.select().from(crmUserTypes)
      .where(conditions.length ? and(...conditions) : undefined)
      .orderBy(asc(crmUserTypes.sortOrder), asc(crmUserTypes.name));
  }

  async getById(id: string) {
    const rows = await this.db.select().from(crmUserTypes).where(eq(crmUserTypes.id, id)).limit(1);
    return rows[0] || null;
  }

  async create(data: Omit<typeof crmUserTypes.$inferInsert, "id" | "createdAt">) {
    const rows = await this.db.insert(crmUserTypes).values(data).returning();
    return rows[0];
  }

  async update(id: string, data: Partial<typeof crmUserTypes.$inferInsert>) {
    const rows = await this.db.update(crmUserTypes).set(data).where(eq(crmUserTypes.id, id)).returning();
    return rows[0];
  }

  async delete(id: string) {
    return this.db.delete(crmUserTypes).where(eq(crmUserTypes.id, id));
  }
}

export class CrmAgencyPricingRepository {
  private get db() { return getDb(); }

  async listByAgency(agencyId: string) {
    return this.db.select().from(crmAgencyPricingPackages)
      .where(eq(crmAgencyPricingPackages.agencyId, agencyId))
      .orderBy(asc(crmAgencyPricingPackages.sortOrder));
  }

  async create(data: Omit<typeof crmAgencyPricingPackages.$inferInsert, "id" | "createdAt">) {
    const rows = await this.db.insert(crmAgencyPricingPackages).values(data).returning();
    return rows[0];
  }

  async update(id: string, data: Partial<typeof crmAgencyPricingPackages.$inferInsert>) {
    const rows = await this.db.update(crmAgencyPricingPackages).set(data).where(eq(crmAgencyPricingPackages.id, id)).returning();
    return rows[0];
  }

  async delete(id: string) {
    return this.db.delete(crmAgencyPricingPackages).where(eq(crmAgencyPricingPackages.id, id));
  }
}

export const agencyRepo = new CrmAgencyRepository();
export const corporateBrandingRepo = new CrmCorporateBrandingRepository();
export const brandingThemeRepo = new CrmBrandingThemeRepository();
export const parentOrgRepo = new CrmParentOrgRepository();
export const accountRepo = new CrmAccountRepository();
export const locationRepo = new CrmLocationRepository();
export const userTypeRepo = new CrmUserTypeRepository();
export const agencyPricingRepo = new CrmAgencyPricingRepository();
