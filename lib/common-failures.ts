import { getOpenAI } from "./ai";
import { getDb } from "./mongo";
import { NORMALIZED_COLLECTIONS } from "./normalized-schema";
import { getNormalizedCache, CACHE_TTL } from "./normalized-cache";

const CACHE_KEY_PREFIX = "common_failures";
const MILEAGE_BUCKET_SIZE = 5000;

export interface CommonFailure {
  repair: string;
  description: string;
  urgency: "low" | "medium" | "high";
  typicalMileageRange: string;
  estimatedCostRange: string;
  symptoms?: string[];
}

export interface MatchedFailure extends CommonFailure {
  shopMatch?: {
    title: string;
    avgTotal: number;
    avgHours: number;
    occurrences: number;
    lastPerformed?: Date;
  };
  matchConfidence: number;
}

export interface CommonFailuresResult {
  vehicle: {
    year: number;
    make: string;
    model: string;
    engine?: string;
    mileage: number;
  };
  failures: MatchedFailure[];
  cached: boolean;
  mileageBucket: number;
}

function getMileageBucket(mileage: number): number {
  return Math.floor(mileage / MILEAGE_BUCKET_SIZE) * MILEAGE_BUCKET_SIZE;
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeTitle(title: string): string {
  return title.toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function calculateMatchScore(aiRepair: string, shopTitle: string): number {
  const normalizedAi = normalizeTitle(aiRepair);
  const normalizedShop = normalizeTitle(shopTitle);
  
  if (normalizedAi === normalizedShop) return 100;
  if (normalizedShop.includes(normalizedAi) || normalizedAi.includes(normalizedShop)) return 80;
  
  const aiWords = normalizedAi.split(' ').filter(w => w.length > 2);
  const shopWords = normalizedShop.split(' ').filter(w => w.length > 2);
  
  let matchCount = 0;
  for (const aiWord of aiWords) {
    if (shopWords.some(sw => sw.includes(aiWord) || aiWord.includes(sw))) {
      matchCount++;
    }
  }
  
  if (aiWords.length === 0) return 0;
  return Math.round((matchCount / aiWords.length) * 70);
}

const COMMON_FAILURES_PROMPT = `You are an automotive expert. Given a vehicle's year, make, model, engine, and current mileage, identify the most common failures and repairs that vehicles like this typically need around this mileage range (+/- 15,000 miles).

Focus on:
- Known failure points for this specific powertrain
- Common wear items at this mileage
- Manufacturer service bulletins and recalls
- Real-world failure patterns reported by shops

Return ONLY a JSON array with 5-8 items. Each item must have:
- "repair": Short repair name (e.g., "Water Pump Replacement")
- "description": Brief explanation of why this is common for this vehicle/mileage
- "urgency": "low", "medium", or "high" based on safety/reliability impact
- "typicalMileageRange": Range when this typically occurs (e.g., "80,000 - 100,000 miles")
- "estimatedCostRange": Typical repair cost range (e.g., "$400 - $600")
- "symptoms": Array of 2-3 warning signs (optional)

Return ONLY the JSON array, no markdown or explanation.`;

export async function getCommonFailures(
  year: number,
  make: string,
  model: string,
  mileage: number,
  shopIds: number[],
  engine?: string
): Promise<CommonFailuresResult> {
  const cache = getNormalizedCache();
  const mileageBucket = getMileageBucket(mileage);
  
  const cacheKey = {
    year,
    make: make.toLowerCase(),
    model: model.toLowerCase(),
    engine: engine?.toLowerCase() || '',
    mileageBucket,
  };
  
  const cached = cache.get<CommonFailure[]>(CACHE_KEY_PREFIX, cacheKey);
  
  let failures: CommonFailure[];
  let wasCached = false;
  
  if (cached) {
    failures = cached;
    wasCached = true;
  } else {
    failures = await fetchFailuresFromAI(year, make, model, mileage, engine);
    cache.set(CACHE_KEY_PREFIX, cacheKey, failures, CACHE_TTL.LONG * 12);
  }
  
  const matchedFailures = await matchFailuresToShopHistory(failures, shopIds);
  
  return {
    vehicle: { year, make, model, engine, mileage },
    failures: matchedFailures,
    cached: wasCached,
    mileageBucket,
  };
}

async function fetchFailuresFromAI(
  year: number,
  make: string,
  model: string,
  mileage: number,
  engine?: string
): Promise<CommonFailure[]> {
  const openai = getOpenAI();
  
  const vehicleDescription = engine 
    ? `${year} ${make} ${model} with ${engine} engine at ${mileage.toLocaleString()} miles`
    : `${year} ${make} ${model} at ${mileage.toLocaleString()} miles`;
  
  const userPrompt = `Vehicle: ${vehicleDescription}

Identify the most common failures and repairs for this vehicle around this mileage.`;

  try {
    const response = await openai.chat([
      { role: "system", content: COMMON_FAILURES_PROMPT },
      { role: "user", content: userPrompt }
    ], "gpt-4o-mini");
    
    const content = response.choices?.[0]?.message?.content || "";
    
    const jsonMatch = content.match(/\[[\s\S]*\]/);
    if (!jsonMatch) {
      console.error("Failed to parse AI response:", content);
      return getDefaultFailures(mileage);
    }
    
    const parsed = JSON.parse(jsonMatch[0]) as CommonFailure[];
    
    return parsed.filter(f => 
      f.repair && 
      f.description && 
      ['low', 'medium', 'high'].includes(f.urgency)
    );
  } catch (error) {
    console.error("AI failure prediction error:", error);
    return getDefaultFailures(mileage);
  }
}

function getDefaultFailures(mileage: number): CommonFailure[] {
  const defaults: CommonFailure[] = [];
  
  if (mileage >= 60000) {
    defaults.push({
      repair: "Brake Pad Replacement",
      description: "Brake pads typically wear out between 30,000-70,000 miles depending on driving habits.",
      urgency: "medium",
      typicalMileageRange: "30,000 - 70,000 miles",
      estimatedCostRange: "$150 - $300 per axle",
      symptoms: ["Squeaking when braking", "Longer stopping distance"]
    });
  }
  
  if (mileage >= 90000) {
    defaults.push({
      repair: "Timing Belt/Chain Service",
      description: "Timing components require attention around 90,000-100,000 miles to prevent engine damage.",
      urgency: "high",
      typicalMileageRange: "90,000 - 100,000 miles",
      estimatedCostRange: "$500 - $1,000",
      symptoms: ["Engine misfires", "Ticking noise from engine"]
    });
  }
  
  if (mileage >= 75000) {
    defaults.push({
      repair: "Water Pump Replacement",
      description: "Water pumps commonly fail between 60,000-100,000 miles.",
      urgency: "medium",
      typicalMileageRange: "60,000 - 100,000 miles",
      estimatedCostRange: "$400 - $700",
      symptoms: ["Coolant leak", "Engine overheating"]
    });
  }
  
  return defaults;
}

async function matchFailuresToShopHistory(
  failures: CommonFailure[],
  shopIds: number[]
): Promise<MatchedFailure[]> {
  if (failures.length === 0 || shopIds.length === 0) {
    return failures.map(f => ({ ...f, matchConfidence: 0 }));
  }
  
  const db = await getDb();
  const serviceJobsCollection = db.collection(NORMALIZED_COLLECTIONS.serviceJobs);
  
  const repairKeywords = failures.map(f => {
    const words = f.repair.toLowerCase().split(/\s+/).filter(w => w.length > 2);
    return words.map(escapeRegex);
  });
  
  const allKeywords = [...new Set(repairKeywords.flat())];
  
  if (allKeywords.length === 0) {
    return failures.map(f => ({ ...f, matchConfidence: 0 }));
  }
  
  const pipeline = [
    {
      $match: {
        shopId: { $in: shopIds },
        'softDelete.isDeleted': { $ne: true },
        status: { $in: ['completed', 'authorized'] },
        $or: allKeywords.map(kw => ({
          title: { $regex: kw, $options: 'i' }
        }))
      }
    },
    {
      $group: {
        _id: { $toLower: { $trim: { input: '$title' } } },
        title: { $first: '$title' },
        avgTotal: { $avg: '$total' },
        avgHours: { $avg: { $ifNull: ['$laborHoursBilled', '$laborHoursActual'] } },
        count: { $sum: 1 },
        lastPerformed: { $max: '$completedAt' }
      }
    },
    { $limit: 100 }
  ];
  
  const shopJobs = await serviceJobsCollection.aggregate(pipeline).toArray();
  
  const matchedFailures: MatchedFailure[] = failures.map(failure => {
    let bestMatch: any = null;
    let bestScore = 0;
    
    for (const job of shopJobs) {
      const score = calculateMatchScore(failure.repair, job.title);
      if (score > bestScore && score >= 40) {
        bestScore = score;
        bestMatch = job;
      }
    }
    
    const result: MatchedFailure = {
      ...failure,
      matchConfidence: bestScore,
    };
    
    if (bestMatch) {
      result.shopMatch = {
        title: bestMatch.title,
        avgTotal: bestMatch.avgTotal ? Math.round(bestMatch.avgTotal * 100) / 100 : 0,
        avgHours: bestMatch.avgHours ? Math.round(bestMatch.avgHours * 10) / 10 : 0,
        occurrences: bestMatch.count,
        lastPerformed: bestMatch.lastPerformed,
      };
    }
    
    return result;
  });
  
  matchedFailures.sort((a, b) => {
    const urgencyOrder = { high: 3, medium: 2, low: 1 };
    const urgencyDiff = urgencyOrder[b.urgency] - urgencyOrder[a.urgency];
    if (urgencyDiff !== 0) return urgencyDiff;
    return b.matchConfidence - a.matchConfidence;
  });
  
  return matchedFailures;
}
