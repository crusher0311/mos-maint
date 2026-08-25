// Task #884: platform-admin surface for unresolved AutoFlow v4 shop numbers.
// AutoFlow's v4 UI (app.autoflow.com/shop/<number>/...) identifies shops by a
// number that often isn't stored on any shop doc. The extension fails CLOSED
// on such misses (never falls back to the user's primary shop), and the miss
// is recorded in `autoflow_unresolved_numbers`. This route lets a platform
// admin review those misses and manually attach a number to the right shop
// (`autoflow.shopNumbers`).
import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { isAutoflowV4ShopNumber } from "@/lib/autoflow-identity";
import {
  listUnresolvedAutoflowNumbers,
  listAutoflowShops,
  listAutoflowIdentifierConflicts,
  findShopByIdBasic,
  findAutoflowIdentifierClaimConflicts,
  AutoflowIdentifierConflictError,
  AutoflowAliasNotOwnedError,
  attachAutoflowNumber,
  detachAutoflowNumber,
} from "@/lib/data/repositories/autoflow-unresolved-numbers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const session = await getSession();
    if (!session?.isPlatformAdmin) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const [unresolved, shops, conflicts] = await Promise.all([
      listUnresolvedAutoflowNumbers(200),
      listAutoflowShops(),
      listAutoflowIdentifierConflicts(),
    ]);

    return NextResponse.json({
      ok: true,
      unresolved: unresolved.map((u) => ({
        number: u.number,
        firstSeenAt: u.firstSeenAt || null,
        lastSeenAt: u.lastSeenAt || null,
        seenCount: u.seenCount || 0,
        candidateShopIds: u.candidateShopIds || [],
        candidateCount: u.candidateCount ?? (u.candidateShopIds || []).length,
        reason: u.reason || null,
      })),
      shops,
      conflicts,
    });
  } catch (err: any) {
    console.error("[AutoFlow Numbers] GET error:", err?.message || err);
    return NextResponse.json({ error: "Server error" }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const session = await getSession();
    if (!session?.isPlatformAdmin) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const body = await req.json().catch(() => ({}));
    const number = typeof body?.number === "string" ? body.number.trim() : "";
    const shopIdRaw = body?.shopId;
    if (!isAutoflowV4ShopNumber(number)) {
      return NextResponse.json(
        { error: "AutoFlow v4 shop number must contain digits only" },
        { status: 400 },
      );
    }
    const shopId = isNaN(Number(shopIdRaw)) ? shopIdRaw : Number(shopIdRaw);
    if (shopId == null || shopId === "") {
      return NextResponse.json({ error: "shopId required" }, { status: 400 });
    }

    const shop = await findShopByIdBasic(shopId);
    if (!shop) {
      return NextResponse.json({ error: "Shop not found" }, { status: 404 });
    }

    // Guard: a number may only be attached to one shop.
    const conflicts = await findAutoflowIdentifierClaimConflicts(number, shopId);
    if (conflicts.length > 0) {
      const owners = conflicts
        .map((claim) => `${claim.shopId} (${claim.shopName}, ${claim.field})`)
        .join(", ");
      return NextResponse.json(
        { error: `Identifier ${number} is already claimed by ${owners}` },
        { status: 409 },
      );
    }

    await attachAutoflowNumber(shopId, number, session.email || null);

    console.log(`[AutoFlow Numbers] ${session.email} attached AutoFlow number "${number}" to shop ${shopId}`);
    return NextResponse.json({ ok: true });
  } catch (err: any) {
    if (err instanceof AutoflowIdentifierConflictError) {
      return NextResponse.json(
        {
          error: err.message,
          conflicts: err.claims,
        },
        { status: 409 },
      );
    }
    console.error("[AutoFlow Numbers] POST error:", err?.message || err);
    return NextResponse.json({ error: "Server error" }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const session = await getSession();
    if (!session?.isPlatformAdmin) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const body = await req.json().catch(() => ({}));
    const number = typeof body?.number === "string" ? body.number.trim() : "";
    const shopIdRaw = body?.shopId;
    if (!number) {
      return NextResponse.json({ error: "Invalid number" }, { status: 400 });
    }
    const shopId = isNaN(Number(shopIdRaw)) ? shopIdRaw : Number(shopIdRaw);

    await detachAutoflowNumber(shopId, number, session.email || null);

    console.log(`[AutoFlow Numbers] ${session.email} detached AutoFlow number "${number}" from shop ${shopId}`);
    return NextResponse.json({ ok: true });
  } catch (err: any) {
    if (err instanceof AutoflowAliasNotOwnedError) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    console.error("[AutoFlow Numbers] DELETE error:", err?.message || err);
    return NextResponse.json({ error: "Server error" }, { status: 500 });
  }
}
