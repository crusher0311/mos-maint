import { requestBody, dispatchFailure, dispatchJson } from "@/lib/shop-dispatch/http";
import { executePilot, pilotStatus } from "@/lib/auto-dvi/pilot/service";
import { pilotDependencies } from "@/lib/auto-dvi/pilot/runtime";
import { runWithProtractorInteractiveTransport } from "@/lib/integrations/protractor/interactive-context";
import { PILOT_SHOP } from "@/lib/auto-dvi/pilot/model";
import { idSchema } from "@/lib/shop-dispatch/model";
import { ZodError } from "zod";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const failure = (e: unknown) => e instanceof ZodError ? dispatchJson({error: "Invalid pilot request"}, 400) : dispatchFailure(e);
export async function GET(req: Request) {
  try { return dispatchJson(await pilotStatus(idSchema.parse(new URL(req.url).searchParams.get("visitId")), pilotDependencies)); }
  catch (e) { return failure(e); }
}
export async function POST(req: Request) {
  try {
    const body = await requestBody(req);
    return dispatchJson(await runWithProtractorInteractiveTransport(PILOT_SHOP, () => executePilot(body, pilotDependencies)));
  } catch (e) { return failure(e); }
}
