import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import {
  getAutoflowWorkflowDetails,
  InvalidAutoflowWorkflowMappingError,
  listAutoflowWorkflowShops,
  resetAutoflowWorkflow,
  saveAutoflowWorkflow,
} from "@/lib/data/repositories/autoflow-workflows";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function requireAdmin() {
  const session = await getSession();
  if (!session) {
    return { response: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  }
  if (!session.isPlatformAdmin) {
    return {
      response: NextResponse.json(
        { error: "Platform admin access required" },
        { status: 403 },
      ),
    };
  }
  return { session };
}

function parseShopId(value: unknown): string | number | null {
  if (
    (typeof value !== "string" && typeof value !== "number") ||
    String(value).trim() === ""
  ) {
    return null;
  }
  const text = String(value).trim();
  const id = Number(text);
  return /^\d+$/.test(text) && Number.isSafeInteger(id) && id > 0 ? id : null;
}

export async function GET(request: NextRequest) {
  const auth = await requireAdmin();
  if ("response" in auth) return auth.response;

  try {
    const rawShopId = request.nextUrl.searchParams.get("shopId");
    if (rawShopId == null || rawShopId.trim() === "") {
      return NextResponse.json({
        ok: true,
        shops: await listAutoflowWorkflowShops(),
      });
    }

    const shopId = parseShopId(rawShopId);
    if (shopId == null) {
      return NextResponse.json({ ok: false, error: "shopId is required" }, { status: 400 });
    }
    const details = await getAutoflowWorkflowDetails(shopId);
    if (!details) {
      return NextResponse.json({ ok: false, error: "AutoFlow shop not found" }, { status: 404 });
    }
    return NextResponse.json({ ok: true, ...details });
  } catch (error) {
    if (error instanceof InvalidAutoflowWorkflowMappingError) {
      return NextResponse.json(
        { ok: false, error: error.message },
        { status: 409 },
      );
    }
    console.error("[AutoFlow Workflow] GET error:", error);
    return NextResponse.json(
      { ok: false, error: "Failed to load AutoFlow workflow settings" },
      { status: 500 },
    );
  }
}

export async function PUT(request: NextRequest) {
  const auth = await requireAdmin();
  if ("response" in auth) return auth.response;

  let body: any;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON body" }, { status: 400 });
  }
  const shopId = parseShopId(body?.shopId);
  if (shopId == null) {
    return NextResponse.json({ ok: false, error: "shopId is required" }, { status: 400 });
  }
  if (body?.mapping == null) {
    return NextResponse.json({ ok: false, error: "mapping is required" }, { status: 400 });
  }

  try {
    const mapping = await saveAutoflowWorkflow(shopId, body.mapping);
    return NextResponse.json({ ok: true, shopId, mapping });
  } catch (error: any) {
    if (error instanceof InvalidAutoflowWorkflowMappingError) {
      return NextResponse.json(
        { ok: false, error: error.message },
        { status: 409 },
      );
    }
    const message = error?.message || "Failed to save AutoFlow workflow mapping";
    const status =
      message === "AutoFlow shop not found"
        ? 404
        : message.startsWith("mapping") || message.startsWith("status ")
          ? 400
          : 500;
    if (status === 500) {
      console.error("[AutoFlow Workflow] PUT error:", error);
      return NextResponse.json(
        { ok: false, error: "Failed to save AutoFlow workflow mapping" },
        { status },
      );
    }
    return NextResponse.json({ ok: false, error: message }, { status });
  }
}

export async function DELETE(request: NextRequest) {
  const auth = await requireAdmin();
  if ("response" in auth) return auth.response;

  let body: any;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON body" }, { status: 400 });
  }
  const shopId = parseShopId(body?.shopId);
  if (shopId == null) {
    return NextResponse.json({ ok: false, error: "shopId is required" }, { status: 400 });
  }

  try {
    await resetAutoflowWorkflow(shopId);
    return NextResponse.json({ ok: true, shopId, mapping: null });
  } catch (error: any) {
    const message = error?.message || "Failed to reset AutoFlow workflow mapping";
    if (message !== "AutoFlow shop not found") {
      console.error("[AutoFlow Workflow] DELETE error:", error);
    }
    return NextResponse.json(
      {
        ok: false,
        error:
          message === "AutoFlow shop not found"
            ? message
            : "Failed to reset AutoFlow workflow mapping",
      },
      { status: message === "AutoFlow shop not found" ? 404 : 500 },
    );
  }
}
