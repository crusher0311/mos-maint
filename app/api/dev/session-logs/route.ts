import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/mongo";
import { ObjectId } from "mongodb";

const COLLECTION = "dev_session_logs";

export async function GET(req: NextRequest) {
  try {
    const db = await getDb();
    const { searchParams } = new URL(req.url);

    const topic = searchParams.get("topic");
    const tag = searchParams.get("tag");
    const search = searchParams.get("search");
    const limit = Math.min(parseInt(searchParams.get("limit") || "50"), 200);
    const offset = parseInt(searchParams.get("offset") || "0");

    const filter: any = {};
    if (topic) filter.topic = { $regex: topic, $options: "i" };
    if (tag) filter.tags = tag;
    if (search) {
      filter.$or = [
        { topic: { $regex: search, $options: "i" } },
        { summary: { $regex: search, $options: "i" } },
        { "entries.content": { $regex: search, $options: "i" } },
      ];
    }

    const [logs, total] = await Promise.all([
      db.collection(COLLECTION)
        .find(filter)
        .sort({ updatedAt: -1 })
        .skip(offset)
        .limit(limit)
        .toArray(),
      db.collection(COLLECTION).countDocuments(filter),
    ]);

    return NextResponse.json({ ok: true, logs, total });
  } catch (err: any) {
    return NextResponse.json({ ok: false, error: err.message }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const db = await getDb();
    const body = await req.json();

    const { topic, summary, entries, tags, sessionDate } = body;
    if (!topic) {
      return NextResponse.json({ ok: false, error: "topic is required" }, { status: 400 });
    }

    const now = new Date();
    const doc = {
      topic,
      summary: summary || "",
      entries: (entries || []).map((e: any) => ({
        type: e.type || "note",
        content: e.content || "",
        timestamp: e.timestamp || now.toISOString(),
      })),
      tags: tags || [],
      sessionDate: sessionDate || now.toISOString().split("T")[0],
      createdAt: now,
      updatedAt: now,
    };

    const result = await db.collection(COLLECTION).insertOne(doc);
    return NextResponse.json({ ok: true, id: result.insertedId, doc });
  } catch (err: any) {
    return NextResponse.json({ ok: false, error: err.message }, { status: 500 });
  }
}

export async function PATCH(req: NextRequest) {
  try {
    const db = await getDb();
    const body = await req.json();

    const { id, entry, summary, tags } = body;
    if (!id) {
      return NextResponse.json({ ok: false, error: "id is required" }, { status: 400 });
    }

    const update: any = { $set: { updatedAt: new Date() } };

    if (entry) {
      update.$push = {
        entries: {
          type: entry.type || "note",
          content: entry.content,
          timestamp: entry.timestamp || new Date().toISOString(),
        },
      };
    }
    if (summary) update.$set.summary = summary;
    if (tags) update.$set.tags = tags;

    const result = await db.collection(COLLECTION).updateOne(
      { _id: new ObjectId(id) },
      update
    );

    if (result.matchedCount === 0) {
      return NextResponse.json({ ok: false, error: "Log not found" }, { status: 404 });
    }

    return NextResponse.json({ ok: true, modified: result.modifiedCount });
  } catch (err: any) {
    return NextResponse.json({ ok: false, error: err.message }, { status: 500 });
  }
}
