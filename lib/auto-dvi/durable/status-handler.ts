import { NextRequest, NextResponse } from "next/server";
import { durableFailure, durableService } from "./runtime";
import { DurableError, type Scope } from "./model";
import { runWithProtractorInteractiveTransport } from "@/lib/integrations/protractor/interactive-context";

/** Authorization is performed by the channel before this shared handler. */
export async function durableStatus(req: NextRequest, scope: Scope, reconcile: boolean, headers?: HeadersInit) {
  try {
    const id = new URL(req.url).searchParams.get("operationId");
    if (!id || !/^[0-9a-f-]{36}$/.test(id)) throw new DurableError("INVALID_OPERATION", 400);
    const service = await durableService(scope.shopId);
    if (!service) throw new DurableError("DURABLE_NOT_ENROLLED", 404);
    const result = await runWithProtractorInteractiveTransport(scope.shopId,
      () => reconcile ? service.reconcile(scope, id) : service.status(scope, id));
    return NextResponse.json(result.body, {status: result.status, headers});
  } catch (error) {
    const result = durableFailure(error);
    return NextResponse.json(result.body, {status: result.status, headers});
  }
}
