import { getDb } from "./mongo";

export interface UsageLog {
  _id?: any;
  shopId: number | string;
  userId?: string;
  userEmail?: string;
  action: "analyze" | "chat" | "other";
  model: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  estimatedCost: number;
  vin?: string;
  metadata?: Record<string, any>;
  createdAt: Date;
}

const MODEL_PRICING: Record<string, { input: number; output: number }> = {
  "gpt-4.1": { input: 0.15, output: 0.60 },
  "gpt-4.1-mini": { input: 0.15, output: 0.60 },
  "gpt-4o-mini": { input: 0.15, output: 0.60 },
  "gpt-4o": { input: 5.0, output: 15.0 },
  "gpt-4-turbo": { input: 10.0, output: 30.0 },
  "gpt-4": { input: 30.0, output: 60.0 },
  "gpt-3.5-turbo": { input: 0.5, output: 1.5 },
};

export function estimateCost(model: string, inputTokens: number, outputTokens: number): number {
  const pricing = MODEL_PRICING[model] || MODEL_PRICING["gpt-4o-mini"];
  const inputCost = (inputTokens / 1_000_000) * pricing.input;
  const outputCost = (outputTokens / 1_000_000) * pricing.output;
  return inputCost + outputCost;
}

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export async function logUsage(log: Omit<UsageLog, "_id" | "createdAt" | "estimatedCost"> & { estimatedCost?: number }) {
  const db = await getDb();
  const cost = log.estimatedCost ?? estimateCost(log.model, log.inputTokens, log.outputTokens);
  
  const doc: UsageLog = {
    ...log,
    estimatedCost: cost,
    createdAt: new Date(),
  };
  
  return db.collection<UsageLog>("usage_logs").insertOne(doc);
}

export async function getUsageByShop(shopId: number | string, startDate?: Date, endDate?: Date) {
  const db = await getDb();
  
  const match: any = { shopId: String(shopId) };
  if (startDate || endDate) {
    match.createdAt = {};
    if (startDate) match.createdAt.$gte = startDate;
    if (endDate) match.createdAt.$lte = endDate;
  }
  
  const result = await db.collection<UsageLog>("usage_logs").aggregate([
    { $match: match },
    {
      $group: {
        _id: { action: "$action", model: "$model" },
        count: { $sum: 1 },
        totalInputTokens: { $sum: "$inputTokens" },
        totalOutputTokens: { $sum: "$outputTokens" },
        totalTokens: { $sum: "$totalTokens" },
        totalCost: { $sum: "$estimatedCost" },
      }
    }
  ]).toArray();
  
  return result;
}

export async function getUsageAnalytics(startDate?: Date, endDate?: Date) {
  const db = await getDb();
  
  const match: any = {};
  if (startDate || endDate) {
    match.createdAt = {};
    if (startDate) match.createdAt.$gte = startDate;
    if (endDate) match.createdAt.$lte = endDate;
  }
  
  const byShop = await db.collection<UsageLog>("usage_logs").aggregate([
    { $match: match },
    {
      $group: {
        _id: "$shopId",
        requestCount: { $sum: 1 },
        totalInputTokens: { $sum: "$inputTokens" },
        totalOutputTokens: { $sum: "$outputTokens" },
        totalTokens: { $sum: "$totalTokens" },
        totalCost: { $sum: "$estimatedCost" },
        uniqueVins: { $addToSet: "$vin" },
      }
    },
    { $sort: { totalCost: -1 } }
  ]).toArray();
  
  const byModel = await db.collection<UsageLog>("usage_logs").aggregate([
    { $match: match },
    {
      $group: {
        _id: "$model",
        requestCount: { $sum: 1 },
        totalCost: { $sum: "$estimatedCost" },
      }
    }
  ]).toArray();
  
  const byDay = await db.collection<UsageLog>("usage_logs").aggregate([
    { $match: match },
    {
      $group: {
        _id: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt" } },
        requestCount: { $sum: 1 },
        totalCost: { $sum: "$estimatedCost" },
      }
    },
    { $sort: { _id: 1 } }
  ]).toArray();
  
  const totals = await db.collection<UsageLog>("usage_logs").aggregate([
    { $match: match },
    {
      $group: {
        _id: null,
        requestCount: { $sum: 1 },
        totalInputTokens: { $sum: "$inputTokens" },
        totalOutputTokens: { $sum: "$outputTokens" },
        totalTokens: { $sum: "$totalTokens" },
        totalCost: { $sum: "$estimatedCost" },
        uniqueVins: { $addToSet: "$vin" },
      }
    }
  ]).toArray();
  
  const shopIds = byShop.map(s => s._id);
  const shops = await db.collection("shops")
    .find({ $or: [
      { shopId: { $in: shopIds.map(id => Number(id)).filter(n => !isNaN(n)) } },
      { shopId: { $in: shopIds } }
    ]})
    .toArray();
  const shopMap = new Map(shops.map(s => [String(s.shopId), s.name]));

  const viewDateMatch: any = {};
  if (startDate || endDate) {
    viewDateMatch.firstViewedAt = {};
    if (startDate) viewDateMatch.firstViewedAt.$gte = startDate;
    if (endDate) viewDateMatch.firstViewedAt.$lte = endDate;
  }
  const totalViews = await db.collection("viewed_vins").countDocuments(
    Object.keys(viewDateMatch).length > 0 ? viewDateMatch : {}
  );
  
  const totalCost = totals[0]?.totalCost || 0;
  const uniqueVinsProcessed = (totals[0]?.uniqueVins || []).filter(Boolean).length;
  const costPerVin = uniqueVinsProcessed > 0 ? totalCost / uniqueVinsProcessed : 0;
  const costPerView = totalViews > 0 ? totalCost / totalViews : 0;
  
  const shopBreakdown = byShop.map(s => ({
    shopId: s._id,
    shopName: shopMap.get(String(s._id)) || `Shop ${s._id}`,
    requestCount: s.requestCount,
    totalTokens: s.totalTokens,
    totalCost: s.totalCost,
    uniqueVins: (s.uniqueVins || []).filter(Boolean).length,
  }));
  
  return {
    totals: {
      ...(totals[0] || { requestCount: 0, totalTokens: 0, totalCost: 0 }),
      uniqueVinsProcessed,
      totalViews,
      costPerVin,
      costPerView,
    },
    byShop: shopBreakdown,
    byModel,
    byDay,
  };
}
