// Admin editor for per-shop DVI best-practice blurbs (≤140 chars each).
// Renders beneath the tech note on matching DVI Finding tiles.

import { redirect } from "next/navigation";
import Link from "next/link";
import { requireSession } from "@/lib/auth";
import {
  listShopDviBestPractices,
  DEFAULT_DVI_BEST_PRACTICES,
  DVI_BEST_PRACTICE_MAX_CHARS,
} from "@/lib/dvi-best-practices";
import { getDb } from "@/lib/mongo";
import DviBestPracticesEditor from "./editor";

export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ shopId: string }>;
}

export default async function ShopDviBestPracticesPage({ params }: PageProps) {
  const { shopId: shopIdStr } = await params;
  const shopId = Number(shopIdStr);
  if (!Number.isFinite(shopId)) redirect("/admin/shops");

  const session = await requireSession();
  if (session.role !== "admin" && session.role !== "platform_admin") {
    redirect("/dashboard");
  }
  if (!session.isPlatformAdmin && Number(session.shopId) !== shopId) {
    redirect(`/admin/shops/${session.shopId}/dvi-best-practices`);
  }

  const [rows, shopDoc] = await Promise.all([
    listShopDviBestPractices(shopId),
    (await getDb()).collection("shops").findOne({ shopId }, { projection: { name: 1 } }),
  ]);

  const authoredKeys = new Set(rows.map((r) => r.serviceKey));
  const suggestedTemplates = DEFAULT_DVI_BEST_PRACTICES
    .filter((d) => !authoredKeys.has(d.serviceKey))
    .map((d) => ({ serviceKey: d.serviceKey, serviceName: d.serviceName, blurb: d.blurb }));

  return (
    <div className="space-y-6">
      <div>
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-gray-900">DVI Best-Practice Blurbs</h1>
            <p className="mt-1 text-sm text-gray-500">
              {shopDoc?.name ? `${shopDoc.name} · Shop #${shopId}` : `Shop #${shopId}`}
              {" · "}up to {DVI_BEST_PRACTICE_MAX_CHARS} characters per blurb
            </p>
          </div>
          <Link
            href="/admin/shops"
            className="text-sm text-mos-blue hover:text-mos-blue-dark"
          >
            ← Back to Shops
          </Link>
        </div>
        <p className="mt-3 text-sm text-gray-600 max-w-3xl">
          These short notes appear on the customer plan beneath the
          technician note for any matching DVI finding (red or yellow).
          Use them to add the &ldquo;why this matters&rdquo; context that a
          quick inspection write-up usually misses. Tiles only show a
          blurb if you&rsquo;ve authored one for that service.
        </p>
      </div>

      <DviBestPracticesEditor
        shopId={shopId}
        initialRows={rows.map((r) => ({
          serviceKey: r.serviceKey,
          serviceName: r.serviceName,
          blurb: r.blurb,
          updatedAt: r.updatedAt ? r.updatedAt.toISOString() : null,
          updatedBy: r.updatedBy ?? null,
        }))}
        suggestedTemplates={suggestedTemplates}
      />
    </div>
  );
}
