import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { 
  createEnterprise, 
  getEnterpriseById, 
  addShopToEnterprise, 
  removeShopFromEnterprise 
} from "@/lib/enterprise-pg";
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
    const enterpriseId = searchParams.get("id");
    
    if (enterpriseId) {
      const enterprise = await getEnterpriseById(enterpriseId);
      if (!enterprise) {
        return NextResponse.json({ error: "Enterprise not found" }, { status: 404 });
      }
      
      const availableUsers = enterprise.shop_ids.length > 0 ? await sql`
        SELECT DISTINCT ON (email) id, email, name, role 
        FROM users 
        WHERE shop_id::int = ANY(${enterprise.shop_ids})
        ORDER BY email
      ` : [];
      
      return NextResponse.json({ 
        enterprise: {
          id: enterprise.id,
          name: enterprise.name,
          shopIds: enterprise.shop_ids,
          sharedMappings: enterprise.shared_mappings,
          sharedIntegrations: enterprise.shared_integrations,
          createdAt: enterprise.created_at,
          updatedAt: enterprise.updated_at,
        },
        availableUsers
      });
    }
    
    const enterprises = await sql`SELECT * FROM enterprise_accounts ORDER BY name`;
    return NextResponse.json({ 
      enterprises: enterprises.map(e => ({
        id: e.id,
        name: e.name,
        shopIds: e.shop_ids,
        sharedMappings: e.shared_mappings,
        sharedIntegrations: e.shared_integrations,
        createdAt: e.created_at,
        updatedAt: e.updated_at,
      }))
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
    const { name, shopIds } = body;
    
    if (!name) {
      return NextResponse.json({ error: "Enterprise name is required" }, { status: 400 });
    }
    
    const enterprise = await createEnterprise(name, shopIds || []);
    
    if (shopIds?.length > 0) {
      await sql`
        UPDATE shops 
        SET enterprise_id = ${enterprise.id}, updated_at = NOW()
        WHERE shop_id::int = ANY(${shopIds})
      `;
    }
    
    return NextResponse.json({ 
      enterprise: {
        id: enterprise.id,
        name: enterprise.name,
        shopIds: enterprise.shop_ids,
      }
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function PUT(req: NextRequest) {
  const auth = await requireAdminAuth();
  if ("error" in auth) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }

  try {
    const body = await req.json();
    const { enterpriseId, shopId, action } = body;
    
    if (!enterpriseId) {
      return NextResponse.json({ error: "Enterprise ID is required" }, { status: 400 });
    }
    
    if (action === "add_shop" && shopId) {
      const numericShopId = Number(shopId);
      await addShopToEnterprise(enterpriseId, numericShopId);
      
      const enterprise = await getEnterpriseById(enterpriseId);
      let featuresToCopy: string[] = [];
      let preferencesToCopy: Record<string, unknown> | null = null;
      
      if (enterprise && enterprise.shop_ids.length > 0) {
        const otherShopIds = enterprise.shop_ids.filter((id: number) => Number(id) !== numericShopId);
        console.log(`[Enterprise] Adding shop ${numericShopId} to enterprise. Other shops:`, otherShopIds);
        
        if (otherShopIds.length > 0) {
          const currentUserShopId = auth.session?.shopId ? Number(auth.session.shopId) : null;
          
          const existingShops = await sql<{shop_id: string, settings: Record<string, unknown> | null}[]>`
            SELECT shop_id, settings FROM shops 
            WHERE shop_id::int = ANY(${otherShopIds})
          `;
          
          console.log(`[Enterprise] Found ${existingShops.length} enterprise shops, currentUserShopId: ${currentUserShopId}`);
          
          let sourceShop = currentUserShopId 
            ? existingShops.find((s) => Number(s.shop_id) === Number(currentUserShopId))
            : null;
          
          if (!sourceShop) {
            sourceShop = existingShops.find((s) => {
              const settings = s.settings as Record<string, unknown> | null;
              const enabledFeatures = settings?.enabledFeatures as string[] | undefined;
              return Array.isArray(enabledFeatures) && enabledFeatures.length > 0;
            });
            console.log(`[Enterprise] Using fallback - first shop with features: ${sourceShop?.shop_id || 'none'}`);
          } else {
            console.log(`[Enterprise] Using current user's shop ${sourceShop.shop_id} as source`);
          }
          
          if (sourceShop) {
            const settings = sourceShop.settings as Record<string, unknown> | null;
            const enabledFeatures = settings?.enabledFeatures as string[] | undefined;
            const preferences = settings?.preferences as Record<string, unknown> | undefined;
            
            console.log(`[Enterprise] Source shop ${sourceShop.shop_id} enabledFeatures: ${JSON.stringify(enabledFeatures)?.slice(0, 300)}`);
            if (Array.isArray(enabledFeatures) && enabledFeatures.length > 0) {
              featuresToCopy = enabledFeatures;
            }
            if (preferences && Object.keys(preferences).length > 0) {
              const { jobHistoryShopIds, ...otherPrefs } = preferences as Record<string, unknown>;
              preferencesToCopy = otherPrefs;
            }
            console.log(`[Enterprise] Copying from shop ${sourceShop.shop_id} to new location ${numericShopId}: features=${featuresToCopy.length}, hasPrefs=${!!preferencesToCopy}`);
          } else {
            console.log(`[Enterprise] No source shop found for copying`);
          }
        }
      }
      
      const existingShop = await sql<{settings: Record<string, unknown> | null}[]>`
        SELECT settings FROM shops WHERE shop_id = ${String(numericShopId)} LIMIT 1
      `;
      const existingSettings = existingShop[0]?.settings || {};
      
      const updatedSettings = {
        ...existingSettings,
        ...(featuresToCopy.length > 0 ? { enabledFeatures: featuresToCopy } : {}),
        ...(preferencesToCopy ? { preferences: preferencesToCopy } : {}),
      };
      
      await sql`
        UPDATE shops 
        SET enterprise_id = ${enterpriseId}, 
            settings = ${JSON.stringify(updatedSettings)}::jsonb,
            updated_at = NOW()
        WHERE shop_id = ${String(numericShopId)}
      `;
      
      return NextResponse.json({ 
        ok: true, 
        featuresCopied: featuresToCopy.length,
        preferencesCopied: !!preferencesToCopy 
      });
    }
    
    if (action === "remove_shop" && shopId) {
      await removeShopFromEnterprise(enterpriseId, Number(shopId));
      
      await sql`
        UPDATE shops 
        SET enterprise_id = NULL, updated_at = NOW()
        WHERE shop_id = ${String(shopId)}
      `;
      
      return NextResponse.json({ ok: true });
    }
    
    return NextResponse.json({ error: "Invalid action" }, { status: 400 });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
