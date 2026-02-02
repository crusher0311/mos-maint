// app/dashboard/settings/autoflow/page.tsx
import { requireSession } from "@/lib/auth";
import { getDb } from "@/lib/mongo";
import AutoflowForm from "./AutoflowForm";
import crypto from "crypto";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function getCurrent(shopId: number) {
  const db = await getDb();
  const shop = await db.collection("shops").findOne(
    { shopId },
    {
      projection: {
        autoflowDomain: 1,
        autoflowApiKey: 1,
        autoflowApiPassword: 1,
        webhookToken: 1,
      },
    }
  );

  let webhookToken = shop?.webhookToken;
  if (!webhookToken) {
    webhookToken = crypto.randomBytes(12).toString("hex");
    await db.collection("shops").updateOne(
      { shopId },
      { $set: { webhookToken } }
    );
  }

  return {
    autoflowDomain: shop?.autoflowDomain || "",
    autoflowApiKey: shop?.autoflowApiKey || "",
    autoflowApiPassword: shop?.autoflowApiPassword || "",
    webhookToken,
  };
}

export default async function AutoflowSettingsPage() {
  const sess = await requireSession();
  const shopId = Number(sess.shopId);
  const current = await getCurrent(shopId);

  return (
    <main className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Autoflow Settings</h1>
      </div>

      <AutoflowForm shopId={shopId} initial={current} />
    </main>
  );
}
