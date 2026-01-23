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
    
    const userCollections = collectionsCursor.filter(
      coll => !coll.name.startsWith("system.")
    );
    
    const collections = await Promise.all(
      userCollections.map(async (coll) => {
        try {
          const count = await db.collection(coll.name).estimatedDocumentCount();
          return {
            name: coll.name,
            count
          };
        } catch {
          return {
            name: coll.name,
            count: 0
          };
        }
      })
    );

    collections.sort((a, b) => a.name.localeCompare(b.name));

    return NextResponse.json({ collections });
  } catch (error) {
    console.error("Failed to list collections:", error);
    return NextResponse.json({ error: "Failed to list collections" }, { status: 500 });
  }
}
