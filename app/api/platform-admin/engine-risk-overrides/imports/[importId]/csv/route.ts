import { NextRequest, NextResponse } from "next/server";
import { requirePlatformAdmin } from "@/lib/auth";
import { getDb } from "@/lib/mongo";
import { getEngineRiskOverrideImport } from "@/lib/engine-risk-import-audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function unauthorized(error: unknown) {
  const msg = (error as { message?: string })?.message ?? "";
  return msg.toLowerCase().includes("unauthorized");
}

function downloadFilename(
  fileName: string | null,
  createdAt: Date | undefined,
  importId: string,
): string {
  const stamp =
    createdAt instanceof Date && !Number.isNaN(createdAt.getTime())
      ? createdAt.toISOString().replace(/[:.]/g, "-").slice(0, 19)
      : "import";
  if (fileName) {
    // Prefix with the timestamp so two imports of the same file name
    // download as distinct files.
    return `engine-risk-overrides-${stamp}-${fileName}`;
  }
  return `engine-risk-overrides-${stamp}-${importId.slice(-8)}.csv`;
}

export async function GET(
  _req: NextRequest,
  { params }: { params: { importId: string } },
) {
  try {
    await requirePlatformAdmin();
    const db = await getDb();
    const doc = await getEngineRiskOverrideImport(db, params.importId);
    if (!doc) {
      return NextResponse.json(
        { ok: false, error: "Import not found" },
        { status: 404 },
      );
    }
    const filename = downloadFilename(
      doc.fileName ?? null,
      doc.createdAt instanceof Date ? doc.createdAt : undefined,
      params.importId,
    );
    return new NextResponse(doc.csv ?? "", {
      status: 200,
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (error: any) {
    if (unauthorized(error)) {
      return NextResponse.json(
        { ok: false, error: "Unauthorized" },
        { status: 401 },
      );
    }
    return NextResponse.json(
      { ok: false, error: error.message },
      { status: 500 },
    );
  }
}
