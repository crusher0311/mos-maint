import { getDb } from "@/lib/db/drizzle";
import {
  onboardingStages,
  onboardingStageAssignments,
  onboardingSteps,
  onboardingStageSteps,
  onboardingChecklists,
  onboardingStepChecklists,
  onboardingCards,
  onboardingCardProgress,
  tours,
  onboardingGuidesContent,
  workflowSequences,
  banners,
  contentAssignments,
} from "@/lib/db/schema/onboarding";
import { crmLocations, crmAccounts } from "@/lib/db/schema/crm-accounts";
import { eq, asc, isNull, and, desc } from "drizzle-orm";

export class OnboardingRepository {
  private get db() {
    return getDb();
  }

  async getStages() {
    return this.db.select().from(onboardingStages).where(isNull(onboardingStages.archivedAt)).orderBy(asc(onboardingStages.sortOrder));
  }

  async getStage(id: string) {
    const [stage] = await this.db.select().from(onboardingStages).where(eq(onboardingStages.id, id));
    return stage || null;
  }

  async createStage(data: { name: string; description?: string; color?: string; sortOrder?: number; isDefault?: boolean }) {
    const [stage] = await this.db.insert(onboardingStages).values(data).returning();
    return stage;
  }

  async updateStage(id: string, data: Partial<{ name: string; description: string; color: string; sortOrder: number; isDefault: boolean }>) {
    const [stage] = await this.db.update(onboardingStages).set(data).where(eq(onboardingStages.id, id)).returning();
    return stage;
  }

  async deleteStage(id: string) {
    const [stage] = await this.db.update(onboardingStages).set({ archivedAt: new Date() }).where(eq(onboardingStages.id, id)).returning();
    return stage;
  }

  async getSteps() {
    return this.db.select().from(onboardingSteps).where(isNull(onboardingSteps.archivedAt)).orderBy(asc(onboardingSteps.sortOrder));
  }

  async getStep(id: string) {
    const [step] = await this.db.select().from(onboardingSteps).where(eq(onboardingSteps.id, id));
    return step || null;
  }

  async createStep(data: { name: string; description?: string; sortOrder?: number }) {
    const [step] = await this.db.insert(onboardingSteps).values(data).returning();
    return step;
  }

  async updateStep(id: string, data: Partial<{ name: string; description: string; sortOrder: number }>) {
    const [step] = await this.db.update(onboardingSteps).set(data).where(eq(onboardingSteps.id, id)).returning();
    return step;
  }

  async deleteStep(id: string) {
    const [step] = await this.db.update(onboardingSteps).set({ archivedAt: new Date() }).where(eq(onboardingSteps.id, id)).returning();
    return step;
  }

  async getStageSteps(stageId: string) {
    return this.db
      .select({ stageStep: onboardingStageSteps, step: onboardingSteps })
      .from(onboardingStageSteps)
      .innerJoin(onboardingSteps, eq(onboardingStageSteps.stepId, onboardingSteps.id))
      .where(eq(onboardingStageSteps.stageId, stageId))
      .orderBy(asc(onboardingStageSteps.sortOrder));
  }

  async addStepToStage(stageId: string, stepId: string, sortOrder: number = 0) {
    const [link] = await this.db.insert(onboardingStageSteps).values({ stageId, stepId, sortOrder }).returning();
    return link;
  }

  async removeStepFromStage(id: string) {
    await this.db.delete(onboardingStageSteps).where(eq(onboardingStageSteps.id, id));
  }

  async getChecklists() {
    return this.db.select().from(onboardingChecklists).where(isNull(onboardingChecklists.archivedAt)).orderBy(asc(onboardingChecklists.sortOrder));
  }

  async createChecklist(data: { name: string; description?: string; sortOrder?: number }) {
    const [checklist] = await this.db.insert(onboardingChecklists).values(data).returning();
    return checklist;
  }

  async updateChecklist(id: string, data: Partial<{ name: string; description: string; sortOrder: number }>) {
    const [checklist] = await this.db.update(onboardingChecklists).set(data).where(eq(onboardingChecklists.id, id)).returning();
    return checklist;
  }

  async deleteChecklist(id: string) {
    const [checklist] = await this.db.update(onboardingChecklists).set({ archivedAt: new Date() }).where(eq(onboardingChecklists.id, id)).returning();
    return checklist;
  }

  async getStepChecklists(stepId: string) {
    return this.db
      .select({ stepChecklist: onboardingStepChecklists, checklist: onboardingChecklists })
      .from(onboardingStepChecklists)
      .innerJoin(onboardingChecklists, eq(onboardingStepChecklists.checklistId, onboardingChecklists.id))
      .where(eq(onboardingStepChecklists.stepId, stepId))
      .orderBy(asc(onboardingStepChecklists.sortOrder));
  }

  async addChecklistToStep(stepId: string, checklistId: string, sortOrder: number = 0) {
    const [link] = await this.db.insert(onboardingStepChecklists).values({ stepId, checklistId, sortOrder }).returning();
    return link;
  }

  async removeChecklistFromStep(id: string) {
    await this.db.delete(onboardingStepChecklists).where(eq(onboardingStepChecklists.id, id));
  }

  async getCards() {
    return this.db
      .select({ card: onboardingCards, location: crmLocations, stage: onboardingStages, account: crmAccounts })
      .from(onboardingCards)
      .innerJoin(crmLocations, eq(onboardingCards.locationId, crmLocations.id))
      .innerJoin(onboardingStages, eq(onboardingCards.stageId, onboardingStages.id))
      .leftJoin(crmAccounts, eq(crmLocations.accountId, crmAccounts.id))
      .orderBy(asc(onboardingCards.sortOrder));
  }

  async getCard(id: string) {
    const [result] = await this.db
      .select({ card: onboardingCards, location: crmLocations, stage: onboardingStages, account: crmAccounts })
      .from(onboardingCards)
      .innerJoin(crmLocations, eq(onboardingCards.locationId, crmLocations.id))
      .innerJoin(onboardingStages, eq(onboardingCards.stageId, onboardingStages.id))
      .leftJoin(crmAccounts, eq(crmLocations.accountId, crmAccounts.id))
      .where(eq(onboardingCards.id, id));
    return result || null;
  }

  async createCard(data: { locationId: string; stageId: string; assigneeEmail?: string; assigneeName?: string; notes?: string; priority?: string; sortOrder?: number }) {
    const [card] = await this.db.insert(onboardingCards).values(data).returning();
    return card;
  }

  async updateCard(id: string, data: Partial<{ stageId: string; assigneeEmail: string; assigneeName: string; notes: string; priority: string; sortOrder: number }>) {
    const [card] = await this.db.update(onboardingCards).set({ ...data, updatedAt: new Date() }).where(eq(onboardingCards.id, id)).returning();
    return card;
  }

  async deleteCard(id: string) {
    await this.db.delete(onboardingCards).where(eq(onboardingCards.id, id));
  }

  async getCardProgress(cardId: string) {
    return this.db.select().from(onboardingCardProgress).where(eq(onboardingCardProgress.cardId, cardId));
  }

  async toggleCardProgress(cardId: string, stepId: string | null, checklistId: string | null, completedBy: string) {
    const conditions = [eq(onboardingCardProgress.cardId, cardId)];
    if (stepId) conditions.push(eq(onboardingCardProgress.stepId, stepId));
    if (checklistId) conditions.push(eq(onboardingCardProgress.checklistId, checklistId));

    const [existing] = await this.db.select().from(onboardingCardProgress).where(and(...conditions));

    if (existing) {
      const [updated] = await this.db.update(onboardingCardProgress).set({
        completed: !existing.completed,
        completedBy: !existing.completed ? completedBy : null,
        completedAt: !existing.completed ? new Date() : null,
      }).where(eq(onboardingCardProgress.id, existing.id)).returning();
      return updated;
    }

    const [progress] = await this.db.insert(onboardingCardProgress).values({
      cardId,
      stepId,
      checklistId,
      completed: true,
      completedBy,
      completedAt: new Date(),
    }).returning();
    return progress;
  }
}

export class ToursRepository {
  private get db() {
    return getDb();
  }

  async getAll() {
    return this.db.select().from(tours).where(isNull(tours.archivedAt)).orderBy(asc(tours.sortOrder));
  }

  async get(id: string) {
    const [tour] = await this.db.select().from(tours).where(eq(tours.id, id));
    return tour || null;
  }

  async create(data: { name: string; description?: string; targetPage?: string; status?: string; steps?: any[]; sortOrder?: number }) {
    const [tour] = await this.db.insert(tours).values(data).returning();
    return tour;
  }

  async update(id: string, data: Partial<{ name: string; description: string; targetPage: string; status: string; steps: any[]; sortOrder: number }>) {
    const [tour] = await this.db.update(tours).set({ ...data, updatedAt: new Date() }).where(eq(tours.id, id)).returning();
    return tour;
  }

  async delete(id: string) {
    const [tour] = await this.db.update(tours).set({ archivedAt: new Date() }).where(eq(tours.id, id)).returning();
    return tour;
  }
}

export class GuidesRepository {
  private get db() {
    return getDb();
  }

  async getAll() {
    return this.db.select().from(onboardingGuidesContent).where(isNull(onboardingGuidesContent.archivedAt)).orderBy(asc(onboardingGuidesContent.sortOrder));
  }

  async get(id: string) {
    const [guide] = await this.db.select().from(onboardingGuidesContent).where(eq(onboardingGuidesContent.id, id));
    return guide || null;
  }

  async create(data: { title: string; description?: string; category?: string; status?: string; steps?: any[]; sortOrder?: number }) {
    const [guide] = await this.db.insert(onboardingGuidesContent).values(data).returning();
    return guide;
  }

  async update(id: string, data: Partial<{ title: string; description: string; category: string; status: string; steps: any[]; sortOrder: number }>) {
    const [guide] = await this.db.update(onboardingGuidesContent).set({ ...data, updatedAt: new Date() }).where(eq(onboardingGuidesContent.id, id)).returning();
    return guide;
  }

  async delete(id: string) {
    const [guide] = await this.db.update(onboardingGuidesContent).set({ archivedAt: new Date() }).where(eq(onboardingGuidesContent.id, id)).returning();
    return guide;
  }
}

export class WorkflowSequencesRepository {
  private get db() {
    return getDb();
  }

  async getAll() {
    return this.db.select().from(workflowSequences).where(isNull(workflowSequences.archivedAt)).orderBy(asc(workflowSequences.sortOrder));
  }

  async get(id: string) {
    const [seq] = await this.db.select().from(workflowSequences).where(eq(workflowSequences.id, id));
    return seq || null;
  }

  async create(data: { name: string; description?: string; triggerEvent?: string; status?: string; steps?: any[]; sortOrder?: number }) {
    const [seq] = await this.db.insert(workflowSequences).values(data).returning();
    return seq;
  }

  async update(id: string, data: Partial<{ name: string; description: string; triggerEvent: string; status: string; steps: any[]; sortOrder: number }>) {
    const [seq] = await this.db.update(workflowSequences).set({ ...data, updatedAt: new Date() }).where(eq(workflowSequences.id, id)).returning();
    return seq;
  }

  async delete(id: string) {
    const [seq] = await this.db.update(workflowSequences).set({ archivedAt: new Date() }).where(eq(workflowSequences.id, id)).returning();
    return seq;
  }
}

export class BannersRepository {
  private get db() {
    return getDb();
  }

  async getAll() {
    return this.db.select().from(banners).where(isNull(banners.archivedAt)).orderBy(asc(banners.sortOrder));
  }

  async get(id: string) {
    const [banner] = await this.db.select().from(banners).where(eq(banners.id, id));
    return banner || null;
  }

  async create(data: { title: string; message: string; type?: string; linkUrl?: string; linkText?: string; status?: string; startsAt?: Date; endsAt?: Date; sortOrder?: number }) {
    const [banner] = await this.db.insert(banners).values(data).returning();
    return banner;
  }

  async update(id: string, data: Partial<{ title: string; message: string; type: string; linkUrl: string; linkText: string; status: string; startsAt: Date; endsAt: Date; sortOrder: number }>) {
    const [banner] = await this.db.update(banners).set({ ...data, updatedAt: new Date() }).where(eq(banners.id, id)).returning();
    return banner;
  }

  async delete(id: string) {
    const [banner] = await this.db.update(banners).set({ archivedAt: new Date() }).where(eq(banners.id, id)).returning();
    return banner;
  }
}

export class ContentAssignmentsRepository {
  private get db() {
    return getDb();
  }

  async getAll() {
    return this.db.select().from(contentAssignments).orderBy(desc(contentAssignments.createdAt));
  }

  async getByContent(contentType: string, contentId: string) {
    return this.db.select().from(contentAssignments).where(
      and(eq(contentAssignments.contentType, contentType), eq(contentAssignments.contentId, contentId))
    );
  }

  async create(data: { contentType: string; contentId: string; userTypeId?: string; assignAll?: boolean }) {
    const [assignment] = await this.db.insert(contentAssignments).values(data).returning();
    return assignment;
  }

  async delete(id: string) {
    await this.db.delete(contentAssignments).where(eq(contentAssignments.id, id));
  }

  async deleteByContent(contentType: string, contentId: string) {
    await this.db.delete(contentAssignments).where(
      and(eq(contentAssignments.contentType, contentType), eq(contentAssignments.contentId, contentId))
    );
  }
}
