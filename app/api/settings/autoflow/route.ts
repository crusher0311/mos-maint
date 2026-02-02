import { NextResponse } from "next/server";
import { getDb } from "@/lib/mongo";
import { requireSession } from "@/lib/auth";
import crypto from "crypto";

export const runtime = "nodejs";

export async function GET() {
  try {
    const session = await requireSession();
    const shopId = Number(session.shopId);

    const db = await getDb();
    const shop = await db.collection("shops").findOne(
      { shopId },
      { projection: { autoflowDomain: 1, autoflowApiKey: 1, autoflowApiPassword: 1, webhookToken: 1 } }
    );

    let webhookToken = shop?.webhookToken;
    if (!webhookToken) {
      webhookToken = crypto.randomBytes(12).toString("hex");
      await db.collection("shops").updateOne(
        { shopId },
        { $set: { webhookToken } }
      );
    }

    return NextResponse.json({
      autoflowDomain: shop?.autoflowDomain || "",
      autoflowApiKey: shop?.autoflowApiKey || "",
      autoflowApiPassword: shop?.autoflowApiPassword || "",
      configured: Boolean(shop?.autoflowDomain && shop?.autoflowApiKey),
      webhookToken,
    });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || "Unexpected error" }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const { domain, apiKey, apiPassword, shopId: bodyShopId, autoflowDomain, autoflowApiKey, autoflowApiPassword } = body || {};
    const session = await requireSession();
    const shopId = Number(session.shopId);

    if (bodyShopId && Number(bodyShopId) !== shopId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const domainValue = domain || autoflowDomain || "";
    const keyValue = apiKey || autoflowApiKey || "";
    const passwordValue = apiPassword || autoflowApiPassword || "";

    const normalizedDomain = String(domainValue)
      .replace(/^https?:\/\//i, "")
      .replace(/\/.*$/, "")
      .replace(/[./]+$/, "");

    const db = await getDb();
    await db.collection("shops").updateOne(
      { shopId },
      {
        $set: {
          autoflowDomain: normalizedDomain,
          autoflowApiKey: String(keyValue),
          autoflowApiPassword: String(passwordValue),
        },
      },
      { upsert: true }
    );

    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || "Unexpected error" }, { status: 500 });
  }
}

export async function DELETE() {
  try {
    const session = await requireSession();
    const shopId = Number(session.shopId);

    const db = await getDb();
    await db.collection("shops").updateOne(
      { shopId },
      {
        $unset: {
          autoflowDomain: "",
          autoflowApiKey: "",
          autoflowApiPassword: "",
        },
        $set: { updatedAt: new Date() },
      }
    );

    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || "Unexpected error" }, { status: 500 });
  }
}
