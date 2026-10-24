import { NextRequest } from "next/server";
import { staffAccess } from "@/lib/auto-dvi/staff/access";
import { listInspectionVisits } from "@/lib/auto-dvi/staff/visit-selection";
import { readDispatchBoard } from "@/lib/data/repositories/shop-dispatch";
import { findCachedWorkOrdersByIds } from "@/lib/data/repositories/protractor-work-orders";
import { dispatchFailure, dispatchJson } from "@/lib/shop-dispatch/http";
import { ZodError } from "zod";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(req: NextRequest) {
  try {
    return dispatchJson(await listInspectionVisits(req.nextUrl.searchParams.get("vin"), {
      access: staffAccess, read: readDispatchBoard,
      references: async (shop, ids) => {
        const result: {sourceId: string; vin: string}[] = [];
        for (let index = 0; index < ids.length; index += 50) {
          const rows = await findCachedWorkOrdersByIds(shop, ids.slice(index, index + 50), {maxTimeMS: 2000});
          for (const row of rows) {
            if (typeof row.workOrderId === "string" && typeof row.vin === "string")
              result.push({sourceId: row.workOrderId, vin: row.vin});
          }
        }
        return result;
      },
    }));
  } catch (cause) {
    return cause instanceof ZodError ? dispatchJson({error: "Valid VIN required"}, 400) : dispatchFailure(cause);
  }
}
