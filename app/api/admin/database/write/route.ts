import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/mongo";
import { getSession } from "@/lib/auth";
import { isSuperAdmin } from "@/lib/super-admins";
import { ObjectId } from "mongodb";

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
    const { action, collection, documentId, document, filter } = body;

    if (!collection || typeof collection !== "string") {
      return NextResponse.json({ error: "Collection name required" }, { status: 400 });
    }

    const db = await getDb();
    const coll = db.collection(collection);

    switch (action) {
      case "insert": {
        if (!document || typeof document !== "object") {
          return NextResponse.json({ error: "Document required for insert" }, { status: 400 });
        }
        const result = await coll.insertOne(document);
        return NextResponse.json({ 
          success: true, 
          action: "insert",
          insertedId: result.insertedId 
        });
      }

      case "update": {
        if (!documentId) {
          return NextResponse.json({ error: "Document ID required for update" }, { status: 400 });
        }
        if (!document || typeof document !== "object") {
          return NextResponse.json({ error: "Document required for update" }, { status: 400 });
        }
        
        const docCopy = { ...document };
        delete docCopy._id;
        
        let objectId;
        try {
          objectId = new ObjectId(documentId);
        } catch {
          return NextResponse.json({ error: "Invalid document ID format" }, { status: 400 });
        }

        const result = await coll.replaceOne(
          { _id: objectId },
          docCopy
        );
        return NextResponse.json({ 
          success: true, 
          action: "update",
          matchedCount: result.matchedCount,
          modifiedCount: result.modifiedCount
        });
      }

      case "delete": {
        if (!documentId) {
          return NextResponse.json({ error: "Document ID required for delete" }, { status: 400 });
        }
        
        let objectId;
        try {
          objectId = new ObjectId(documentId);
        } catch {
          return NextResponse.json({ error: "Invalid document ID format" }, { status: 400 });
        }

        const result = await coll.deleteOne({ _id: objectId });
        return NextResponse.json({ 
          success: true, 
          action: "delete",
          deletedCount: result.deletedCount
        });
      }

      case "deleteMany": {
        if (!filter || typeof filter !== "object") {
          return NextResponse.json({ error: "Filter required for deleteMany" }, { status: 400 });
        }
        
        const result = await coll.deleteMany(filter);
        return NextResponse.json({ 
          success: true, 
          action: "deleteMany",
          deletedCount: result.deletedCount
        });
      }

      default:
        return NextResponse.json({ error: "Invalid action. Use: insert, update, delete, deleteMany" }, { status: 400 });
    }
  } catch (error) {
    console.error("Write operation failed:", error);
    return NextResponse.json({ error: "Write operation failed" }, { status: 500 });
  }
}
