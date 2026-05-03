// Repository for the `knowledge_articles` collection.
import type { Collection } from "mongodb";
import { ObjectId } from "mongodb";
import { getDb } from "@/lib/data/db";

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

export async function insertArticle(
  doc: Omit<KnowledgeArticleDoc, "_id">,
): Promise<string> {
  const col = await collection();
  const res = await col.insertOne(doc);
  return res.insertedId.toString();
}

export async function findArticleById(id: string): Promise<KnowledgeArticleDoc | null> {
  if (!ObjectId.isValid(id)) return null;
  const col = await collection();
  return col.findOne({ _id: new ObjectId(id) });
}

export async function listTopArticles(limit: number): Promise<KnowledgeArticleDoc[]> {
  const col = await collection();
  return col.find({}).sort({ helpfulCount: -1, viewCount: -1 }).limit(limit).toArray();
}

export async function listAll(limit: number, skip: number): Promise<KnowledgeArticleDoc[]> {
  const col = await collection();
  return col.find({}).sort({ updatedAt: -1 }).skip(skip).limit(limit).toArray();
}

export async function listByCategory(category: string): Promise<KnowledgeArticleDoc[]> {
  const col = await collection();
  return col.find({ category }).sort({ helpfulCount: -1 }).toArray();
}

export async function searchCandidates(
  searchRegex: RegExp[],
  searchTerms: string[],
  limit: number,
): Promise<KnowledgeArticleDoc[]> {
  const col = await collection();
  return col
    .find({
      $or: [
        { title: { $in: searchRegex } },
        { problem: { $in: searchRegex } },
        { solution: { $in: searchRegex } },
        { tags: { $in: searchTerms } },
        { category: { $in: searchRegex } },
      ],
    })
    .limit(limit)
    .toArray();
}

export async function incrementViewCounts(ids: string[]): Promise<void> {
  if (!ids.length) return;
  const objectIds = ids.filter((id) => ObjectId.isValid(id)).map((id) => new ObjectId(id));
  if (objectIds.length === 0) return;
  const col = await collection();
  await col.updateMany({ _id: { $in: objectIds } }, { $inc: { viewCount: 1 } });
}

export async function incrementViewCount(id: string): Promise<void> {
  if (!ObjectId.isValid(id)) return;
  const col = await collection();
  await col.updateOne({ _id: new ObjectId(id) }, { $inc: { viewCount: 1 } });
}

export async function incrementHelpfulCount(id: string): Promise<void> {
  if (!ObjectId.isValid(id)) return;
  const col = await collection();
  await col.updateOne({ _id: new ObjectId(id) }, { $inc: { helpfulCount: 1 } });
}

export async function updateArticle(
  id: string,
  updates: KnowledgeArticleUpdate,
): Promise<boolean> {
  if (!ObjectId.isValid(id)) return false;
  const col = await collection();
  const res = await col.updateOne(
    { _id: new ObjectId(id) },
    { $set: { ...updates, updatedAt: new Date() } },
  );
  return res.matchedCount > 0;
}

export async function deleteArticle(id: string): Promise<boolean> {
  if (!ObjectId.isValid(id)) return false;
  const col = await collection();
  const res = await col.deleteOne({ _id: new ObjectId(id) });
  return res.deletedCount > 0;
}

export async function distinctCategories(): Promise<string[]> {
  const col = await collection();
  return (await col.distinct("category")) as string[];
}
