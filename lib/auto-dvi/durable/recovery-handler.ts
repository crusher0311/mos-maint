import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { assertRecoveryOperator } from "./access";
import { durableFailure, durableRecoveryService } from "./runtime";
import { DurableError, type Scope } from "./model";
import { runWithProtractorInteractiveTransport } from "@/lib/integrations/protractor/interactive-context";

const request = z.discriminatedUnion("action", [
  z.object({action: z.literal("authorize"), operationId: z.string().uuid(), stage: z.enum(["packages", "findings"])}).strict(),
  z.object({action: z.literal("consume"), operationId: z.string().uuid(), stage: z.enum(["packages", "findings"]),
    grantId: z.string().uuid()}).strict(),
]);
export async function durableRecovery(req: NextRequest, scope: Scope, headers?: HeadersInit) {
  const privateHeaders = new Headers(headers);
  privateHeaders.set("Cache-Control", "private, no-store");
  try {
    await assertRecoveryOperator(scope);
    const parsed = request.safeParse(await req.json().catch(() => null));
    if (!parsed.success) throw new DurableError("INVALID_REQUEST", 400);
    const body = parsed.data, service = await durableRecoveryService(scope.shopId);
    const reply = await runWithProtractorInteractiveTransport(scope.shopId, () =>
      body.action === "authorize" ? service.issue(scope, body.operationId, body.stage) :
        service.consume(scope, body.operationId, body.stage, body.grantId));
    return NextResponse.json(reply.body, {status: reply.status, headers: privateHeaders});
  } catch (error) {
    const reply = durableFailure(error);
    return NextResponse.json(reply.body, {status: reply.status, headers: privateHeaders});
  }
}
