// app/api/admin/shops/[shopId]/autoflow/route.ts
import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/auth";
import { getDb } from "@/lib/mongo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_req: NextRequest, ctx: { params: { shopId: string } }) {
  const sess = await requireSession();
  const shopId = Number(ctx.params.shopId);
  if (!shopId || shopId !== Number(sess.shopId)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const db = await getDb();
  const shop = await db.collection("shops").findOne(
    { shopId },
    { projection: { autoflow: 1 } }
  );

  const autoflow = {
    subdomain: shop?.autoflow?.subdomain || "",
    apiKey: shop?.autoflow?.apiKey || "",
    // do NOT return password; client will re-enter if changing
  };

  return NextResponse.json({ ok: true, autoflow });
}

export async function PUT(req: NextRequest, ctx: { params: { shopId: string } }) {
  const sess = await requireSession();
  const shopId = Number(ctx.params.shopId);
  if (!shopId || shopId !== Number(sess.shopId)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = await req.json().catch(() => ({}));
  const subdomain = String(body.subdomain || "").trim();
  const apiKey = String(body.apiKey || "").trim();
  const apiPassword = String(body.apiPassword || "").trim(); // may be empty when not changing

  const db = await getDb();

  const set: any = {
    "autoflow.subdomain": subdomain || null,
    "autoflow.apiKey": apiKey || null,
    updatedAt: new Date(),
  };
  if (apiPassword) {
    set["autoflow.apiPassword"] = apiPassword;
  }

  await db.collection("shops").updateOne(
    { shopId },
    { $set: set },
    { upsert: true }
  );

  return NextResponse.json({ ok: true });
}
