import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { addDeferredWorkToWorkOrder } from "@/lib/integrations/protractor";
import { trackPushToRO } from "@/lib/extension-analytics";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const shopId = Number(session.shopId);
  const body = await req.json();
  const { workOrderGuid, deferredId, vin, serviceTitle } = body as { 
    workOrderGuid: string; 
    deferredId: string;
    vin: string;
    serviceTitle?: string;
  };

  if (!workOrderGuid) {
    return NextResponse.json({ error: "Work order GUID is required" }, { status: 400 });
  }

  if (!deferredId) {
    return NextResponse.json({ error: "Deferred work ID is required" }, { status: 400 });
  }

  if (!vin) {
    return NextResponse.json({ error: "VIN is required" }, { status: 400 });
  }

  console.log(`[Add Deferred] Shop ${shopId}: Adding deferred ${deferredId} to WO ${workOrderGuid}`);

  const result = await addDeferredWorkToWorkOrder(shopId, workOrderGuid, deferredId, vin);

  if (!result.ok) {
    console.log(`[Add Deferred] Failed: ${result.error}`);
    return NextResponse.json({ error: result.error }, { status: 500 });
  }

  await trackPushToRO({
    shopId,
    vin,
    jobSource: "plan",
    jobTitle: serviceTitle || result.servicePackage?.Title || "Deferred Work",
  }).catch(() => {});

  console.log(`[Add Deferred] Success: Added "${result.servicePackage?.Title}" to work order`);

  return NextResponse.json({ 
    ok: true, 
    servicePackage: result.servicePackage 
  });
}
