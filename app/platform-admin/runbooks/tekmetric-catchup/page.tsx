import fs from "fs/promises";
import path from "path";
import Link from "next/link";
import { ArrowLeft, BookOpen } from "lucide-react";
import { renderMarkdown } from "@/lib/markdown/render-runbook";

export const dynamic = "force-dynamic";

export default async function TekmetricCatchupRunbookPage() {
  const filePath = path.join(
    process.cwd(),
    "docs",
    "runbooks",
    "tekmetric-catchup.md",
  );

  let markdown = "";
  let loadError: string | null = null;
  try {
    markdown = await fs.readFile(filePath, "utf8");
  } catch (e) {
    loadError =
      "Could not load the runbook file from disk. The file " +
      "`docs/runbooks/tekmetric-catchup.md` may be missing in this " +
      "deployment. Please ask engineering for the latest copy.";
  }

  return (
    <div className="max-w-4xl mx-auto p-6 space-y-4">
      <div className="flex items-center justify-between">
        <Link
          href="/platform-admin/sync-health"
          className="inline-flex items-center gap-1 text-sm text-indigo-600 hover:text-indigo-800"
        >
          <ArrowLeft className="w-4 h-4" />
          Back to sync health
        </Link>
        <span className="inline-flex items-center gap-1 text-xs text-gray-500">
          <BookOpen className="w-4 h-4" />
          docs/runbooks/tekmetric-catchup.md
        </span>
      </div>

      <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6">
        {loadError ? (
          <div className="p-4 bg-amber-50 border border-amber-200 rounded text-sm text-amber-900">
            {loadError}
          </div>
        ) : (
          <article className="runbook-prose">
            {renderMarkdown(markdown)}
          </article>
        )}
      </div>
    </div>
  );
}
