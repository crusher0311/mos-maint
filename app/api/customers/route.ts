// app/api/customers/route.ts
import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import {
  findCustomers,
  insertCustomer,
} from "@/lib/data/repositories/customers";

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
    const statusParam = url.searchParams.get("status") ?? "open";
    const providerParam = url.searchParams.get("provider") ?? undefined;

    const rawLimit = Number(
      url.searchParams.get("limit") ?? process.env.DEFAULT_CUSTOMERS_LIMIT ?? "0"
    );
    const limit = Number.isFinite(rawLimit) && rawLimit >= 0 ? Math.min(rawLimit, 500) : 0;

    const shopId = String(session.shopId);

    const query: Record<string, any> = { shopId };
    if (statusParam) query.status = statusParam;
    if (providerParam) query.provider = providerParam;

    const customers = await findCustomers(query, {
      sort: { openedAt: -1, createdAt: -1 },
      limit,
    });

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

    name = typeof name === "string" ? name.trim() : null;
    email = typeof email === "string" ? email.trim().toLowerCase() : null;
    phone = typeof phone === "string" ? phone.trim() : null;
    externalId = typeof externalId === "string" ? externalId.trim() : null;

    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return NextResponse.json({ error: "Invalid email" }, { status: 400 });
    }

    const insertedId = await insertCustomer({
      shopId: String(session.shopId),
      name,
      email,
      phone,
      externalId,
      status: "open",
      openedAt: new Date(),
      createdAt: new Date(),
      createdBy: session.email,
      provider: "manual",
    });

    return NextResponse.json({ ok: true, id: String(insertedId) });
  } catch (err) {
    console.error("Create customer error:", err);
    return NextResponse.json({ error: "Server error" }, { status: 500 });
  }
}
