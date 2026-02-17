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
  
  const candidates = await db.collection<KnowledgeArticle>("knowledge_articles")
    .find({
      $or: [
        { title: { $in: searchRegex } },
        { problem: { $in: searchRegex } },
        { solution: { $in: searchRegex } },
        { tags: { $in: searchTerms } },
        { category: { $in: searchRegex } }
      ]
    })
    .limit(limit * 3)
    .toArray();

  const scored = candidates.map(article => {
    let score = 0;
    const lowerQuery = query.toLowerCase();
    const titleLower = article.title.toLowerCase();
    const problemLower = article.problem.toLowerCase();

    if (titleLower.includes(lowerQuery)) score += 10;

    for (const term of searchTerms) {
      if (titleLower.includes(term)) score += 5;
      if (problemLower.includes(term)) score += 3;
      if (article.solution.toLowerCase().includes(term)) score += 2;
      if (article.tags.some(t => t.toLowerCase() === term)) score += 4;
    }

    score += Math.min(article.helpfulCount * 2, 10);
    score += Math.min(article.viewCount * 0.1, 5);

    return { article, score };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map(s => s.article);
}

export async function incrementViewCounts(ids: string[]): Promise<void> {
  if (!ids.length) return;
  const db = await getDb();
  const objectIds = ids.filter(id => ObjectId.isValid(id)).map(id => new ObjectId(id));
  if (objectIds.length === 0) return;
  await db.collection("knowledge_articles").updateMany(
    { _id: { $in: objectIds } },
    { $inc: { viewCount: 1 } }
  );
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
