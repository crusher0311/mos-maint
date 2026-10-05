import { NextRequest, NextResponse } from "next/server";
import { previewJwtInvoices } from "@/lib/jwt-invoice-preview";
import { deps } from "./deps";

export const dynamic = "force-dynamic";
export const maxDuration = 60;
let busy = false;
const respond = (body: unknown, status: number) =>
  NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });

export async function POST(req: NextRequest) {
  let admin;
  try { admin = await deps.requirePlatformAdmin(); } catch {
    return respond({ ok: false, error: "Platform administrator sign-in required." }, 401);
  }
  // No caller-supplied shop, date, endpoint, page or transport options.
  try {
    const origin = req.headers.get("origin");
    if (!origin || new URL(origin).host !== req.headers.get("host") ||
        !req.headers.get("content-type")?.startsWith("application/json")) {
      return respond({ ok: false, error: "Same-origin JSON request required." }, 403);
    }
    const body = await req.json();
    if (!body || Array.isArray(body) || typeof body !== "object" || Object.keys(body).length) {
      return respond({ ok: false, error: "This preview accepts no scope overrides." }, 400);
    }
  } catch {
    return respond({ ok: false, error: "Invalid request." }, 400);
  }
  if (busy) return respond({ ok: false, error: "A preview is already running on this server." }, 429);
  busy = true;
  try {
    const result = await previewJwtInvoices({ ...deps, authorize: async () => admin });
    return respond(result.body, result.status);
  } catch {
    return respond({ ok: false, error: "Preview unavailable. No repair was attempted." }, 503);
  } finally { busy = false; }
}
