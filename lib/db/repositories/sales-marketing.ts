import { getDb } from "../drizzle";
import {
  dealFunnelStages,
  deals,
  campaigns,
  coupons,
  specials,
  messageTemplates,
  pricingPlans,
  products,
  productFeatures,
  promoCodes,
  gettingStartedPackages,
} from "../schema";
import { eq, ilike, and, isNull, asc, or, desc, sql } from "drizzle-orm";

export class DealFunnelStageRepository {
  private get db() { return getDb(); }

  async list(opts?: { includeArchived?: boolean }) {
    const conditions = [];
    if (!opts?.includeArchived) conditions.push(isNull(dealFunnelStages.archivedAt));
    return this.db.select().from(dealFunnelStages)
      .where(conditions.length ? and(...conditions) : undefined)
      .orderBy(asc(dealFunnelStages.sortOrder));
  }

  async getById(id: string) {
    const rows = await this.db.select().from(dealFunnelStages).where(eq(dealFunnelStages.id, id)).limit(1);
    return rows[0] || null;
  }

  async create(data: Omit<typeof dealFunnelStages.$inferInsert, "id" | "createdAt">) {
    const rows = await this.db.insert(dealFunnelStages).values(data).returning();
    return rows[0];
  }

  async update(id: string, data: Partial<typeof dealFunnelStages.$inferInsert>) {
    const rows = await this.db.update(dealFunnelStages).set(data).where(eq(dealFunnelStages.id, id)).returning();
    return rows[0];
  }

  async archive(id: string) {
    return this.update(id, { archivedAt: new Date() } as any);
  }

  async reorder(stages: { id: string; sortOrder: number }[]) {
    for (const s of stages) {
      await this.db.update(dealFunnelStages).set({ sortOrder: s.sortOrder }).where(eq(dealFunnelStages.id, s.id));
    }
  }
}

export class DealRepository {
  private get db() { return getDb(); }

  async list(opts?: { stageId?: string; accountId?: string; search?: string; priority?: string; assignedTo?: string; includeArchived?: boolean }) {
    const conditions = [];
    if (!opts?.includeArchived) conditions.push(isNull(deals.archivedAt));
    if (opts?.stageId) conditions.push(eq(deals.stageId, opts.stageId));
    if (opts?.accountId) conditions.push(eq(deals.accountId, opts.accountId));
    if (opts?.priority) conditions.push(eq(deals.priority, opts.priority));
    if (opts?.assignedTo) conditions.push(eq(deals.assignedTo, opts.assignedTo));
    if (opts?.search) conditions.push(or(
      ilike(deals.title, `%${opts.search}%`),
      ilike(deals.contactName, `%${opts.search}%`),
      ilike(deals.contactEmail, `%${opts.search}%`)
    ));
    return this.db.select().from(deals)
      .where(conditions.length ? and(...conditions) : undefined)
      .orderBy(asc(deals.sortOrder), desc(deals.createdAt));
  }

  async getById(id: string) {
    const rows = await this.db.select().from(deals).where(eq(deals.id, id)).limit(1);
    return rows[0] || null;
  }

  async create(data: Omit<typeof deals.$inferInsert, "id" | "createdAt" | "updatedAt">) {
    const rows = await this.db.insert(deals).values(data).returning();
    return rows[0];
  }

  async update(id: string, data: Partial<typeof deals.$inferInsert>) {
    const rows = await this.db.update(deals).set({ ...data, updatedAt: new Date() }).where(eq(deals.id, id)).returning();
    return rows[0];
  }

  async archive(id: string) {
    return this.update(id, { archivedAt: new Date() } as any);
  }

  async moveToStage(id: string, stageId: string) {
    return this.update(id, { stageId } as any);
  }

  async getStats() {
    const result = await this.db.select({
      total: sql<number>`count(*)::int`,
      totalValue: sql<string>`coalesce(sum(${deals.value}::numeric), 0)::text`,
    }).from(deals).where(isNull(deals.archivedAt));
    return result[0];
  }
}

export class CampaignRepository {
  private get db() { return getDb(); }

  async list(opts?: { status?: string; type?: string; search?: string; includeArchived?: boolean }) {
    const conditions = [];
    if (!opts?.includeArchived) conditions.push(isNull(campaigns.archivedAt));
    if (opts?.status) conditions.push(eq(campaigns.status, opts.status));
    if (opts?.type) conditions.push(eq(campaigns.type, opts.type));
    if (opts?.search) conditions.push(ilike(campaigns.name, `%${opts.search}%`));
    return this.db.select().from(campaigns)
      .where(conditions.length ? and(...conditions) : undefined)
      .orderBy(desc(campaigns.createdAt));
  }

  async getById(id: string) {
    const rows = await this.db.select().from(campaigns).where(eq(campaigns.id, id)).limit(1);
    return rows[0] || null;
  }

  async create(data: Omit<typeof campaigns.$inferInsert, "id" | "createdAt" | "updatedAt">) {
    const rows = await this.db.insert(campaigns).values(data).returning();
    return rows[0];
  }

  async update(id: string, data: Partial<typeof campaigns.$inferInsert>) {
    const rows = await this.db.update(campaigns).set({ ...data, updatedAt: new Date() }).where(eq(campaigns.id, id)).returning();
    return rows[0];
  }

  async archive(id: string) {
    return this.update(id, { archivedAt: new Date() } as any);
  }
}

export class CouponRepository {
  private get db() { return getDb(); }

  async list(opts?: { search?: string; isActive?: boolean; includeArchived?: boolean }) {
    const conditions = [];
    if (!opts?.includeArchived) conditions.push(isNull(coupons.archivedAt));
    if (opts?.isActive !== undefined) conditions.push(eq(coupons.isActive, opts.isActive));
    if (opts?.search) conditions.push(or(
      ilike(coupons.code, `%${opts.search}%`),
      ilike(coupons.name, `%${opts.search}%`)
    ));
    return this.db.select().from(coupons)
      .where(conditions.length ? and(...conditions) : undefined)
      .orderBy(desc(coupons.createdAt));
  }

  async getById(id: string) {
    const rows = await this.db.select().from(coupons).where(eq(coupons.id, id)).limit(1);
    return rows[0] || null;
  }

  async create(data: Omit<typeof coupons.$inferInsert, "id" | "createdAt">) {
    const rows = await this.db.insert(coupons).values(data).returning();
    return rows[0];
  }

  async update(id: string, data: Partial<typeof coupons.$inferInsert>) {
    const rows = await this.db.update(coupons).set(data).where(eq(coupons.id, id)).returning();
    return rows[0];
  }

  async archive(id: string) {
    return this.update(id, { archivedAt: new Date() } as any);
  }
}

export class SpecialRepository {
  private get db() { return getDb(); }

  async list(opts?: { search?: string; type?: string; isActive?: boolean; includeArchived?: boolean }) {
    const conditions = [];
    if (!opts?.includeArchived) conditions.push(isNull(specials.archivedAt));
    if (opts?.type) conditions.push(eq(specials.type, opts.type));
    if (opts?.isActive !== undefined) conditions.push(eq(specials.isActive, opts.isActive));
    if (opts?.search) conditions.push(ilike(specials.name, `%${opts.search}%`));
    return this.db.select().from(specials)
      .where(conditions.length ? and(...conditions) : undefined)
      .orderBy(desc(specials.createdAt));
  }

  async getById(id: string) {
    const rows = await this.db.select().from(specials).where(eq(specials.id, id)).limit(1);
    return rows[0] || null;
  }

  async create(data: Omit<typeof specials.$inferInsert, "id" | "createdAt">) {
    const rows = await this.db.insert(specials).values(data).returning();
    return rows[0];
  }

  async update(id: string, data: Partial<typeof specials.$inferInsert>) {
    const rows = await this.db.update(specials).set(data).where(eq(specials.id, id)).returning();
    return rows[0];
  }

  async archive(id: string) {
    return this.update(id, { archivedAt: new Date() } as any);
  }
}

export class MessageTemplateRepository {
  private get db() { return getDb(); }

  async list(opts?: { channel?: string; category?: string; search?: string; includeArchived?: boolean }) {
    const conditions = [];
    if (!opts?.includeArchived) conditions.push(isNull(messageTemplates.archivedAt));
    if (opts?.channel) conditions.push(eq(messageTemplates.channel, opts.channel));
    if (opts?.category) conditions.push(eq(messageTemplates.category, opts.category));
    if (opts?.search) conditions.push(ilike(messageTemplates.name, `%${opts.search}%`));
    return this.db.select().from(messageTemplates)
      .where(conditions.length ? and(...conditions) : undefined)
      .orderBy(asc(messageTemplates.name));
  }

  async getById(id: string) {
    const rows = await this.db.select().from(messageTemplates).where(eq(messageTemplates.id, id)).limit(1);
    return rows[0] || null;
  }

  async create(data: Omit<typeof messageTemplates.$inferInsert, "id" | "createdAt" | "updatedAt">) {
    const rows = await this.db.insert(messageTemplates).values(data).returning();
    return rows[0];
  }

  async update(id: string, data: Partial<typeof messageTemplates.$inferInsert>) {
    const rows = await this.db.update(messageTemplates).set({ ...data, updatedAt: new Date() }).where(eq(messageTemplates.id, id)).returning();
    return rows[0];
  }

  async archive(id: string) {
    return this.update(id, { archivedAt: new Date() } as any);
  }
}

export class PricingPlanRepository {
  private get db() { return getDb(); }

  async list(opts?: { isActive?: boolean; search?: string; includeArchived?: boolean }) {
    const conditions = [];
    if (!opts?.includeArchived) conditions.push(isNull(pricingPlans.archivedAt));
    if (opts?.isActive !== undefined) conditions.push(eq(pricingPlans.isActive, opts.isActive));
    if (opts?.search) conditions.push(ilike(pricingPlans.name, `%${opts.search}%`));
    return this.db.select().from(pricingPlans)
      .where(conditions.length ? and(...conditions) : undefined)
      .orderBy(asc(pricingPlans.sortOrder));
  }

  async getById(id: string) {
    const rows = await this.db.select().from(pricingPlans).where(eq(pricingPlans.id, id)).limit(1);
    return rows[0] || null;
  }

  async create(data: Omit<typeof pricingPlans.$inferInsert, "id" | "createdAt">) {
    const rows = await this.db.insert(pricingPlans).values(data).returning();
    return rows[0];
  }

  async update(id: string, data: Partial<typeof pricingPlans.$inferInsert>) {
    const rows = await this.db.update(pricingPlans).set(data).where(eq(pricingPlans.id, id)).returning();
    return rows[0];
  }

  async archive(id: string) {
    return this.update(id, { archivedAt: new Date() } as any);
  }
}

export class ProductRepository {
  private get db() { return getDb(); }

  async list(opts?: { category?: string; isActive?: boolean; search?: string; includeArchived?: boolean }) {
    const conditions = [];
    if (!opts?.includeArchived) conditions.push(isNull(products.archivedAt));
    if (opts?.category) conditions.push(eq(products.category, opts.category));
    if (opts?.isActive !== undefined) conditions.push(eq(products.isActive, opts.isActive));
    if (opts?.search) conditions.push(ilike(products.name, `%${opts.search}%`));
    return this.db.select().from(products)
      .where(conditions.length ? and(...conditions) : undefined)
      .orderBy(asc(products.sortOrder));
  }

  async getById(id: string) {
    const rows = await this.db.select().from(products).where(eq(products.id, id)).limit(1);
    return rows[0] || null;
  }

  async create(data: Omit<typeof products.$inferInsert, "id" | "createdAt">) {
    const rows = await this.db.insert(products).values(data).returning();
    return rows[0];
  }

  async update(id: string, data: Partial<typeof products.$inferInsert>) {
    const rows = await this.db.update(products).set(data).where(eq(products.id, id)).returning();
    return rows[0];
  }

  async archive(id: string) {
    return this.update(id, { archivedAt: new Date() } as any);
  }
}

export class ProductFeatureRepository {
  private get db() { return getDb(); }

  async listByProduct(productId: string) {
    return this.db.select().from(productFeatures)
      .where(eq(productFeatures.productId, productId))
      .orderBy(asc(productFeatures.sortOrder));
  }

  async listByPlan(planId: string) {
    return this.db.select().from(productFeatures)
      .where(eq(productFeatures.planId, planId))
      .orderBy(asc(productFeatures.sortOrder));
  }

  async create(data: Omit<typeof productFeatures.$inferInsert, "id" | "createdAt">) {
    const rows = await this.db.insert(productFeatures).values(data).returning();
    return rows[0];
  }

  async update(id: string, data: Partial<typeof productFeatures.$inferInsert>) {
    const rows = await this.db.update(productFeatures).set(data).where(eq(productFeatures.id, id)).returning();
    return rows[0];
  }

  async delete(id: string) {
    return this.db.delete(productFeatures).where(eq(productFeatures.id, id));
  }
}

export class PromoCodeRepository {
  private get db() { return getDb(); }

  async list(opts?: { search?: string; isActive?: boolean; includeArchived?: boolean }) {
    const conditions = [];
    if (!opts?.includeArchived) conditions.push(isNull(promoCodes.archivedAt));
    if (opts?.isActive !== undefined) conditions.push(eq(promoCodes.isActive, opts.isActive));
    if (opts?.search) conditions.push(or(
      ilike(promoCodes.code, `%${opts.search}%`),
      ilike(promoCodes.name, `%${opts.search}%`)
    ));
    return this.db.select().from(promoCodes)
      .where(conditions.length ? and(...conditions) : undefined)
      .orderBy(desc(promoCodes.createdAt));
  }

  async getById(id: string) {
    const rows = await this.db.select().from(promoCodes).where(eq(promoCodes.id, id)).limit(1);
    return rows[0] || null;
  }

  async create(data: Omit<typeof promoCodes.$inferInsert, "id" | "createdAt">) {
    const rows = await this.db.insert(promoCodes).values(data).returning();
    return rows[0];
  }

  async update(id: string, data: Partial<typeof promoCodes.$inferInsert>) {
    const rows = await this.db.update(promoCodes).set(data).where(eq(promoCodes.id, id)).returning();
    return rows[0];
  }

  async archive(id: string) {
    return this.update(id, { archivedAt: new Date() } as any);
  }
}

export class GettingStartedPackageRepository {
  private get db() { return getDb(); }

  async list(opts?: { isActive?: boolean; includeArchived?: boolean }) {
    const conditions = [];
    if (!opts?.includeArchived) conditions.push(isNull(gettingStartedPackages.archivedAt));
    if (opts?.isActive !== undefined) conditions.push(eq(gettingStartedPackages.isActive, opts.isActive));
    return this.db.select().from(gettingStartedPackages)
      .where(conditions.length ? and(...conditions) : undefined)
      .orderBy(asc(gettingStartedPackages.sortOrder));
  }

  async getById(id: string) {
    const rows = await this.db.select().from(gettingStartedPackages).where(eq(gettingStartedPackages.id, id)).limit(1);
    return rows[0] || null;
  }

  async create(data: Omit<typeof gettingStartedPackages.$inferInsert, "id" | "createdAt">) {
    const rows = await this.db.insert(gettingStartedPackages).values(data).returning();
    return rows[0];
  }

  async update(id: string, data: Partial<typeof gettingStartedPackages.$inferInsert>) {
    const rows = await this.db.update(gettingStartedPackages).set(data).where(eq(gettingStartedPackages.id, id)).returning();
    return rows[0];
  }

  async archive(id: string) {
    return this.update(id, { archivedAt: new Date() } as any);
  }
}

export const funnelStageRepo = new DealFunnelStageRepository();
export const dealRepo = new DealRepository();
export const campaignRepo = new CampaignRepository();
export const couponRepo = new CouponRepository();
export const specialRepo = new SpecialRepository();
export const messageTemplateRepo = new MessageTemplateRepository();
export const pricingPlanRepo = new PricingPlanRepository();
export const productRepo = new ProductRepository();
export const productFeatureRepo = new ProductFeatureRepository();
export const promoCodeRepo = new PromoCodeRepository();
export const gettingStartedPackageRepo = new GettingStartedPackageRepository();
