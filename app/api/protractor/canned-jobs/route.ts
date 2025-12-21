import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { getDb } from "@/lib/mongo";
import { fetchCannedJobsWithCache } from "@/lib/integrations/protractor";

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

  const refresh = req.nextUrl.searchParams.get("refresh") === "true";
  const maxAge = refresh ? 0 : undefined;

  const result = await fetchCannedJobsWithCache(shopId, maxAge);

  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: 500 });
  }

  return NextResponse.json({
    cannedJobs: result.cannedJobs || [],
    source: result.source,
  });
}
