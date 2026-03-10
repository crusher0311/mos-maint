import { NextRequest, NextResponse } from "next/server";
import { validateExtensionToken, getAuthErrorStatus } from "@/lib/extension-auth";
import { resolveProtractorConfig, protractorFetch } from "@/lib/integrations/protractor/client";
import { getDb } from "@/lib/mongo";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders });
}

const ZERO_GUID = "00000000-0000-0000-0000-000000000000";

export async function POST(request: NextRequest) {
  try {
    const auth = await validateExtensionToken(request);
    if (!auth.authorized || !auth.user) {
      return NextResponse.json({ error: auth.error || "Unauthorized" }, { status: getAuthErrorStatus(auth), headers: corsHeaders });
    }

    const body = await request.json();
    const { shopId, workOrderId, contactId, serviceItemId, concernText } = body;

    if (!shopId) {
      return NextResponse.json({ error: "shopId is required" }, { status: 400, headers: corsHeaders });
    }
    if (!concernText) {
      return NextResponse.json({ error: "concernText is required" }, { status: 400, headers: corsHeaders });
    }

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

    const db = await getDb();
    const userId = auth.user._id?.toString() || auth.user.id?.toString();
    await db.collection("concern_conversations").updateMany(
      { userId, status: "completed", injectedAt: { $exists: false } },
      {
        $set: {
          injectedAt: new Date(),
          injectedTo: "protractor",
          injectedWorkOrderId: woId,
        },
      }
    );

    return NextResponse.json({ ok: true }, { headers: corsHeaders });
  } catch (error: any) {
    console.error("[Protractor Concern] Error:", error);
    return NextResponse.json(
      { error: error.message || "Failed to inject concern" },
      { status: 500, headers: corsHeaders }
    );
  }
}
