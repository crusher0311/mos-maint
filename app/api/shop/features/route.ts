// app/api/shop/features/route.ts
// Get enabled features for the current shop

import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { getFeatureEntitlements, FEATURE_KEYS, FEATURE_METADATA } from "@/lib/featureResolver";
import { FEATURES } from "@/lib/features";
import { getDb } from "@/lib/mongo";

export const dynamic = "force-dynamic";

export async function GET() {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const shopId = Number(session.shopId);
  const entitlements = await getFeatureEntitlements(shopId);
  const db = await getDb();
  const shopDoc = await db.collection("shops").findOne(
    { shopId },
    { projection: { trial: 1, trialEndsAt: 1, trialDays: 1, trialStartedAt: 1, cardOnFile: 1, "billing.cardOnFile": 1 } }
  );

  const trialEndsAt = shopDoc?.trial?.endsAt
    ? new Date(shopDoc.trial.endsAt)
    : (shopDoc?.trialEndsAt ? new Date(shopDoc.trialEndsAt) : null);
  const trialStartedAt = shopDoc?.trial?.startedAt
    ? new Date(shopDoc.trial.startedAt)
    : (shopDoc?.trialStartedAt ? new Date(shopDoc.trialStartedAt) : null);
  const trialDays = (shopDoc?.trial?.days ?? shopDoc?.trialDays) ?? null;
  const cardOnFile = !!(shopDoc?.cardOnFile || shopDoc?.billing?.cardOnFile);
  const trialDaysLeft = trialEndsAt
    ? Math.max(0, Math.ceil((trialEndsAt.getTime() - Date.now()) / (24 * 60 * 60 * 1000)))
    : null;
  const trialActive = !!trialEndsAt && (entitlements.billing.status === "trial" || entitlements.billing.status === "trialing");

  const enabledFeatureIds: string[] = [];
  for (const key of FEATURE_KEYS) {
    if (entitlements.effectiveFeatures[key]) {
      enabledFeatureIds.push(key);
    }
  }

  const featuresById = new Map(FEATURES.map(f => [f.id as string, f]));
  const enabledFeatures = enabledFeatureIds.map(id => {
    const f = featuresById.get(id);
    if (f) {
      return { id: f.id, name: f.name, description: f.description, icon: f.icon };
    }
    const meta = FEATURE_METADATA[id as keyof typeof FEATURE_METADATA];
    return { id, name: meta.name, description: meta.description, icon: "Sparkles" };
  });

  return NextResponse.json({
    ok: true,
    enabledFeatures,
    enabledFeatureIds,
    billing: {
      status: entitlements.billing.status,
      plan: entitlements.billing.plan,
      gracePeriodEndsAt: entitlements.billing.gracePeriodEndsAt || null,
      cardOnFile,
    },
    trial: {
      active: trialActive,
      startedAt: trialStartedAt ? trialStartedAt.toISOString() : null,
      endsAt: trialEndsAt ? trialEndsAt.toISOString() : null,
      days: trialDays,
      daysLeft: trialDaysLeft,
      cardOnFile,
    },
  });
}
