import { withExtensionErrorMarker } from "@/lib/extension-route-wrapper";
import { NextRequest, NextResponse } from "next/server";
import { guardExtensionShopRequest } from "@/lib/extension-route-guard";
import { resolveProtractorConfig, protractorFetch } from "@/lib/integrations/protractor/client";
import { markInjectedForUser } from "@/lib/data/repositories/concern-conversations";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders });
}

const ZERO_GUID = "00000000-0000-0000-0000-000000000000";

async function _POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { shopId, workOrderId, contactId, serviceItemId, concernText, provider } = body;

    if (!shopId) {
      return NextResponse.json({ error: "shopId is required" }, { status: 400, headers: corsHeaders });
    }
    if (!concernText) {
      return NextResponse.json({ error: "concernText is required" }, { status: 400, headers: corsHeaders });
    }

    // Single shop-resolution boundary (Task #300). The feature gate, owner
    // check, and mosShopId resolution all happen here so downstream Mongo
    // updates can key on the canonical mosShopId.
    const guard = await guardExtensionShopRequest(request, {
      smsShopId: shopId,
      provider: provider || "protractor",
      requiredFeatures: ["concern_assistant"],
      featureLabel: "Concern Assistant",
      corsHeaders,
    });
    if (!guard.ok) return guard.response;
    const auth = { user: guard.user };
    const mosShopId = guard.mosShopId;

    const config = await resolveProtractorConfig(shopId);
    if (!config.configured) {
      return NextResponse.json({ error: "Protractor not configured for this shop" }, { status: 400, headers: corsHeaders });
    }

    let woId = workOrderId;
    let woContactId = contactId;
    let woServiceItemId = serviceItemId;

    if (woId && (!woContactId || !woServiceItemId)) {
      const woResult = await protractorFetch<any>(
        `/WorkOrder/${woId}`,
        config,
        {},
        0,
        Number(shopId)
      );

      if (woResult.ok && woResult.data) {
        if (!woContactId && woResult.data.ContactID) {
          woContactId = woResult.data.ContactID;
        }
        if (!woContactId && woResult.data.Contact?.ID) {
          woContactId = woResult.data.Contact.ID;
        }
        if (!woServiceItemId && woResult.data.ServiceItemID) {
          woServiceItemId = woResult.data.ServiceItemID;
        }
        if (!woServiceItemId && woResult.data.ServiceItem?.ID) {
          woServiceItemId = woResult.data.ServiceItem.ID;
        }
      }
    }

    if (!woId || !woContactId || !woServiceItemId) {
      return NextResponse.json(
        { error: "Could not resolve work order details. workOrderId, contactId, and serviceItemId are required." },
        { status: 400, headers: corsHeaders }
      );
    }

    const payload = {
      Type: "WorkOrder",
      ID: woId,
      InvoiceNumber: 0,
      Completed: false,
      Contact: { ID: woContactId },
      ServiceItem: { ID: woServiceItemId },
      ServicePackages: {
        ItemCollection: [
          {
            ID: ZERO_GUID,
            Chapter: "Concern",
            Rank: 1,
            ServicePackageHeader: {
              Title: "Customer Concern Assistant",
              Description: concernText,
            },
            ServicePackageLines: { ItemCollection: [] },
          },
        ],
      },
    };

    console.log(`[Protractor Concern] Adding concern to WO ${woId} for shop ${shopId}`);

    const result = await protractorFetch<any>(
      `/WorkOrder/${woId}`,
      config,
      {
        method: "POST",
        body: JSON.stringify(payload),
      },
      0,
      Number(shopId)
    );

    if (!result.ok) {
      console.error(`[Protractor Concern] Failed:`, result.error);
      return NextResponse.json(
        { error: result.error || "Failed to add concern to work order" },
        { status: 500, headers: corsHeaders }
      );
    }

    console.log(`[Protractor Concern] Successfully added concern to WO ${woId}`);

    const userId = auth.user._id?.toString() || auth.user.id?.toString();
    // Task #300: scope injection-tracking to this shop too. Filter by either
    // the canonical mosShopId (new docs) or the legacy raw shopId / null
    // (pre-migration docs that were never tagged).
    await markInjectedForUser({
      userId: userId as string,
      mosShopId,
      rawShopId: shopId,
      set: {
        injectedAt: new Date(),
        injectedTo: "protractor",
        injectedWorkOrderId: woId,
      },
    });

    return NextResponse.json({ ok: true }, { headers: corsHeaders });
  } catch (error: any) {
    console.error("[Protractor Concern] Error:", error);
    return NextResponse.json(
      { error: error.message || "Failed to inject concern" },
      { status: 500, headers: corsHeaders }
    );
  }
}

// Task #510: per-shop error-rate alerting — wrap all extension handlers
export const POST = withExtensionErrorMarker(_POST as any);
