import { NextRequest, NextResponse } from "next/server";
import { durableFailure, durableService, discoverDurableTarget } from "./runtime";
import { DurableError, type Scope } from "./model";
import { runWithProtractorInteractiveTransport } from "@/lib/integrations/protractor/interactive-context";
import { assertDurableStaff } from "./access";

/** Authorization is performed by the channel before this shared handler. */
export async function durableStatus(req: NextRequest, scope: Scope, reconcile: boolean, headers?: HeadersInit) {
  const privateHeaders = new Headers(headers);
  privateHeaders.set("Cache-Control", "private, no-store");
  try {
    await assertDurableStaff(scope);
    const params = new URL(req.url).searchParams;
    const id = params.get("operationId");
    // Browser preflight includes VIN and needs the durable/scope envelope.
    // Operator lookup uses only an exact GUID and returns redacted status.
    if (!id && !reconcile && (params.has("vin") || !params.has("workOrderGuid"))) {
      const result = await runWithProtractorInteractiveTransport(scope.shopId, () => discoverDurableTarget(scope, params));
      await assertDurableStaff(scope);
      return NextResponse.json(result.body, {status: result.status, headers: privateHeaders});
    }
    const guid = params.get("workOrderGuid");
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
    if (id ? !uuid.test(id) : reconcile || !guid || !uuid.test(guid)) throw new DurableError("INVALID_OPERATION", 400);
    const service = await durableService(scope.shopId);
    if (!service) throw new DurableError("DURABLE_NOT_ENROLLED", 404);
    const result = await runWithProtractorInteractiveTransport(scope.shopId,
      () => id ? reconcile ? service.reconcile(scope, id) : service.status(scope, id) : service.discoverOperation(scope, guid!));
    await assertDurableStaff(scope);
    return NextResponse.json(result.body, {status: result.status, headers: privateHeaders});
  } catch (error) {
    const result = durableFailure(error);
    return NextResponse.json(result.body, {status: result.status, headers: privateHeaders});
  }
}
