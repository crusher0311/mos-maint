import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import sql from "@/lib/db/postgres";

export async function POST(req: NextRequest) {
  try {
    const session = await getSession();
    if (!session?.isPlatformAdmin) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await req.json();
    const { collection, limit = 20, skip = 0 } = body;

    if (!collection || typeof collection !== "string") {
      return NextResponse.json({ error: "Table name required" }, { status: 400 });
    }

    const safeTableName = collection.replace(/[^a-zA-Z0-9_]/g, '');
    const safeLimit = Math.min(Math.max(1, limit), 100);
    const safeSkip = Math.max(0, skip);

    const startTime = Date.now();
    
    const [documents, countResult] = await Promise.all([
      sql.unsafe(`SELECT * FROM "${safeTableName}" ORDER BY id DESC LIMIT ${safeLimit} OFFSET ${safeSkip}`),
      sql.unsafe(`SELECT COUNT(*) as count FROM "${safeTableName}"`)
    ]);

    const executionTime = Date.now() - startTime;
    const totalCount = Number(countResult[0]?.count || 0);

    return NextResponse.json({
      documents,
      totalCount,
      executionTime
    });
  } catch (error) {
    console.error("Query failed:", error);
    return NextResponse.json({ error: "Query failed" }, { status: 500 });
  }
}
