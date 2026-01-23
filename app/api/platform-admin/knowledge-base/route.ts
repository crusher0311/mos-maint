import { NextRequest, NextResponse } from "next/server";
import { requirePlatformAdmin } from "@/lib/auth";
import { 
  createArticle, 
  getAllArticles, 
  searchArticles,
  getCategories 
} from "@/lib/knowledge-base";

export async function GET(req: NextRequest) {
  const admin = await requirePlatformAdmin();

  const { searchParams } = new URL(req.url);
  const query = searchParams.get("query");
  const limit = parseInt(searchParams.get("limit") || "50");
  const skip = parseInt(searchParams.get("skip") || "0");

  if (query) {
    const articles = await searchArticles(query, limit);
    return NextResponse.json({ ok: true, articles });
  }

  const articles = await getAllArticles(limit, skip);
  const categories = await getCategories();

  return NextResponse.json({ 
    ok: true, 
    articles,
    categories
  });
}

export async function POST(req: NextRequest) {
  const admin = await requirePlatformAdmin();

  const body = await req.json();
  const { title, problem, solution, category, tags } = body;

  if (!title || !problem || !solution) {
    return NextResponse.json({ 
      ok: false, 
      error: "Title, problem, and solution are required" 
    }, { status: 400 });
  }

  const articleId = await createArticle({
    title,
    problem,
    solution,
    category: category || "general",
    tags: tags || [],
    createdBy: admin.email
  });

  return NextResponse.json({ ok: true, articleId });
}
