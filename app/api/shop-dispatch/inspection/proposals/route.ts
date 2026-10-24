import { NextRequest } from "next/server";
import { z } from "zod";
import { requestBody, dispatchFailure, dispatchJson } from "@/lib/shop-dispatch/http";
import { visitAssistanceContext } from "@/lib/auto-dvi/staff/assistance-context";
import { writeContext } from "@/lib/auto-dvi/staff/service";
import { staffDependencies } from "@/lib/auto-dvi/staff/runtime";
import type { StaffInspection } from "@/lib/auto-dvi/staff/model";
import { requireThat } from "@/lib/shop-dispatch/model";
import { buildRecommendedWorkPackages } from "@/lib/auto-dvi/recommended-work";
import { withUpstreamTimeout } from "@/lib/with-upstream-timeout";
const schema = z.object({visitId: z.string().min(1).max(100), revision: z.number().int().nonnegative(),
  id: z.string().min(1).max(170)}).strict();
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function POST(req: NextRequest) {
  try {
    const body = schema.parse(await requestBody(req));
    const scope = await visitAssistanceContext(body.visitId, body.revision);
    const context = await writeContext(body.visitId, staffDependencies);
    requireThat(context.access.canReview, "Advisor proposal permission required", 403);
    const inspection = context.record.results.staff as StaffInspection;
    const target = inspection.sheets.filter(s => s.active).flatMap(s =>
      s.sheet.items.map(i => ({id: `${s.key}/${i.id}`, finding: s.results[i.id]}))).find(i => i.id === body.id);
    requireThat(target?.finding?.recommendation, "Choose a saved visit recommendation", 409);
    const pricing = await withUpstreamTimeout(buildRecommendedWorkPackages({
      shopId: scope.shopId, items: [{name: target.finding.recommendation}],
    }), 10000, "visit-proposed-work", null);
    requireThat(pricing?.packages.length, "Pricing suggestion unavailable. Enter proposed amounts manually.", 503);
    await scope.revalidate();
    requireThat((await staffDependencies.access()).canReview, "Advisor proposal permission changed", 403);
    const p = pricing.packages[0];
    return dispatchJson({visitId: scope.visitId, revision: scope.revision, id: body.id,
      title: p.title, hours: p.hours, rate: p.rate, basis: p.hoursSource, rateSource: pricing.rateSource,
      notice: "Proposed labor only. History/default suggestions require confirmation. No parts, taxes, fees, approval or performed work."});
  } catch (cause) {return dispatchFailure(cause);}
}
