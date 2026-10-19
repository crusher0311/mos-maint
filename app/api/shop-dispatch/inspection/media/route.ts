import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { dispatchFailure, dispatchJson } from "@/lib/shop-dispatch/http";
import { requireThat } from "@/lib/shop-dispatch/model";
import { staffDependencies } from "@/lib/auto-dvi/staff/runtime";
import { attachStaffPhoto, readStaffPhoto } from "@/lib/auto-dvi/staff/media";
import { StaffMediaStorage } from "@/lib/data/repositories/workflow-inspections";
import { ZodError } from "zod";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const media = new StaffMediaStorage();
export async function POST(req: NextRequest) {
  if (!await getSession()) return dispatchJson({error: "Sign in to use shop workflow"}, 401);
  try {
    const origin = req.headers.get("origin"), host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
    requireThat(origin && new URL(origin).host === host && req.headers.get("sec-fetch-site") !== "cross-site", "Same-origin upload required", 403);
    await staffDependencies.access();
    // Bound the streaming request before multipart parsing, not just Content-Length.
    const reader = req.body?.getReader(); requireThat(reader, "Upload body required", 400);
    const parts: Uint8Array[] = []; let total = 0;
    for (;;) {
      const chunk = await reader.read(); if (chunk.done) break;
      total += chunk.value.length;
      if (total > 4 * 1024 * 1024 + 16000) {await reader.cancel(); requireThat(false, "Photo exceeds 4 MiB", 413);}
      parts.push(chunk.value);
    }
    const form = await new Response(Buffer.concat(parts), {headers: {"content-type": req.headers.get("content-type") ?? ""}}).formData();
    const file = form.get("file"); requireThat(file instanceof File && file.size > 0, "Choose a photo", 400);
    const raw = Object.fromEntries(["visitId", "sheet", "item", "requestId", "provenance"].map(k => [k, form.get(k)]));
    requireThat(form.has("revision") && String(form.get("revision")).trim() !== "", "Revision required", 400);
    return dispatchJson(await attachStaffPhoto({...raw, revision: Number(form.get("revision")), mime: file.type},
      Buffer.from(await file.arrayBuffer()), staffDependencies, media));
  } catch (e) {return e instanceof ZodError ? dispatchJson({error: "Invalid photo request"}, 400) : dispatchFailure(e);}
}
export async function GET(req: NextRequest) {
  if (!await getSession()) return dispatchJson({error: "Sign in to use shop workflow"}, 401);
  try {
    const p = req.nextUrl.searchParams;
    const file = await readStaffPhoto(p.get("visitId") ?? "", p.get("sheet") ?? "", p.get("item") ?? "", p.get("mediaId") ?? "", staffDependencies, media);
    return new NextResponse(new Uint8Array(file.bytes), {headers: {"Content-Type": file.mime,
      "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "default-src 'none'; sandbox"}});
  } catch (e) {return dispatchFailure(e);}
}
