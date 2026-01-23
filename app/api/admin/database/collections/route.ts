import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/mongo";
import { getSession } from "@/lib/auth";

export async function GET(req: NextRequest) {
  try {
    const session = await getSession();
    if (!session?.isPlatformAdmin) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const db = await getDb();
    const collectionsCursor = await db.listCollections().toArray();
    
    const collections = await Promise.all(
      collectionsCursor.map(async (coll) => {
        const count = await db.collection(coll.name).estimatedDocumentCount();
        return {
          name: coll.name,
          count
        };
      })
    );

    collections.sort((a, b) => a.name.localeCompare(b.name));

    return NextResponse.json({ collections });
  } catch (error) {
    console.error("Failed to list collections:", error);
    return NextResponse.json({ error: "Failed to list collections" }, { status: 500 });
  }
}
