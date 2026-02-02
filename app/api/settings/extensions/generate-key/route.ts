import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/mongo";
import { getSession } from "@/lib/auth";
import crypto from "node:crypto";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST() {
  const sess = await getSession();
  if (!sess) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  if (sess.role !== "owner" && sess.role !== "admin") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const apiKey = `mos_ext_${crypto.randomBytes(24).toString("hex")}`;

  const db = await getDb();
  await db.collection("shops").updateOne(
    { shopId: sess.shopId },
    {
      $push: {
        "extensions.apiKeys": {
          key: apiKey,
          createdAt: new Date(),
        },
      } as any,
      $set: { updatedAt: new Date() },
    }
  );

  return NextResponse.json({ key: apiKey });
}
