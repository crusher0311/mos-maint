import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import sql from "@/lib/db/postgres";

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

    let customers;
    if (statusParam && providerParam) {
      customers = limit > 0 
        ? await sql`
            SELECT * FROM customers 
            WHERE shop_id = ${shopId} AND status = ${statusParam} AND provider = ${providerParam}
            ORDER BY opened_at DESC NULLS LAST, created_at DESC NULLS LAST
            LIMIT ${limit}
          `
        : await sql`
            SELECT * FROM customers 
            WHERE shop_id = ${shopId} AND status = ${statusParam} AND provider = ${providerParam}
            ORDER BY opened_at DESC NULLS LAST, created_at DESC NULLS LAST
          `;
    } else if (statusParam) {
      customers = limit > 0
        ? await sql`
            SELECT * FROM customers 
            WHERE shop_id = ${shopId} AND status = ${statusParam}
            ORDER BY opened_at DESC NULLS LAST, created_at DESC NULLS LAST
            LIMIT ${limit}
          `
        : await sql`
            SELECT * FROM customers 
            WHERE shop_id = ${shopId} AND status = ${statusParam}
            ORDER BY opened_at DESC NULLS LAST, created_at DESC NULLS LAST
          `;
    } else {
      customers = limit > 0
        ? await sql`
            SELECT * FROM customers 
            WHERE shop_id = ${shopId}
            ORDER BY opened_at DESC NULLS LAST, created_at DESC NULLS LAST
            LIMIT ${limit}
          `
        : await sql`
            SELECT * FROM customers 
            WHERE shop_id = ${shopId}
            ORDER BY opened_at DESC NULLS LAST, created_at DESC NULLS LAST
          `;
    }

    const formattedCustomers = customers.map(c => ({
      _id: c.id,
      shopId: c.shop_id,
      name: c.name,
      email: c.email,
      phone: c.phone,
      externalId: c.external_id,
      status: c.status,
      openedAt: c.opened_at,
      createdAt: c.created_at,
      provider: c.provider,
    }));

    return NextResponse.json({ ok: true, count: formattedCustomers.length, customers: formattedCustomers });
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

    const shopId = String(session.shopId);
    const now = new Date();

    const result = await sql`
      INSERT INTO customers (shop_id, name, email, phone, external_id, status, opened_at, created_at, created_by, provider)
      VALUES (${shopId}, ${name}, ${email}, ${phone}, ${externalId}, 'open', ${now}, ${now}, ${session.email}, 'manual')
      RETURNING id
    `;

    return NextResponse.json({ ok: true, id: result[0].id });
  } catch (err) {
    console.error("Create customer error:", err);
    return NextResponse.json({ error: "Server error" }, { status: 500 });
  }
}
