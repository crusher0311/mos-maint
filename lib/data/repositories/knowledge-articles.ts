// Repository for the `knowledge_articles` collection.
//
// Wave 1 (task #342): reads now come from Postgres; the Mongo collection is
// kept as a best-effort dual-write target until the soak window passes
// (see docs/db-migration-map.md §3.8).
import type { Collection } from "mongodb";
import { ObjectId } from "mongodb";
import { getDb } from "@/lib/data/db";
import {
  pgInsertArticle,
  pgFindArticle,
  pgListTopArticles,
  pgListAllArticles,
  pgListArticlesByCategory,
  pgSearchArticleCandidates,
  pgIncrementArticleView,
  pgIncrementArticleHelpful,
  pgUpdateArticle,
  pgDeleteArticle,
  pgCountArticles,
  pgDistinctArticleCategories,
  type KnowledgeArticleRow,
} from "@/lib/db/repositories/wave1";

const COLLECTION = "knowledge_articles";

export interface KnowledgeArticleDoc {
  _id?: ObjectId;
  title: string;
  problem: string;
  solution: string;
  category: string;
  tags: string[];
  sourceTicketId?: string;
  embedding?: number[];
  createdAt: Date;
  updatedAt: Date;
  createdBy: string;
  viewCount: number;
  helpfulCount: number;
}

export type KnowledgeArticleUpdate = Partial<
  Omit<KnowledgeArticleDoc, "_id" | "createdAt" | "updatedAt">
>;

async function collection(): Promise<Collection<KnowledgeArticleDoc>> {
  const db = await getDb();
  return db.collection<KnowledgeArticleDoc>(COLLECTION);
}

function pgRowToDoc(row: KnowledgeArticleRow): KnowledgeArticleDoc {
  const objectId = ObjectId.isValid(row.id) ? new ObjectId(row.id) : new ObjectId();
  return {
    _id: objectId,
    title: row.title,
    problem: row.problem,
    solution: row.solution,
    category: row.category,
    tags: (row.tags ?? []) as string[],
    sourceTicketId: row.sourceTicketId ?? undefined,
    embedding: (row.embedding ?? undefined) as number[] | undefined,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    createdBy: row.createdBy,
    viewCount: row.viewCount,
    helpfulCount: row.helpfulCount,
  };
}

export async function insertArticle(
  doc: Omit<KnowledgeArticleDoc, "_id">,
): Promise<string> {
  const id = new ObjectId();
  const idStr = id.toString();
  // PG canonical write — must succeed.
  await pgInsertArticle({
    id: idStr,
    title: doc.title,
    problem: doc.problem,
    solution: doc.solution,
    category: doc.category,
    tags: doc.tags ?? [],
    sourceTicketId: doc.sourceTicketId ?? null,
    embedding: doc.embedding ?? null,
    createdBy: doc.createdBy,
    viewCount: doc.viewCount ?? 0,
    helpfulCount: doc.helpfulCount ?? 0,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  });
  // Mongo legacy mirror (best-effort, retained for W1.5 soak only).
  try {
    const col = await collection();
    await col.insertOne({ _id: id, ...doc });
  } catch (err) {
    console.error("[knowledge_articles] Mongo mirror failed (non-fatal):", err);
  }
  return idStr;
}

export async function findArticleById(id: string): Promise<KnowledgeArticleDoc | null> {
  const row = await pgFindArticle(id);
  return row ? pgRowToDoc(row) : null;
}

export async function listTopArticles(limit: number): Promise<KnowledgeArticleDoc[]> {
  const rows = await pgListTopArticles(limit);
  return rows.map(pgRowToDoc);
}

export async function listAll(limit: number, skip: number): Promise<KnowledgeArticleDoc[]> {
  const rows = await pgListAllArticles(limit, skip);
  return rows.map(pgRowToDoc);
}

export async function listByCategory(category: string): Promise<KnowledgeArticleDoc[]> {
  const rows = await pgListArticlesByCategory(category);
  return rows.map(pgRowToDoc);
}

export async function searchCandidates(
  _searchRegex: RegExp[],
  searchTerms: string[],
  limit: number,
): Promise<KnowledgeArticleDoc[]> {
  const rows = await pgSearchArticleCandidates(searchTerms, limit);
  return rows.map(pgRowToDoc);
}

export async function incrementViewCounts(ids: string[]): Promise<void> {
  await pgIncrementArticleView(ids);
  // Mongo mirror
  try {
    if (!ids.length) return;
    const objectIds = ids.filter((id) => ObjectId.isValid(id)).map((id) => new ObjectId(id));
    if (objectIds.length === 0) return;
    const col = await collection();
    await col.updateMany({ _id: { $in: objectIds } }, { $inc: { viewCount: 1 } });
  } catch (err) {
    console.error("[knowledge_articles] Mongo viewCount mirror failed:", err);
  }
}

export async function incrementViewCount(id: string): Promise<void> {
  await pgIncrementArticleView([id]);
  try {
    if (!ObjectId.isValid(id)) return;
    const col = await collection();
    await col.updateOne({ _id: new ObjectId(id) }, { $inc: { viewCount: 1 } });
  } catch (err) {
    console.error("[knowledge_articles] Mongo viewCount mirror failed:", err);
  }
}

export async function incrementHelpfulCount(id: string): Promise<void> {
  await pgIncrementArticleHelpful(id);
  try {
    if (!ObjectId.isValid(id)) return;
    const col = await collection();
    await col.updateOne({ _id: new ObjectId(id) }, { $inc: { helpfulCount: 1 } });
  } catch (err) {
    console.error("[knowledge_articles] Mongo helpfulCount mirror failed:", err);
  }
}

export async function updateArticle(
  id: string,
  updates: KnowledgeArticleUpdate,
): Promise<boolean> {
  const ok = await pgUpdateArticle(id, updates);
  try {
    if (ObjectId.isValid(id)) {
      const col = await collection();
      await col.updateOne({ _id: new ObjectId(id) }, { $set: { ...updates, updatedAt: new Date() } });
    }
  } catch (err) {
    console.error("[knowledge_articles] Mongo update mirror failed:", err);
  }
  return ok;
}

export async function deleteArticle(id: string): Promise<boolean> {
  const ok = await pgDeleteArticle(id);
  try {
    if (ObjectId.isValid(id)) {
      const col = await collection();
      await col.deleteOne({ _id: new ObjectId(id) });
    }
  } catch (err) {
    console.error("[knowledge_articles] Mongo delete mirror failed:", err);
  }
  return ok;
}

export async function countArticles(): Promise<number> {
  return pgCountArticles();
}

export async function distinctCategories(): Promise<string[]> {
  return pgDistinctArticleCategories();
}
