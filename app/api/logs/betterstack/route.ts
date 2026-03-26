import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { getDb } from "@/lib/mongo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const BETTERSTACK_HOST = process.env.BETTERSTACK_QUERY_HOST;
const BETTERSTACK_USER = process.env.BETTERSTACK_QUERY_USERNAME;
const BETTERSTACK_PASS = process.env.BETTERSTACK_QUERY_PASSWORD;
const BETTERSTACK_SOURCE = process.env.BETTERSTACK_QUERY_SOURCE || "t500063_mos_production";

async function isPlatformAdmin(): Promise<boolean> {
  const store = await cookies();
  const sid = store.get("sid")?.value ?? store.get("session_token")?.value;
  if (!sid) return false;

  const db = await getDb();
  const sess = await db.collection("sessions").findOne({ token: sid, expiresAt: { $gt: new Date() } });
  if (!sess) return false;

  const user = await db.collection("users").findOne({ _id: sess.userId });
  return user?.platformAdmin === true;
}

function escapeClickhouse(str: string): string {
  return str.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

export async function GET(request: NextRequest) {
  if (!(await isPlatformAdmin())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (!BETTERSTACK_HOST || !BETTERSTACK_USER || !BETTERSTACK_PASS) {
    return NextResponse.json(
      { error: "Better Stack Query API not configured" },
      { status: 500 }
    );
  }

  const { searchParams } = new URL(request.url);
  const search = searchParams.get("search") || "";
  const level = searchParams.get("level") || "";
  const source = searchParams.get("source") || "";
  const minutes = parseInt(searchParams.get("minutes") || "60");
  const limit = Math.min(parseInt(searchParams.get("limit") || "200"), 1000);
  const offset = parseInt(searchParams.get("offset") || "0");

  const timeFilter = `dt >= now() - INTERVAL ${Math.min(minutes, 10080)} MINUTE`;

  const conditions: string[] = [timeFilter];

  if (search) {
    conditions.push(`raw LIKE '%${escapeClickhouse(search)}%'`);
  }

  if (level) {
    const levels = level.split(",").map((l) => `'${escapeClickhouse(l.trim())}'`).join(",");
    conditions.push(
      `(extractAllGroupsVertical(raw, '"level":"([^"]*)"')[1][1] IN (${levels}))`
    );
  }

  if (source) {
    conditions.push(
      `raw LIKE '%"appname":"${escapeClickhouse(source)}"%'`
    );
  }

  const whereClause = conditions.join(" AND ");

  const countQuery = `SELECT count() as total FROM remote(${BETTERSTACK_SOURCE}_logs) WHERE ${whereClause} FORMAT JSONEachRow`;

  const dataQuery = `SELECT dt, raw FROM remote(${BETTERSTACK_SOURCE}_logs) WHERE ${whereClause} ORDER BY dt DESC LIMIT ${limit} OFFSET ${offset} FORMAT JSONEachRow SETTINGS output_format_json_array_of_rows = 1`;

  const endpoint = `https://${BETTERSTACK_HOST}?output_format_pretty_row_numbers=0`;
  const auth = Buffer.from(`${BETTERSTACK_USER}:${BETTERSTACK_PASS}`).toString("base64");
  const headers = {
    Authorization: `Basic ${auth}`,
    "Content-Type": "plain/text",
  };

  try {
    const [dataRes, countRes] = await Promise.all([
      fetch(endpoint, { method: "POST", headers, body: dataQuery }),
      fetch(endpoint, { method: "POST", headers, body: countQuery }),
    ]);

    if (!dataRes.ok) {
      const errText = await dataRes.text();
      console.error("[BetterStack] Query error:", errText);
      return NextResponse.json(
        { error: "Log query failed" },
        { status: 502 }
      );
    }

    const rawData = await dataRes.text();
    let logs: any[] = [];
    try {
      logs = JSON.parse(rawData || "[]");
    } catch {
      const lines = rawData.trim().split("\n").filter(Boolean);
      logs = lines.map((line) => {
        try { return JSON.parse(line); } catch { return null; }
      }).filter(Boolean);
    }

    let total = logs.length;
    try {
      const countText = await countRes.text();
      const countParsed = JSON.parse(countText.trim().split("\n")[0] || "{}");
      total = parseInt(countParsed.total) || logs.length;
    } catch {}

    const parsed = logs.map((entry: any) => {
      try {
        const raw = typeof entry.raw === "string" ? JSON.parse(entry.raw) : entry.raw;
        const message = typeof raw.message === "object"
          ? raw.message
          : { text: raw.message || "" };

        return {
          dt: entry.dt || raw.dt,
          level: raw.level || "info",
          message,
          appname: raw.syslog?.appname || "",
          host: raw.syslog?.host || "",
          raw: entry.raw,
        };
      } catch {
        return {
          dt: entry.dt,
          level: "unknown",
          message: { text: entry.raw || "" },
          appname: "",
          host: "",
          raw: entry.raw,
        };
      }
    });

    return NextResponse.json({
      logs: parsed,
      total,
      limit,
      offset,
      query: { search, level, source, minutes },
    });
  } catch (err: any) {
    console.error("[BetterStack] Connection error:", err.message);
    return NextResponse.json(
      { error: "Failed to query logs" },
      { status: 502 }
    );
  }
}
