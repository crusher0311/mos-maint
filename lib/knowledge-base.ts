import { getDb } from "./mongo";
import { ObjectId } from "mongodb";

export interface KnowledgeArticle {
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

export async function createArticle(article: Omit<KnowledgeArticle, "_id" | "createdAt" | "updatedAt" | "viewCount" | "helpfulCount">): Promise<string> {
  const db = await getDb();
  const now = new Date();
  
  const result = await db.collection("knowledge_articles").insertOne({
    ...article,
    createdAt: now,
    updatedAt: now,
    viewCount: 0,
    helpfulCount: 0
  });
  
  return result.insertedId.toString();
}

export async function getArticleById(id: string): Promise<KnowledgeArticle | null> {
  if (!ObjectId.isValid(id)) return null;
  const db = await getDb();
  return db.collection<KnowledgeArticle>("knowledge_articles").findOne({ _id: new ObjectId(id) });
}

export async function searchArticles(query: string, limit: number = 5): Promise<KnowledgeArticle[]> {
  const db = await getDb();
  
  const searchTerms = query.toLowerCase().split(/\s+/).filter(t => t.length > 2);
  
  if (searchTerms.length === 0) {
    return db.collection<KnowledgeArticle>("knowledge_articles")
      .find({})
      .sort({ helpfulCount: -1, viewCount: -1 })
      .limit(limit)
      .toArray();
  }
  
  const searchRegex = searchTerms.map(term => new RegExp(term, "i"));
  
  return db.collection<KnowledgeArticle>("knowledge_articles")
    .find({
      $or: [
        { title: { $in: searchRegex } },
        { problem: { $in: searchRegex } },
        { solution: { $in: searchRegex } },
        { tags: { $in: searchTerms } },
        { category: { $in: searchRegex } }
      ]
    })
    .sort({ helpfulCount: -1, viewCount: -1 })
    .limit(limit)
    .toArray();
}

export async function getAllArticles(limit: number = 50, skip: number = 0): Promise<KnowledgeArticle[]> {
  const db = await getDb();
  return db.collection<KnowledgeArticle>("knowledge_articles")
    .find({})
    .sort({ updatedAt: -1 })
    .skip(skip)
    .limit(limit)
    .toArray();
}

export async function updateArticle(id: string, updates: Partial<KnowledgeArticle>): Promise<boolean> {
  if (!ObjectId.isValid(id)) return false;
  const db = await getDb();
  
  const result = await db.collection("knowledge_articles").updateOne(
    { _id: new ObjectId(id) },
    { $set: { ...updates, updatedAt: new Date() } }
  );
  
  return result.matchedCount > 0;
}

export async function deleteArticle(id: string): Promise<boolean> {
  if (!ObjectId.isValid(id)) return false;
  const db = await getDb();
  
  const result = await db.collection("knowledge_articles").deleteOne({ _id: new ObjectId(id) });
  return result.deletedCount > 0;
}

export async function incrementViewCount(id: string): Promise<void> {
  if (!ObjectId.isValid(id)) return;
  const db = await getDb();
  
  await db.collection("knowledge_articles").updateOne(
    { _id: new ObjectId(id) },
    { $inc: { viewCount: 1 } }
  );
}

export async function incrementHelpfulCount(id: string): Promise<void> {
  if (!ObjectId.isValid(id)) return;
  const db = await getDb();
  
  await db.collection("knowledge_articles").updateOne(
    { _id: new ObjectId(id) },
    { $inc: { helpfulCount: 1 } }
  );
}

export async function getArticlesByCategory(category: string): Promise<KnowledgeArticle[]> {
  const db = await getDb();
  return db.collection<KnowledgeArticle>("knowledge_articles")
    .find({ category })
    .sort({ helpfulCount: -1 })
    .toArray();
}

export async function getCategories(): Promise<string[]> {
  const db = await getDb();
  return db.collection("knowledge_articles").distinct("category");
}
