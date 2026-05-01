/**
 * Detect Dog migration — run detail (GET) including audit log + counts.
 */
import { NextRequest } from "next/server";
import { getDb } from "@/lib/db/drizzle";
import {
  tekmetricMigrationRuns,
  tekmetricMigrationDumps,
  tekmetricMigrationMappings,
  tekmetricMigrationAudit,
} from "@/lib/db/schema/tekmetric-migration";
import { eq, desc } from "drizzle-orm";
import {
  migJson,
  migError,
  migOptions,
  requireMigAdmin,
} from "@/lib/tekmetric-migration/api-auth";

export const OPTIONS = () => migOptions();

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const auth = await requireMigAdmin(request);
  if (!auth.ok) return auth.response;
  const { id } = await context.params;
  const runId = Number(id);
  if (!runId) return migError("invalid run id", 400);

  const db = getDb();
  const [run] = await db
    .select()
    .from(tekmetricMigrationRuns)
    .where(eq(tekmetricMigrationRuns.id, runId))
    .limit(1);
  if (!run) return migError("run not found", 404);

  const [dump] = await db
    .select({
      id: tekmetricMigrationDumps.id,
      rosCount: tekmetricMigrationDumps.rosCount,
      expiresAt: tekmetricMigrationDumps.expiresAt,
      createdAt: tekmetricMigrationDumps.createdAt,
    })
    .from(tekmetricMigrationDumps)
    .where(eq(tekmetricMigrationDumps.runId, runId))
    .orderBy(desc(tekmetricMigrationDumps.createdAt))
    .limit(1);

  const [mapping] = await db
    .select({
      id: tekmetricMigrationMappings.id,
      successesCount: tekmetricMigrationMappings.successesCount,
      failuresCount: tekmetricMigrationMappings.failuresCount,
      reusedCount: tekmetricMigrationMappings.reusedCount,
      confirmed: tekmetricMigrationMappings.confirmed,
      createdAt: tekmetricMigrationMappings.createdAt,
      expiresAt: tekmetricMigrationMappings.expiresAt,
    })
    .from(tekmetricMigrationMappings)
    .where(eq(tekmetricMigrationMappings.runId, runId))
    .orderBy(desc(tekmetricMigrationMappings.createdAt))
    .limit(1);

  const audit = await db
    .select()
    .from(tekmetricMigrationAudit)
    .where(eq(tekmetricMigrationAudit.runId, runId))
    .orderBy(desc(tekmetricMigrationAudit.createdAt))
    .limit(200);

  return migJson({ run, dump: dump || null, mapping: mapping || null, audit });
}
