import { NextRequest, NextResponse } from "next/server";
import { createExternalEndpoint } from "@/lib/external-api/middleware";
import { IPP_PROTOCOL } from "@/lib/print-queue/ipp-contract";
import { readPrintJsonBody } from "@/lib/print-queue/request-body";
import { ackIpp, agentIdentity, IppRequestError, pollIpp, publishInventory } from "@/lib/print-queue/ipp-repository";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const POST = createExternalEndpoint("print:agent", async (req: NextRequest, { shopId, apiKey }) => {
  try {
    const body = await readPrintJsonBody(req, 64 * 1024);
    if (body?.protocol !== IPP_PROTOCOL) throw new IppRequestError("Unsupported agent capability");
    const agentId = agentIdentity(shopId, apiKey.keyHash, body.installationId);
    if (body.action === "ack") return NextResponse.json(await ackIpp(shopId, agentId, body));
    if (body.action !== "poll") throw new IppRequestError("Unknown agent action");
    await publishInventory(shopId, agentId, body.printers);
    const job = await pollIpp(shopId, agentId);
    return NextResponse.json({ agentId, shopId, jobs: job ? [job] : [] });
  } catch (error) {
    if (error instanceof IppRequestError) return NextResponse.json({ error: error.message }, { status: error.status });
    if (error instanceof SyntaxError) return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
    throw error;
  }
});
