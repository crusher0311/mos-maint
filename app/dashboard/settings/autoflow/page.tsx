// app/dashboard/settings/autoflow/page.tsx
import { requireSession } from "@/lib/auth";
import sql from "@/lib/db/postgres";
import AutoflowForm from "./AutoflowForm";
import crypto from "crypto";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function getCurrent(shopId: number) {
  const shops = await sql`
    SELECT autoflow_domain, autoflow_api_key, autoflow_api_password, webhook_token 
    FROM shops WHERE shop_id = ${String(shopId)}
  `;
  const shop = shops[0] as any;

  let webhookToken = shop?.webhook_token;
  if (!webhookToken) {
    webhookToken = crypto.randomBytes(12).toString("hex");
    await sql`
      UPDATE shops SET webhook_token = ${webhookToken}, updated_at = NOW()
      WHERE shop_id = ${String(shopId)}
    `;
  }

  return {
    autoflowDomain: shop?.autoflow_domain || "",
    autoflowApiKey: shop?.autoflow_api_key || "",
    autoflowApiPassword: shop?.autoflow_api_password || "",
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
