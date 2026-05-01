import { NextRequest, NextResponse } from "next/server";
import { headers } from "next/headers";
import type { WithId } from "mongodb";
import { requirePlatformAdmin } from "@/lib/auth";
import {
  getAuditLogsCursor,
  logAdminAction,
  type AuditAction,
  type AuditLogEntry,
} from "@/lib/audit-log";

type AuditLogDoc = WithId<AuditLogEntry>;

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ALLOWED_ACTIONS: AuditAction[] = [
  "impersonation",
  "shop_unlock",
  "shop_lock",
  "user_password_reset",
  "billing_override",
  "feature_toggle",
  "shop_settings_change",
  "user_role_change",
  "api_key_view",
  "data_export",
  "build_ro_from_vhi",
];

const ALLOWED_DAYS = [1, 7, 30, 90];

const CSV_COLUMNS = [
  "timestamp",
  "action",
  "admin_email",
  "target_user_email",
  "target_shop_id",
  "target_shop_name",
  "sessions_revoked",
  "ip_address",
  "user_agent",
] as const;

function csvEscape(value: unknown): string {
  if (value === null || value === undefined) return "";
  const s = String(value);
  if (s === "") return "";
  if (/[",\r\n]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function formatTimestamp(raw: AuditLogDoc["createdAt"] | undefined): string {
  if (!raw) return "";
  if (raw instanceof Date) return raw.toISOString();
  const d = new Date(raw as unknown as string | number);
  if (!isNaN(d.getTime())) return d.toISOString();
  return "";
}

function extractSessionsRevoked(details: AuditLogEntry["details"]): number | "" {
  if (!details || typeof details !== "object") return "";
  const value = (details as Record<string, unknown>).sessionsRevoked;
  return typeof value === "number" ? value : "";
}

function buildRow(doc: AuditLogDoc): string {
  const cells: ReadonlyArray<string | number> = [
    formatTimestamp(doc.createdAt),
    doc.action ?? "",
    doc.adminEmail ?? "",
    doc.targetUserEmail ?? "",
    doc.targetShopId ?? "",
    doc.targetShopName ?? "",
    extractSessionsRevoked(doc.details),
    doc.ipAddress ?? "",
    doc.userAgent ?? "",
  ];

  return cells.map(csvEscape).join(",") + "\r\n";
}

export async function GET(request: NextRequest) {
  const session = await requirePlatformAdmin();

  const { searchParams } = new URL(request.url);

  const actionParam = (searchParams.get("action") || "").trim();
  const action = ALLOWED_ACTIONS.includes(actionParam as AuditAction)
    ? (actionParam as AuditAction)
    : undefined;

  const daysRaw = parseInt(searchParams.get("days") || "7", 10);
  const days = ALLOWED_DAYS.includes(daysRaw) ? daysRaw : 7;

  const adminEmail = (searchParams.get("adminEmail") || "").trim() || undefined;

  const shopIdParam = searchParams.get("shopId");
  const targetShopId =
    shopIdParam && !isNaN(Number(shopIdParam)) ? Number(shopIdParam) : undefined;

  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  let cursor: Awaited<ReturnType<typeof getAuditLogsCursor>>;
  try {
    cursor = await getAuditLogsCursor({
      action,
      adminEmail,
      targetShopId,
      since,
      batchSize: 200,
    });
  } catch (err: unknown) {
    console.error("[Admin AuditLogs Export] Cursor error:", err);
    const message =
      err instanceof Error ? err.message : "Failed to open audit log cursor";
    return NextResponse.json({ error: message }, { status: 500 });
  }

  const reqHeaders = await headers();
  const ipAddress =
    reqHeaders.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    reqHeaders.get("x-real-ip") ||
    undefined;
  const userAgent = reqHeaders.get("user-agent") || undefined;

  // Record the export itself (fire-and-forget; helper swallows errors).
  logAdminAction({
    action: "data_export",
    adminEmail: session.email,
    details: {
      resource: "admin_audit_logs",
      filters: {
        action: action ?? null,
        days,
        adminEmail: adminEmail ?? null,
        targetShopId: targetShopId ?? null,
      },
    },
    ipAddress,
    userAgent,
  }).catch(() => {});

  const encoder = new TextEncoder();
  const headerRow = CSV_COLUMNS.join(",") + "\r\n";

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      controller.enqueue(encoder.encode(headerRow));
      try {
        for await (const doc of cursor) {
          controller.enqueue(encoder.encode(buildRow(doc)));
        }
        controller.close();
      } catch (err) {
        console.error("[Admin AuditLogs Export] Stream error:", err);
        controller.error(err);
      } finally {
        try {
          await cursor.close();
        } catch {
          // ignore
        }
      }
    },
    async cancel() {
      try {
        await cursor.close();
      } catch {
        // ignore
      }
    },
  });

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const filenameParts = ["audit-log", `${days}d`];
  if (action) filenameParts.push(action);
  filenameParts.push(stamp);
  const filename = `${filenameParts.join("_")}.csv`;

  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
