import { NextRequest } from "next/server";
import { getSession } from "@/lib/auth";
import { requestBody, dispatchFailure, dispatchJson } from "@/lib/shop-dispatch/http";
import { idSchema } from "@/lib/shop-dispatch/model";
import { mutateStaff, snapshot } from "@/lib/auto-dvi/staff/service";
import { staffDependencies } from "@/lib/auto-dvi/staff/runtime";
import { ZodError } from "zod";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(req: NextRequest) {
  if (!await getSession()) return dispatchJson({error: "Sign in to use shop workflow"}, 401);
  try {return dispatchJson(await snapshot(idSchema.parse(req.nextUrl.searchParams.get("visitId")), staffDependencies));}
  catch (e) {return e instanceof ZodError ? dispatchJson({error: "Invalid inspection request or configuration"}, 400) : dispatchFailure(e);}
}
export async function POST(req: NextRequest) {
  if (!await getSession()) return dispatchJson({error: "Sign in to use shop workflow"}, 401);
  try {return dispatchJson(await mutateStaff(await requestBody(req), staffDependencies));}
  catch (e) {return e instanceof ZodError ? dispatchJson({error: "Invalid inspection request or configuration"}, 400) : dispatchFailure(e);}
}
