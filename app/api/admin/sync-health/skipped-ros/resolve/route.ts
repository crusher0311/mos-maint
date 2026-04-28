import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/mongo";
import { requirePlatformAdmin } from "@/lib/auth";
import { manuallyResolveSkippedRo } from "@/lib/tekmetric-skipped-ro-resolution";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    const session = await requirePlatformAdmin();

    const body = await req.json().catch(() => ({}));
    const shopId = Number(body.shopId);
    if (!Number.isFinite(shopId)) {
      return NextResponse.json(
        { error: "shopId is required" },
        { status: 400 },
      );
    }

    const rawRoIds: unknown = body.roIds;
    const bulkRoIds: number[] | null = Array.isArray(rawRoIds)
      ? Array.from(
          new Set(
            rawRoIds
              .map((v) => Number(v))
              .filter((n) => Number.isFinite(n)),
          ),
        )
      : null;

    const db = await getDb();

    // Bulk path: resolve every RO id in `roIds` for the shop. Iterates the
    // shared per-RO helper so the archive insert / progress update logic
    // stays in one place; emits one audit log line covering all archived
    // ids and the actor (per task #53).
    if (bulkRoIds !== null) {
      if (bulkRoIds.length === 0) {
        return NextResponse.json(
          { error: "roIds must contain at least one numeric id" },
          { status: 400 },
        );
      }

      const archivedRoIds: number[] = [];
      const failures: { roId: number; error: string }[] = [];
      let lastRemaining: number | null = null;
      let fullyRecovered = false;

      for (const id of bulkRoIds) {
        const r = await manuallyResolveSkippedRo(
          db,
          shopId,
          id,
          session.email,
        );
        if (r.ok) {
          archivedRoIds.push(id);
          lastRemaining = r.remaining;
          fullyRecovered = r.fullyRecovered;
        } else {
          failures.push({ roId: id, error: r.error });
        }
      }

      // Single audit-log line per shop covering all archived RO ids + actor.
      await db.collection("audit_logs").insertOne({
        type: "manual_skipped_ros_bulk_resolved",
        shopId,
        adminEmail: session.email,
        requestedRoIds: bulkRoIds,
        archivedRoIds,
        archivedCount: archivedRoIds.length,
        failureCount: failures.length,
        failures,
        remaining: lastRemaining,
        fullyRecovered,
        createdAt: new Date(),
      });

      console.log(
        `[Admin SyncHealth] ${session.email} bulk-resolved ${archivedRoIds.length}/${bulkRoIds.length} skipped ROs for shop ${shopId} ` +
          `(ids=[${archivedRoIds.join(",")}]` +
          (failures.length > 0
            ? `, failed=[${failures.map((f) => f.roId).join(",")}]`
            : "") +
          `, remaining=${lastRemaining ?? "n/a"}, fullyRecovered=${fullyRecovered})`,
      );

      return NextResponse.json({
        ok: true,
        shopId,
        archivedRoIds,
        archivedCount: archivedRoIds.length,
        failures,
        remaining: lastRemaining,
        fullyRecovered,
      });
    }

    // Single-RO path (original behavior).
    const roId = Number(body.roId);
    if (!Number.isFinite(roId)) {
      return NextResponse.json(
        { error: "roId (or roIds[]) is required" },
        { status: 400 },
      );
    }

    const result = await manuallyResolveSkippedRo(
      db,
      shopId,
      roId,
      session.email,
    );

    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: 404 });
    }

    console.log(
      `[Admin SyncHealth] ${session.email} manually resolved skipped RO ${roId} for shop ${shopId} (remaining=${result.remaining}, fullyRecovered=${result.fullyRecovered})`,
    );

    return NextResponse.json({
      ok: true,
      shopId,
      roId,
      remaining: result.remaining,
      fullyRecovered: result.fullyRecovered,
    });
  } catch (err: any) {
    console.error("[Admin SyncHealth] Manual resolve error:", err);
    return NextResponse.json(
      { error: err?.message || "Failed to resolve skipped RO" },
      { status: 500 },
    );
  }
}
