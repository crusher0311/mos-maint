import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { getEnterpriseById } from "@/lib/enterprise-pg";
import sql from "@/lib/db/postgres";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function requireAdminAuth() {
  const session = await getSession();
  if (!session) {
    return { error: "Unauthorized", status: 401 };
  }
  if (!["owner", "admin"].includes(session.role || "")) {
    return { error: "Forbidden - admin access required", status: 403 };
  }
  return { session };
}

export async function GET(req: NextRequest) {
  const auth = await requireAdminAuth();
  if ("error" in auth) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }

  try {
    const { searchParams } = new URL(req.url);
    const enterpriseId = searchParams.get("enterpriseId");
    
    if (!enterpriseId) {
      return NextResponse.json({ error: "Enterprise ID is required" }, { status: 400 });
    }
    
    const enterprise = await getEnterpriseById(enterpriseId);
    if (!enterprise) {
      return NextResponse.json({ error: "Enterprise not found" }, { status: 404 });
    }
    
    const sharedMappings = enterprise.shared_mappings as Record<string, unknown> | null;
    
    return NextResponse.json({
      mappings: sharedMappings?.cannedJobs || {},
      updatedAt: sharedMappings?.updatedAt
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const auth = await requireAdminAuth();
  if ("error" in auth) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }

  try {
    const body = await req.json();
    const { enterpriseId, mappings, applyToAllShops } = body;
    
    if (!enterpriseId) {
      return NextResponse.json({ error: "Enterprise ID is required" }, { status: 400 });
    }
    
    const now = new Date();
    
    const existingResult = await sql<{shared_mappings: Record<string, unknown> | null}[]>`
      SELECT shared_mappings FROM enterprise_accounts WHERE id = ${enterpriseId} LIMIT 1
    `;
    const existingMappings = existingResult[0]?.shared_mappings || {};
    
    const updatedMappings = {
      ...existingMappings,
      cannedJobs: mappings,
      updatedAt: now.toISOString(),
    };
    
    await sql`
      UPDATE enterprise_accounts 
      SET shared_mappings = ${JSON.stringify(updatedMappings)}::jsonb, updated_at = ${now}
      WHERE id = ${enterpriseId}
    `;
    
    if (applyToAllShops) {
      const enterprise = await getEnterpriseById(enterpriseId);
      if (enterprise && enterprise.shop_ids.length > 0) {
        for (const shopId of enterprise.shop_ids) {
          const shopResult = await sql<{settings: Record<string, unknown> | null}[]>`
            SELECT settings FROM shops WHERE shop_id = ${String(shopId)} LIMIT 1
          `;
          const existingSettings = shopResult[0]?.settings || {};
          
          const updatedSettings = {
            ...existingSettings,
            cannedJobMappings: mappings,
            cannedJobMappingsSource: "enterprise",
          };
          
          await sql`
            UPDATE shops 
            SET settings = ${JSON.stringify(updatedSettings)}::jsonb, updated_at = ${now}
            WHERE shop_id = ${String(shopId)}
          `;
        }
      }
    }
    
    return NextResponse.json({ ok: true });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
