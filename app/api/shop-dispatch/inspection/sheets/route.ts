import {NextRequest} from "next/server";
import {ZodError} from "zod";
import {getSession} from "@/lib/auth";
import {requestBody, dispatchFailure, dispatchJson} from "@/lib/shop-dispatch/http";
import {readCatalog, updateCatalog} from "@/lib/auto-dvi/staff/sheet-catalog";
import {sheetCatalogDependencies} from "@/lib/auto-dvi/staff/sheet-catalog-runtime";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET() {
  if (!await getSession()) return dispatchJson({error: "Sign in to manage DVI sheets"}, 401);
  try {return dispatchJson(await readCatalog(sheetCatalogDependencies));}
  catch (error) {return dispatchFailure(error);}
}
export async function POST(req: NextRequest) {
  if (!await getSession()) return dispatchJson({error: "Sign in to manage DVI sheets"}, 401);
  try {return dispatchJson(await updateCatalog(await requestBody(req), sheetCatalogDependencies));}
  catch (error) {
    return error instanceof ZodError ? dispatchJson({error: "Invalid sheet. Check unique item/field IDs, field choices, required fields and sheet limits."}, 400) : dispatchFailure(error);
  }
}
