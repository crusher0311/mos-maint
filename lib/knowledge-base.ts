import { ObjectId } from "mongodb";
import * as repo from "@/lib/data/repositories/knowledge-articles";

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

export async function createArticle(
  article: Omit<KnowledgeArticle, "_id" | "createdAt" | "updatedAt" | "viewCount" | "helpfulCount">,
): Promise<string> {
  const now = new Date();
  return repo.insertArticle({
    ...article,
    createdAt: now,
    updatedAt: now,
    viewCount: 0,
    helpfulCount: 0,
  });
}

export async function getArticleById(id: string): Promise<KnowledgeArticle | null> {
  return (await repo.findArticleById(id)) as KnowledgeArticle | null;
}

export async function searchArticles(query: string, limit: number = 5): Promise<KnowledgeArticle[]> {
  const searchTerms = query.toLowerCase().split(/\s+/).filter((t) => t.length > 2);

  if (searchTerms.length === 0) {
    return (await repo.listTopArticles(limit)) as KnowledgeArticle[];
  }

  const searchRegex = searchTerms.map((term) => new RegExp(term, "i"));
  const candidates = (await repo.searchCandidates(searchRegex, searchTerms, limit * 3)) as KnowledgeArticle[];

  const scored = candidates.map((article) => {
    let score = 0;
    const lowerQuery = query.toLowerCase();
    const titleLower = article.title.toLowerCase();
    const problemLower = article.problem.toLowerCase();

    if (titleLower.includes(lowerQuery)) score += 10;

    for (const term of searchTerms) {
      if (titleLower.includes(term)) score += 5;
      if (problemLower.includes(term)) score += 3;
      if (article.solution.toLowerCase().includes(term)) score += 2;
      if (article.tags.some((t) => t.toLowerCase() === term)) score += 4;
    }

    score += Math.min(article.helpfulCount * 2, 10);
    score += Math.min(article.viewCount * 0.1, 5);

    return { article, score };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map((s) => s.article);
}

export async function incrementViewCounts(ids: string[]): Promise<void> {
  return repo.incrementViewCounts(ids);
}

export async function getAllArticles(limit: number = 50, skip: number = 0): Promise<KnowledgeArticle[]> {
  return (await repo.listAll(limit, skip)) as KnowledgeArticle[];
}

export async function updateArticle(
  id: string,
  updates: repo.KnowledgeArticleUpdate,
): Promise<boolean> {
  return repo.updateArticle(id, updates);
}

export async function deleteArticle(id: string): Promise<boolean> {
  return repo.deleteArticle(id);
}

export async function incrementViewCount(id: string): Promise<void> {
  return repo.incrementViewCount(id);
}

export async function incrementHelpfulCount(id: string): Promise<void> {
  return repo.incrementHelpfulCount(id);
}

export async function getArticlesByCategory(category: string): Promise<KnowledgeArticle[]> {
  return (await repo.listByCategory(category)) as KnowledgeArticle[];
}

export async function getCategories(): Promise<string[]> {
  return repo.distinctCategories();
}
