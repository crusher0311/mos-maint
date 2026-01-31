import sql from "@/lib/db/postgres";

export interface KnowledgeArticle {
  id?: number;
  title: string;
  problem: string;
  solution: string;
  category: string;
  tags: string[];
  sourceTicketId?: string;
  createdAt: Date;
  updatedAt: Date;
  createdBy: string;
  viewCount: number;
  helpfulCount: number;
  notHelpfulCount?: number;
  isPublished?: boolean;
}

export async function createArticle(article: Omit<KnowledgeArticle, "id" | "createdAt" | "updatedAt" | "viewCount" | "helpfulCount">): Promise<string> {
  const result = await sql`
    INSERT INTO knowledge_articles (
      title, problem, solution, category, tags, created_by, is_published
    )
    VALUES (
      ${article.title}, 
      ${article.problem}, 
      ${article.solution}, 
      ${article.category}, 
      ${JSON.stringify(article.tags)}, 
      ${article.createdBy},
      ${article.isPublished ?? false}
    )
    RETURNING id
  `;
  
  return String(result[0].id);
}

export async function getArticleById(id: string): Promise<KnowledgeArticle | null> {
  const numId = Number(id);
  if (isNaN(numId)) return null;
  
  const results = await sql`
    SELECT id, title, problem, solution, category, tags, 
           created_by as "createdBy", created_at as "createdAt", 
           updated_at as "updatedAt", view_count as "viewCount", 
           helpful_count as "helpfulCount", not_helpful_count as "notHelpfulCount",
           is_published as "isPublished"
    FROM knowledge_articles 
    WHERE id = ${numId} 
    LIMIT 1
  `;
  return results[0] as unknown as KnowledgeArticle || null;
}

export async function searchArticles(query: string, limit: number = 5): Promise<KnowledgeArticle[]> {
  const searchTerms = query.toLowerCase().split(/\s+/).filter(t => t.length > 2);
  
  if (searchTerms.length === 0) {
    const results = await sql`
      SELECT id, title, problem, solution, category, tags, 
             created_by as "createdBy", created_at as "createdAt", 
             updated_at as "updatedAt", view_count as "viewCount", 
             helpful_count as "helpfulCount"
      FROM knowledge_articles 
      WHERE is_published = TRUE
      ORDER BY helpful_count DESC, view_count DESC 
      LIMIT ${limit}
    `;
    return results as unknown as KnowledgeArticle[];
  }
  
  const searchPattern = `%${searchTerms.join('%')}%`;
  const results = await sql`
    SELECT id, title, problem, solution, category, tags, 
           created_by as "createdBy", created_at as "createdAt", 
           updated_at as "updatedAt", view_count as "viewCount", 
           helpful_count as "helpfulCount"
    FROM knowledge_articles 
    WHERE is_published = TRUE AND (
      LOWER(title) LIKE ${searchPattern} OR
      LOWER(problem) LIKE ${searchPattern} OR
      LOWER(solution) LIKE ${searchPattern} OR
      LOWER(category) LIKE ${searchPattern} OR
      tags::text ILIKE ${searchPattern}
    )
    ORDER BY helpful_count DESC, view_count DESC 
    LIMIT ${limit}
  `;
  return results as unknown as KnowledgeArticle[];
}

export async function getAllArticles(limit: number = 50, skip: number = 0): Promise<KnowledgeArticle[]> {
  const results = await sql`
    SELECT id, title, problem, solution, category, tags, 
           created_by as "createdBy", created_at as "createdAt", 
           updated_at as "updatedAt", view_count as "viewCount", 
           helpful_count as "helpfulCount", is_published as "isPublished"
    FROM knowledge_articles 
    ORDER BY updated_at DESC 
    OFFSET ${skip} LIMIT ${limit}
  `;
  return results as unknown as KnowledgeArticle[];
}

export async function updateArticle(id: string, updates: Partial<KnowledgeArticle>): Promise<boolean> {
  const numId = Number(id);
  if (isNaN(numId)) return false;
  
  const allowedFields: (keyof KnowledgeArticle)[] = ['title', 'problem', 'solution', 'category', 'tags', 'isPublished'];
  const updateData: Record<string, unknown> = {};
  
  for (const field of allowedFields) {
    if (updates[field] !== undefined) {
      if (field === 'tags') {
        updateData['tags'] = JSON.stringify(updates[field]);
      } else if (field === 'isPublished') {
        updateData['is_published'] = updates[field];
      } else {
        updateData[field] = updates[field];
      }
    }
  }
  
  if (Object.keys(updateData).length === 0) return false;
  
  const result = await sql`
    UPDATE knowledge_articles 
    SET ${sql(updateData)}, updated_at = NOW()
    WHERE id = ${numId}
  `;
  
  return result.count > 0;
}

export async function deleteArticle(id: string): Promise<boolean> {
  const numId = Number(id);
  if (isNaN(numId)) return false;
  
  const result = await sql`
    DELETE FROM knowledge_articles WHERE id = ${numId}
  `;
  return result.count > 0;
}

export async function incrementViewCount(id: string): Promise<void> {
  const numId = Number(id);
  if (isNaN(numId)) return;
  
  await sql`
    UPDATE knowledge_articles SET view_count = view_count + 1 WHERE id = ${numId}
  `;
}

export async function incrementHelpfulCount(id: string): Promise<void> {
  const numId = Number(id);
  if (isNaN(numId)) return;
  
  await sql`
    UPDATE knowledge_articles SET helpful_count = helpful_count + 1 WHERE id = ${numId}
  `;
}

export async function getArticlesByCategory(category: string): Promise<KnowledgeArticle[]> {
  const results = await sql`
    SELECT id, title, problem, solution, category, tags, 
           created_by as "createdBy", created_at as "createdAt", 
           updated_at as "updatedAt", view_count as "viewCount", 
           helpful_count as "helpfulCount"
    FROM knowledge_articles 
    WHERE category = ${category} AND is_published = TRUE
    ORDER BY helpful_count DESC
  `;
  return results as unknown as KnowledgeArticle[];
}

export async function getCategories(): Promise<string[]> {
  const results = await sql`
    SELECT DISTINCT category FROM knowledge_articles WHERE category IS NOT NULL
  `;
  return results.map((r: Record<string, unknown>) => r.category as string);
}
