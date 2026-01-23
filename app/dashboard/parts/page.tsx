// app/dashboard/parts/page.tsx
// Part Cross-Reference Page

import { requireSession } from "@/lib/auth";
import { getDb } from "@/lib/mongo";
import PartCrossRefClient from "./PartCrossRefClient";

export const dynamic = "force-dynamic";

const SMS_DISPLAY_NAMES: Record<string, string> = {
  tekmetric: "Tekmetric",
  protractor: "Protractor",
  autoflow: "AutoFlow",
  shopware: "Shop-Ware",
  shopmonkey: "Shop Monkey",
  "stand-alone": "your shop",
};

export default async function PartCrossRefPage() {
  const session = await requireSession();
  
  const db = await getDb();
  const shop = await db.collection("shops").findOne({ shopId: session.shopId });
  const smsIntegration = shop?.smsIntegration || "stand-alone";
  const smsDisplayName = SMS_DISPLAY_NAMES[smsIntegration] || smsIntegration;

  return (
    <div className="p-6">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900">Part Cross-Reference</h1>
        <p className="mt-1 text-sm text-gray-500">
          Find interchangeable parts across manufacturers based on vehicle compatibility and shop history.
        </p>
      </div>

      <PartCrossRefClient smsDisplayName={smsDisplayName} />
    </div>
  );
}
