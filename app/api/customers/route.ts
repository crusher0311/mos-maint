// app/api/customers/route.ts
import { NextResponse } from "next/server";
import { getDb } from "@/lib/mongo";
import { getSession } from "@/lib/auth";

// Ensure fresh data (no static caching)
export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET(req: Request) {
  try {
    const session = await getSession();
    if (!session) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const url = new URL(req.url);
    const statusParam = url.searchParams.get("status") ?? "open"; // default to open customers
    const providerParam = url.searchParams.get("provider") ?? undefined;

    // limit handling: 0 = no limit (show all)
    const rawLimit = Number(
      url.searchParams.get("limit") ?? process.env.DEFAULT_CUSTOMERS_LIMIT ?? "0"
    );
    const limit = Number.isFinite(rawLimit) && rawLimit >= 0 ? Math.min(rawLimit, 500) : 0;

    const db = await getDb();

    // Normalize shopId type to avoid mismatches
    const shopId = String(session.shopId);

    const query: Record<string, any> = { shopId };
    if (statusParam) query.status = statusParam;              // "open" | "closed" | etc.
    if (providerParam) query.provider = providerParam;        // e.g., "autoflow"

    // Prefer openedAt desc, else createdAt desc
    const sort = { openedAt: -1, createdAt: -1 };

    const cursor = db.collection("customers").find(query).sort(sort);
    if (limit > 0) cursor.limit(limit);

    const customers = await cursor.toArray();
    return NextResponse.json({ ok: true, count: customers.length, customers });
  } catch (err) {
    console.error("Fetch customers error:", err);
    return NextResponse.json({ error: "Server error" }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const session = await getSession();
    if (!session) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const payload = await req.json().catch(() => ({}));
    let { name, email, phone, externalId } = payload || {};

    // Normalize
    name = typeof name === "string" ? name.trim() : null;
    email = typeof email === "string" ? email.trim().toLowerCase() : null;
    phone = typeof phone === "string" ? phone.trim() : null;
    externalId = typeof externalId === "string" ? externalId.trim() : null;

    // Basic validation
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return NextResponse.json({ error: "Invalid email" }, { status: 400 });
    }

    const db = await getDb();
    const doc = {
      shopId: String(session.shopId),
      name,
      email,
      phone,
      externalId,
      status: "open",            // default new customers to open
      openedAt: new Date(),      // aligns with webhook upserts
      createdAt: new Date(),
      createdBy: session.email,
      provider: "manual",        // helpful to distinguish origin
    };

    const result = await db.collection("customers").insertOne(doc);
    return NextResponse.json({ ok: true, id: String(result.insertedId) });
  } catch (err) {
    console.error("Create customer error:", err);
    return NextResponse.json({ error: "Server error" }, { status: 500 });
  }
}
