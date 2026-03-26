import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { getDb as getMongoDb } from "@/lib/mongo";
import { getDb } from "@/lib/db/drizzle";
import { productionLogs } from "@/lib/db/schema/logs";
import { desc, gte, ilike, inArray, and, sql } from "drizzle-orm";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function isPlatformAdmin(): Promise<boolean> {
  const store = await cookies();
  const sid = store.get("sid")?.value ?? store.get("session_token")?.value;
  if (!sid) return false;

  const db = await getMongoDb();
  const sess = await db
    .collection("sessions")
    .findOne({ token: sid, expiresAt: { $gt: new Date() } });
  if (!sess) return false;

  const user = await db.collection("users").findOne({ _id: sess.userId });
  return user?.platformAdmin === true;
}

export async function GET(request: NextRequest) {
  if (!(await isPlatformAdmin())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const search = searchParams.get("search") || "";
  const level = searchParams.get("level") || "";
  const source = searchParams.get("source") || "";
  const minutes = Math.min(
    parseInt(searchParams.get("minutes") || "60"),
    43200,
  );
  const limit = Math.min(parseInt(searchParams.get("limit") || "200"), 1000);
  const offset = parseInt(searchParams.get("offset") || "0");

  try {
    const db = getDb();
    const cutoff = new Date(Date.now() - minutes * 60 * 1000);
    const conditions: any[] = [gte(productionLogs.dt, cutoff)];

    if (search) {
      conditions.push(ilike(productionLogs.message, `%${search}%`));
    }

    if (level) {
      const levels = level.split(",").map((l) => l.trim().toLowerCase());
      conditions.push(inArray(productionLogs.level, levels));
    }

    if (source) {
      conditions.push(ilike(productionLogs.appname, `%${source}%`));
    }

    const whereClause = and(...conditions);

    const [logs, countResult] = await Promise.all([
      db
        .select()
        .from(productionLogs)
        .where(whereClause)
        .orderBy(desc(productionLogs.dt))
        .limit(limit)
        .offset(offset),
      db
        .select({ count: sql<number>`count(*)` })
        .from(productionLogs)
        .where(whereClause),
    ]);

    const total = Number(countResult[0]?.count || 0);

    const parsed = logs.map((entry) => {
      let message: any = { text: entry.message || "" };
      if (entry.messageJson && typeof entry.messageJson === "object") {
        const mj = entry.messageJson as any;
        if (mj.message) {
          message =
            typeof mj.message === "object"
              ? mj.message
              : { text: mj.message };
        }
      }

      return {
        dt: entry.dt?.toISOString(),
        level: entry.level || "info",
        message,
        appname: entry.appname || "",
        host: entry.host || "",
        raw: entry.raw || entry.message,
      };
    });

    return NextResponse.json({
      logs: parsed,
      total,
      limit,
      offset,
      source: "supabase",
      query: { search, level, source, minutes },
    });
  } catch (err: any) {
    console.error("[Logs] Supabase query error:", err.message);
    return NextResponse.json({ error: "Failed to query logs" }, { status: 502 });
  }
}
