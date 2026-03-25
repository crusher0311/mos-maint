import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { getDb } from "@/lib/mongo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface HealthSignals {
  billing: number;
  integration: number;
  activity: number;
  adoption: number;
  support: number;
}

function computeHealthScore(signals: HealthSignals): number {
  const weights = {
    billing: 0.25,
    integration: 0.25,
    activity: 0.25,
    adoption: 0.15,
    support: 0.10,
  };

  const raw =
    signals.billing * weights.billing +
    signals.integration * weights.integration +
    signals.activity * weights.activity +
    signals.adoption * weights.adoption +
    signals.support * weights.support;

  return Math.round(Math.min(100, Math.max(0, raw)));
}

function getBillingScore(shop: any): number {
  const status = shop.billing?.status || shop.billing?.plan || "trial";
  const scores: Record<string, number> = {
    active: 100,
    enterprise: 100,
    demo: 80,
    trial: 60,
    past_due: 30,
    suspended: 10,
    canceled: 0,
    churned: 0,
  };
  return scores[status] ?? 50;
}

function getIntegrationScore(shop: any): number {
  let score = 0;
  const hasProtractor = !!(shop.protractor?.configured || shop.protractor?.apiKey || shop.protractorApiKey || shop.protractorConnectionId);
  const hasTekmetric = !!(shop.tekmetric?.shopId || shop.tekmetricShopId);
  const hasShopWare = !!(shop.shopware?.tenantId);
  const hasAutoFlow = !!(shop.autoflow?.apiKey || shop.autoflow?.configured || shop.autoflowApiKey);
  const hasCarfax = !!(shop.carfax?.locationId || shop.carfax?.serviceId || shop.carfaxLocationId);

  const smsConnected = hasProtractor || hasTekmetric || hasShopWare || hasAutoFlow;
  if (smsConnected) score += 70;
  if (hasCarfax) score += 30;
  if (!smsConnected && !hasCarfax) score = 0;

  return Math.min(100, score);
}

function getActivityScore(lastEventDate: Date | null): number {
  if (!lastEventDate) return 0;
  const daysSince = (Date.now() - new Date(lastEventDate).getTime()) / (1000 * 60 * 60 * 24);
  if (daysSince <= 1) return 100;
  if (daysSince <= 3) return 90;
  if (daysSince <= 7) return 75;
  if (daysSince <= 14) return 50;
  if (daysSince <= 30) return 25;
  return 0;
}

function getAdoptionScore(shop: any, vehicleCount: number, vinViewCount: number, stickerCount: number): number {
  const features = shop.enabledFeatures || {};
  const totalFeatures = ["maintenance", "job_lookup", "common_failures", "oil_sticker", "keytags", "auto_booking", "part_xref", "labor_rates", "concern_assistant"];
  const enabledCount = totalFeatures.filter(f => features[f]).length;
  const featureRatio = totalFeatures.length > 0 ? enabledCount / totalFeatures.length : 0;

  let usageScore = 0;
  if (vehicleCount > 0) usageScore += 30;
  if (vinViewCount > 0) usageScore += 35;
  if (stickerCount > 0) usageScore += 35;

  return Math.round(featureRatio * 40 + usageScore * 0.6);
}

function getSupportScore(openTicketCount: number): number {
  if (openTicketCount === 0) return 100;
  if (openTicketCount === 1) return 70;
  if (openTicketCount === 2) return 40;
  return 10;
}

function getRiskLevel(score: number): "healthy" | "monitor" | "at-risk" | "critical" {
  if (score >= 75) return "healthy";
  if (score >= 50) return "monitor";
  if (score >= 25) return "at-risk";
  return "critical";
}

export async function GET() {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!session.isPlatformAdmin) {
    return NextResponse.json({ error: "Forbidden - platform admin access required" }, { status: 403 });
  }

  try {
    const db = await getDb();

    const shops = await db.collection("shops").find().toArray();
    const shopIds = shops.map(s => s.shopId);
    const allShopIdVariants = shopIds.flatMap(id => [id, String(id), Number(id)]).filter(id => id !== null && !isNaN(id as number));

    const [
      vehicleCounts,
      vinViewCounts,
      stickerCounts,
      userCounts,
      openTickets,
      lastEvents,
      lastLogins,
    ] = await Promise.all([
      db.collection("vehicles").aggregate([
        { $match: { shopId: { $in: allShopIdVariants } } },
        { $group: { _id: "$shopId", count: { $sum: 1 } } }
      ]).toArray(),
      db.collection("viewed_vins").aggregate([
        { $match: { shopId: { $in: allShopIdVariants } } },
        { $group: { _id: "$shopId", count: { $sum: 1 } } }
      ]).toArray(),
      db.collection("sticker_generations").aggregate([
        { $match: { shopId: { $in: allShopIdVariants } } },
        { $group: { _id: "$shopId", count: { $sum: 1 } } }
      ]).toArray(),
      db.collection("users").aggregate([
        { $match: { shopId: { $in: allShopIdVariants } } },
        { $group: { _id: "$shopId", count: { $sum: 1 } } }
      ]).toArray(),
      db.collection("support_tickets").aggregate([
        { $match: { shopId: { $in: allShopIdVariants }, status: { $in: ["open", "in_progress"] } } },
        { $group: { _id: "$shopId", count: { $sum: 1 }, tickets: { $push: { ticketNumber: "$ticketNumber", subject: "$subject", priority: "$priority", status: "$status", createdAt: "$createdAt" } } } }
      ]).toArray(),
      db.collection("events").aggregate([
        { $match: { shopId: { $in: allShopIdVariants } } },
        { $sort: { receivedAt: -1 } },
        { $group: { _id: "$shopId", lastEventAt: { $first: "$receivedAt" } } }
      ]).toArray(),
      db.collection("users").aggregate([
        { $match: { shopId: { $in: allShopIdVariants }, lastLogin: { $exists: true } } },
        { $sort: { lastLogin: -1 } },
        { $group: { _id: "$shopId", lastLoginAt: { $first: "$lastLogin" } } }
      ]).toArray(),
    ]);

    const vehicleMap = new Map<string, number>();
    for (const v of vehicleCounts) {
      const key = String(v._id);
      vehicleMap.set(key, (vehicleMap.get(key) || 0) + v.count);
    }

    const vinViewMap = new Map(vinViewCounts.map(v => [String(v._id), v.count]));
    const stickerMap = new Map<string, number>();
    for (const s of stickerCounts) {
      const key = String(s._id);
      stickerMap.set(key, (stickerMap.get(key) || 0) + s.count);
    }
    const userMap = new Map(userCounts.map(u => [String(u._id), u.count]));
    const ticketMap = new Map(openTickets.map(t => [String(t._id), { count: t.count, tickets: t.tickets }]));
    const lastEventMap = new Map(lastEvents.map(e => [String(e._id), e.lastEventAt]));
    const lastLoginMap = new Map(lastLogins.map(l => [String(l._id), l.lastLoginAt]));

    const clientHealthData = shops.map(shop => {
      const sid = String(shop.shopId);
      const vehicleCount = vehicleMap.get(sid) || 0;
      const vinViewCount = vinViewMap.get(sid) || 0;
      const stickerCount = stickerMap.get(sid) || 0;
      const userCount = userMap.get(sid) || 0;
      const ticketInfo = ticketMap.get(sid) || { count: 0, tickets: [] };

      const lastEvent = lastEventMap.get(sid) || null;
      const lastLogin = lastLoginMap.get(sid) || null;
      const lastActivity = lastEvent && lastLogin
        ? new Date(Math.max(new Date(lastEvent).getTime(), new Date(lastLogin).getTime()))
        : lastEvent ? new Date(lastEvent) : lastLogin ? new Date(lastLogin) : null;

      const signals: HealthSignals = {
        billing: getBillingScore(shop),
        integration: getIntegrationScore(shop),
        activity: getActivityScore(lastActivity),
        adoption: getAdoptionScore(shop, vehicleCount, vinViewCount, stickerCount),
        support: getSupportScore(ticketInfo.count),
      };

      const score = computeHealthScore(signals);
      const risk = getRiskLevel(score);

      const integrations: string[] = [];
      if (shop.protractor?.configured || shop.protractor?.apiKey || shop.protractorApiKey || shop.protractorConnectionId) integrations.push("Protractor");
      if (shop.tekmetric?.shopId || shop.tekmetricShopId) integrations.push("Tekmetric");
      if (shop.shopware?.tenantId) integrations.push("Shop-Ware");
      if (shop.autoflow?.apiKey || shop.autoflow?.configured || shop.autoflowApiKey) integrations.push("AutoFlow");
      if (shop.carfax?.locationId || shop.carfax?.serviceId || shop.carfaxLocationId) integrations.push("CARFAX");

      return {
        shopId: shop.shopId,
        name: shop.name || `Shop ${shop.shopId}`,
        score,
        risk,
        signals,
        hasOpenTickets: ticketInfo.count > 0,
        openTicketCount: ticketInfo.count,
        openTickets: ticketInfo.tickets || [],
        billing: {
          plan: shop.billing?.plan || "trial",
          status: shop.billing?.status || "trial",
        },
        integrations,
        userCount,
        vehicleCount,
        vinViewCount,
        stickerCount,
        lastActivity: lastActivity?.toISOString() || null,
        createdAt: shop.createdAt || shop._id.getTimestamp?.() || new Date(),
      };
    });

    clientHealthData.sort((a, b) => a.score - b.score);

    const summary = {
      totalShops: clientHealthData.length,
      avgScore: Math.round(clientHealthData.reduce((sum, c) => sum + c.score, 0) / (clientHealthData.length || 1)),
      healthy: clientHealthData.filter(c => c.risk === "healthy").length,
      monitor: clientHealthData.filter(c => c.risk === "monitor").length,
      atRisk: clientHealthData.filter(c => c.risk === "at-risk").length,
      critical: clientHealthData.filter(c => c.risk === "critical").length,
      withOpenTickets: clientHealthData.filter(c => c.hasOpenTickets).length,
      totalOpenTickets: clientHealthData.reduce((sum, c) => sum + c.openTicketCount, 0),
    };

    return NextResponse.json({ ok: true, summary, clients: clientHealthData });
  } catch (err: any) {
    console.error("Client health error:", err);
    return NextResponse.json({ error: err?.message || "Unknown error" }, { status: 500 });
  }
}
