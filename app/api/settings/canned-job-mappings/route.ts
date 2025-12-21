import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { getDb } from "@/lib/mongo";

export async function GET(req: NextRequest) {
  const cookieStore = cookies();
  const sessionToken = cookieStore.get("session")?.value;

  if (!sessionToken) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const db = await getDb();
  const session = await db.collection("sessions").findOne({ token: sessionToken });
  if (!session) {
    return NextResponse.json({ error: "Invalid session" }, { status: 401 });
  }

  const shopId = session.shopId;
  if (!shopId) {
    return NextResponse.json({ error: "No shop associated" }, { status: 400 });
  }

  const shop = await db.collection("shops").findOne(
    { shopId },
    { projection: { "protractor.cannedJobMappings": 1 } }
  );

  return NextResponse.json({
    mappings: shop?.protractor?.cannedJobMappings || {},
  });
}

export async function POST(req: NextRequest) {
  const cookieStore = cookies();
  const sessionToken = cookieStore.get("session")?.value;

  if (!sessionToken) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const db = await getDb();
  const session = await db.collection("sessions").findOne({ token: sessionToken });
  if (!session) {
    return NextResponse.json({ error: "Invalid session" }, { status: 401 });
  }

  const shopId = session.shopId;
  if (!shopId) {
    return NextResponse.json({ error: "No shop associated" }, { status: 400 });
  }

  let body: { mappings?: Record<string, string> };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { mappings } = body;
  if (!mappings || typeof mappings !== "object") {
    return NextResponse.json({ error: "Invalid mappings format" }, { status: 400 });
  }

  await db.collection("shops").updateOne(
    { shopId },
    {
      $set: {
        "protractor.cannedJobMappings": mappings,
        "protractor.cannedJobMappingsUpdatedAt": new Date(),
      },
    }
  );

  return NextResponse.json({ ok: true });
}
