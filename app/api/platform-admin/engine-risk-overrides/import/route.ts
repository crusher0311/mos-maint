import { NextRequest, NextResponse } from "next/server";
import { requirePlatformAdmin } from "@/lib/auth";
import { getDb } from "@/lib/mongo";
import {
  ENGINE_RISK_OVERRIDES_COLLECTION,
  deleteEngineRiskOverride,
  insertEngineRiskOverride,
  updateEngineRiskOverride,
  type EngineRiskOverride,
  type EngineRiskOverrideWriteInput,
} from "@/lib/engine-risk";
import {
  computeOverrideDiff,
  InvalidOverrideCsvError,
  parseOverridesCsv,
  type OverrideDiff,
} from "@/lib/engine-risk-csv";

export const runtime = "nodejs";

function unauthorized(error: unknown) {
  const msg = (error as { message?: string })?.message ?? "";
  return msg.toLowerCase().includes("unauthorized");
}

interface ApplyResult {
  inserted: number;
  updated: number;
  removed: number;
  unchanged: number;
}

function toWriteInput(o: EngineRiskOverride): EngineRiskOverrideWriteInput {
  return {
    label: o.label,
    reason: o.reason,
    action: o.action,
    match: o.match,
  };
}

async function applyDiff(
  db: Awaited<ReturnType<typeof getDb>>,
  diff: OverrideDiff,
  adminEmail: string | null,
): Promise<ApplyResult> {
  const result: ApplyResult = { inserted: 0, updated: 0, removed: 0, unchanged: 0 };

  for (const entry of diff.entries) {
    if (entry.status === "add" && entry.next) {
      await insertEngineRiskOverride(db, toWriteInput(entry.next), adminEmail);
      result.inserted++;
    } else if (entry.status === "update" && entry.next && entry._id) {
      await updateEngineRiskOverride(db, entry._id, toWriteInput(entry.next), adminEmail);
      result.updated++;
    } else if (entry.status === "remove" && entry._id) {
      await deleteEngineRiskOverride(db, entry._id);
      result.removed++;
    } else if (entry.status === "unchanged") {
      result.unchanged++;
    }
  }

  return result;
}

export async function POST(request: NextRequest) {
  try {
    const session = await requirePlatformAdmin();
    const db = await getDb();
    const body = await request.json().catch(() => ({}));
    const csv = typeof body.csv === "string" ? body.csv : "";
    const apply = body.apply === true;

    // Allow header-only CSV: that's how an admin signals "remove all
    // overrides" by uploading an emptied spreadsheet. Only the truly
    // empty payload (no body at all) is rejected.
    if (!csv.length) {
      return NextResponse.json(
        { ok: false, error: "csv body is required" },
        { status: 400 },
      );
    }

    let parsed;
    try {
      parsed = parseOverridesCsv(csv);
    } catch (err: any) {
      const msg =
        err instanceof InvalidOverrideCsvError
          ? err.message
          : `CSV parse failed: ${err?.message ?? String(err)}`;
      return NextResponse.json({ ok: false, error: msg }, { status: 400 });
    }

    const current = await db
      .collection<EngineRiskOverride>(ENGINE_RISK_OVERRIDES_COLLECTION)
      .find({})
      .toArray();

    const diff = computeOverrideDiff(parsed, current);

    if (!apply) {
      return NextResponse.json({ ok: true, applied: false, diff });
    }

    if (diff.summary.errors > 0) {
      return NextResponse.json(
        {
          ok: false,
          error: `Refusing to apply: ${diff.summary.errors} row(s) have validation errors`,
          diff,
        },
        { status: 400 },
      );
    }

    const adminEmail =
      typeof (session as { email?: unknown }).email === "string"
        ? ((session as { email: string }).email)
        : null;
    const result = await applyDiff(db, diff, adminEmail);

    return NextResponse.json({ ok: true, applied: true, diff, result });
  } catch (error: any) {
    if (unauthorized(error)) {
      return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
    }
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }
}
