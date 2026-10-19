import { NextRequest } from "next/server";
import { ZodError } from "zod";
import { requestBody, dispatchJson, dispatchFailure } from "@/lib/shop-dispatch/http";
import { idSchema } from "@/lib/shop-dispatch/model";
import { releaseCommand, releaseSnapshot } from "@/lib/auto-dvi/release/service";
import { releaseDependencies } from "@/lib/auto-dvi/release/runtime";
import { getSession } from "@/lib/auth";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(req: NextRequest) {
  try {
    if (!await getSession()) return dispatchJson({error: "Unauthorized"}, 401);
    return dispatchJson(await releaseSnapshot(idSchema.parse(req.nextUrl.searchParams.get("visitId")), releaseDependencies));}
  catch (e) {return e instanceof ZodError ? dispatchJson({error: "Invalid release configuration or request"}, 400) : dispatchFailure(e);}
}
export async function POST(req: NextRequest) {
  try {
    if (!await getSession()) return dispatchJson({error: "Unauthorized"}, 401);
    return dispatchJson(await releaseCommand(await requestBody(req), releaseDependencies));}
  catch (e) {return e instanceof ZodError ? dispatchJson({error: "Invalid release configuration or request"}, 400) : dispatchFailure(e);}
}
