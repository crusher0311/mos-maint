import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/mongo";
import { getSession } from "@/lib/auth";

export async function POST(req: NextRequest) {
  try {
    const session = await getSession();
    if (!session?.isPlatformAdmin) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await req.json();
    const { collection, filter = {}, limit = 20, skip = 0, sort = { _id: -1 } } = body;

    if (!collection || typeof collection !== "string") {
      return NextResponse.json({ error: "Collection name required" }, { status: 400 });
    }

    const safeLimit = Math.min(Math.max(1, limit), 100);
    const safeSkip = Math.max(0, skip);

    const db = await getDb();
    const coll = db.collection(collection);

    const startTime = Date.now();
    
    const [documents, totalCount] = await Promise.all([
      coll.find(filter).sort(sort).skip(safeSkip).limit(safeLimit).toArray(),
      coll.countDocuments(filter)
    ]);

    const executionTime = Date.now() - startTime;

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
