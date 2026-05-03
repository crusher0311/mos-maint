import { NextResponse } from "next/server";
import path from "path";
import fs from "fs/promises";
import { getSession } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The migration map lives in `lib/migration/entity-map.json` and is updated
// by the dual-write retirement task as entities flip canonical sources. Per
// task #305, this endpoint just surfaces the current state to the platform
// observability page; it is not the source of truth for any application
// behaviour.

interface EntityMap {
  updatedAt?: string;
  notes?: string;
  entities?: Array<{
    name: string;
    state: "mongo-canonical" | "dual-write" | "supabase-canonical" | string;
    notes?: string;
  }>;
}

export async function GET() {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!session.isPlatformAdmin) {
    return NextResponse.json(
      { error: "Forbidden - platform admin access required" },
      { status: 403 },
    );
  }

  try {
    const filePath = path.join(
      process.cwd(),
      "lib",
      "migration",
      "entity-map.json",
    );
    const raw = await fs.readFile(filePath, "utf-8");
    const map = JSON.parse(raw) as EntityMap;
    return NextResponse.json({
      updatedAt: map.updatedAt ?? null,
      notes: map.notes ?? null,
      entities: map.entities ?? [],
    });
  } catch (err: any) {
    return NextResponse.json(
      { error: err?.message || "Failed to read migration map" },
      { status: 500 },
    );
  }
}
