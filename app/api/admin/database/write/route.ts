import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { isSuperAdmin } from "@/lib/super-admins";
import sql from "@/lib/db/postgres";

export async function POST(req: NextRequest) {
  try {
    const session = await getSession();
    if (!session?.isPlatformAdmin) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    if (!isSuperAdmin(session.email)) {
      return NextResponse.json({ error: "Write access denied. Super admin privileges required." }, { status: 403 });
    }

    const body = await req.json();
    const { action, collection, documentId } = body;

    if (!collection || typeof collection !== "string") {
      return NextResponse.json({ error: "Table name required" }, { status: 400 });
    }

    const safeTableName = collection.replace(/[^a-zA-Z0-9_]/g, '');

    switch (action) {
      case "delete": {
        if (!documentId) {
          return NextResponse.json({ error: "Document ID required for delete" }, { status: 400 });
        }

        const result = await sql.unsafe(
          `DELETE FROM "${safeTableName}" WHERE id = $1`,
          [documentId]
        );
        return NextResponse.json({ 
          success: true, 
          action: "delete",
          deletedCount: result.count || 0
        });
      }

      default:
        return NextResponse.json({ 
          error: "Only delete action is supported for safety. Use proper API endpoints for inserts/updates." 
        }, { status: 400 });
    }
  } catch (error) {
    console.error("Write operation failed:", error);
    return NextResponse.json({ error: "Write operation failed" }, { status: 500 });
  }
}
