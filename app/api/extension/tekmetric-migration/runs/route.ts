/**
 * Detect Dog migration — list runs (GET) / create run (POST).
 */
import { NextRequest } from "next/server";
import { getDb } from "@/lib/db/drizzle";
import { tekmetricMigrationRuns } from "@/lib/db/schema/tekmetric-migration";
import { desc } from "drizzle-orm";
import {
  migJson,
  migError,
  migOptions,
  requireMigAdmin,
} from "@/lib/tekmetric-migration/api-auth";
import { getTokenStatus } from "@/lib/tekmetric-migration/tokenCache";

export const OPTIONS = () => migOptions();

export async function GET(request: NextRequest) {
  const auth = await requireMigAdmin(request);
  if (!auth.ok) return auth.response;
  const db = getDb();
  const rows = await db
    .select()
    .from(tekmetricMigrationRuns)
    .orderBy(desc(tekmetricMigrationRuns.createdAt))
    .limit(100);
  return migJson({ runs: rows });
}

export async function POST(request: NextRequest) {
  const auth = await requireMigAdmin(request);
  if (!auth.ok) return auth.response;
  let body: any;
  try {
    body = await request.json();
  } catch {
    return migError("invalid JSON body", 400);
  }
  const sourceShopId = Number(body.sourceShopId);
  const destShopId = Number(body.destShopId);
  if (!sourceShopId || !destShopId) {
    return migError("sourceShopId and destShopId required", 400);
  }
  if (sourceShopId === destShopId) {
    return migError("sourceShopId and destShopId must differ", 400);
  }

  // Pre-check both tokens exist (don't require fresh — operator may want
  // to start the run and refresh tokens later before confirming).
  const [srcStatus, dstStatus] = await Promise.all([
    getTokenStatus(sourceShopId),
    getTokenStatus(destShopId),
  ]);

  const db = getDb();
  const [run] = await db
    .insert(tekmetricMigrationRuns)
    .values({
      sourceShopId,
      sourceShopName: body.sourceShopName || null,
      destShopId,
      destShopName: body.destShopName || null,
      status: "created",
      counts: {},
      createdBy: auth.user.id || auth.user.email || "unknown",
      createdByEmail: auth.user.email,
      notes: body.notes || null,
    })
    .returning();

  return migJson({
    run,
    tokens: { source: srcStatus, dest: dstStatus },
  });
}
