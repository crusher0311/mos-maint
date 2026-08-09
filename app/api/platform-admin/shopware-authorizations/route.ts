/**
 * Task #1064 — platform-admin view of Shop-Ware partner authorizations.
 *
 * Lists the tenants that have authorized our Partner API (live from
 * Shop-Ware's GET /partners/{partner_id}/authorizations), enriched with
 * tenant name and shops where cheaply available, so on-call can instantly
 * tell "typo'd tenant ID" from "authorization never completed" when a
 * shop's Connect 404s. Read-only, fetched on demand.
 */

import { NextResponse } from "next/server";
import { requirePlatformAdmin } from "@/lib/auth";
import {
  isConfigured,
  getPartnerAuthorizations,
  getTenant,
  getShops,
} from "@/lib/integrations/shopware/client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Cap live enrichment fan-out so a big partner list can't hammer
// Shop-Ware or stall the admin page.
const ENRICH_CAP = 25;

export async function GET() {
  try {
    await requirePlatformAdmin();
  } catch {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (!isConfigured()) {
    return NextResponse.json({
      ok: false,
      error: "Shop-Ware partner credentials not configured",
    });
  }

  try {
    const auths = await getPartnerAuthorizations();

    const enriched = await Promise.all(
      auths.map(async (a, idx) => {
        const row: {
          tenantId: number;
          writable: boolean;
          tenantName: string | null;
          shops: { id: number; name: string }[] | null;
        } = {
          tenantId: a.tenant_id,
          writable: Boolean(a.writable),
          tenantName: null,
          shops: null,
        };
        if (idx >= ENRICH_CAP) return row;
        const [tenantRes, shopsRes] = await Promise.allSettled([
          getTenant(a.tenant_id),
          getShops(a.tenant_id),
        ]);
        if (tenantRes.status === "fulfilled") row.tenantName = tenantRes.value.name;
        if (shopsRes.status === "fulfilled") {
          row.shops = shopsRes.value.map((s) => ({ id: s.id, name: s.name }));
        }
        return row;
      })
    );

    return NextResponse.json({
      ok: true,
      count: auths.length,
      enrichedCap: ENRICH_CAP,
      authorizations: enriched,
    });
  } catch (err: any) {
    console.error("[Shop-Ware Authorizations] GET error:", err?.message);
    return NextResponse.json(
      { ok: false, error: err?.message || "Failed to fetch authorizations" },
      { status: 500 }
    );
  }
}
