import { NextRequest, NextResponse } from "next/server";
import { requirePlatformAdmin } from "@/lib/auth";
import { 
  getArticleById, 
  updateArticle, 
  deleteArticle 
} from "@/lib/knowledge-base";

export async function GET(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  await requirePlatformAdmin();

  const article = await getArticleById(params.id);
  if (!article) {
    return NextResponse.json({ ok: false, error: "Article not found" }, { status: 404 });
  }

  return NextResponse.json({ ok: true, article });
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  await requirePlatformAdmin();

  const body = await req.json();
  const { title, problem, solution, category, tags } = body;

  const updates: any = {};
  if (title) updates.title = title;
  if (problem) updates.problem = problem;
  if (solution) updates.solution = solution;
  if (category) updates.category = category;
  if (tags) updates.tags = tags;

  const success = await updateArticle(params.id, updates);
  if (!success) {
    return NextResponse.json({ ok: false, error: "Failed to update article" }, { status: 400 });
  }

  return NextResponse.json({ ok: true });
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  await requirePlatformAdmin();

  const success = await deleteArticle(params.id);
  if (!success) {
    return NextResponse.json({ ok: false, error: "Failed to delete article" }, { status: 400 });
  }

  return NextResponse.json({ ok: true });
}
