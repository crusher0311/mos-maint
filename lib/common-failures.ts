import { getOpenAI } from "./ai";
import sql from "@/lib/db/postgres";
import { getNormalizedCache, CACHE_TTL } from "./normalized-cache";
import { getShopPatterns, getEnterprisePatterns, PatternMatch } from "./repair-patterns";

const CACHE_KEY_PREFIX = "common_failures";
const MILEAGE_BUCKET_SIZE = 5000;
const MIN_PATTERNS_FOR_SHOP_ONLY = 3;
const MIN_PATTERN_OCCURRENCES = 2;

export interface CommonFailure {
  repair: string;
  description: string;
  urgency: "low" | "medium" | "high";
  typicalMileageRange: string;
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
  source: "shop_pattern" | "ai" | "default";
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
  dataSource: "shop_patterns" | "ai" | "hybrid" | "defaults";
}

function getMileageBucket(mileage: number): number {
  return Math.floor(mileage / MILEAGE_BUCKET_SIZE) * MILEAGE_BUCKET_SIZE;
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

function estimateUrgency(occurrences: number, avgTotal: number): "low" | "medium" | "high" {
  if (occurrences >= 20 || avgTotal >= 800) return "high";
  if (occurrences >= 10 || avgTotal >= 400) return "medium";
  return "low";
}

function patternToFailure(pattern: PatternMatch, mileage: number): MatchedFailure {
  const bucket = Math.floor(mileage / 5000) * 5000;
  const rangeLow = Math.max(0, bucket - 10000).toLocaleString();
  const rangeHigh = (bucket + 10000).toLocaleString();
  
  return {
    repair: pattern.jobTitle,
    description: `Based on ${pattern.occurrences} repairs performed by your shop on similar vehicles at this mileage.`,
    urgency: estimateUrgency(pattern.occurrences, pattern.avgTotal),
    typicalMileageRange: `${rangeLow} - ${rangeHigh} miles`,
    shopMatch: {
      title: pattern.jobTitle,
      avgTotal: pattern.avgTotal,
      avgHours: pattern.avgHours,
      occurrences: pattern.occurrences,
      lastPerformed: pattern.lastPerformed,
    },
    matchConfidence: pattern.confidence === "high" ? 95 : pattern.confidence === "medium" ? 75 : 50,
    source: "shop_pattern",
  };
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
  
  let shopPatterns: PatternMatch[] = [];
  let enterpriseId: string | undefined;
  
  if (shopIds.length > 0) {
    const shopIdStr = String(shopIds[0]);
    const shopRows = await sql`
      SELECT enterprise_id FROM shops WHERE shop_id = ${shopIdStr} LIMIT 1
    `;
    enterpriseId = shopRows[0]?.enterprise_id as string | undefined;
    
    if (enterpriseId && shopIds.length > 1) {
      shopPatterns = await getEnterprisePatterns({
        enterpriseId,
        year,
        make,
        model,
        mileage,
        limit: 15,
      });
    } else {
      shopPatterns = await getShopPatterns({
        shopId: shopIds[0],
        enterpriseId,
        year,
        make,
        model,
        mileage,
        includeEnterprise: !!enterpriseId,
        limit: 15,
      });
    }
  }
  
  const strongPatterns = shopPatterns.filter(p => p.occurrences >= MIN_PATTERN_OCCURRENCES);
  
  if (strongPatterns.length >= MIN_PATTERNS_FOR_SHOP_ONLY) {
    const failures = strongPatterns.map(p => patternToFailure(p, mileage));
    
    failures.sort((a, b) => {
      if (a.shopMatch && b.shopMatch) {
        return b.shopMatch.occurrences - a.shopMatch.occurrences;
      }
      return b.matchConfidence - a.matchConfidence;
    });
    
    return {
      vehicle: { year, make, model, engine, mileage },
      failures: failures.slice(0, 8),
      cached: false,
      mileageBucket,
      dataSource: "shop_patterns",
    };
  }
  
  const cacheKey = {
    year,
    make: make.toLowerCase(),
    model: model.toLowerCase(),
    engine: engine?.toLowerCase() || '',
    mileageBucket,
  };
  
  const cached = cache.get<CommonFailure[]>(CACHE_KEY_PREFIX, cacheKey);
  
  let aiFailures: CommonFailure[];
  let wasCached = false;
  
  if (cached) {
    aiFailures = cached;
    wasCached = true;
  } else {
    aiFailures = await fetchFailuresFromAI(year, make, model, mileage, engine);
    cache.set(CACHE_KEY_PREFIX, cacheKey, aiFailures, CACHE_TTL.LONG * 12);
  }
  
  const matchedFailures = await matchFailuresToShopHistory(aiFailures, shopIds, strongPatterns);
  
  const matchedTitles = new Set(matchedFailures.map(f => normalizeTitle(f.repair)));
  const additionalPatterns = strongPatterns
    .filter(p => !matchedTitles.has(normalizeTitle(p.jobTitle)))
    .map(p => patternToFailure(p, mileage));
  
  const combined = [...matchedFailures, ...additionalPatterns];
  
  combined.sort((a, b) => {
    const urgencyOrder = { high: 3, medium: 2, low: 1 };
    const urgencyDiff = urgencyOrder[b.urgency] - urgencyOrder[a.urgency];
    if (urgencyDiff !== 0) return urgencyDiff;
    return b.matchConfidence - a.matchConfidence;
  });
  
  const dataSource = strongPatterns.length > 0 ? "hybrid" : (aiFailures.length > 0 ? "ai" : "defaults");
  
  return {
    vehicle: { year, make, model, engine, mileage },
    failures: combined.slice(0, 8),
    cached: wasCached,
    mileageBucket,
    dataSource,
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
      symptoms: ["Squeaking when braking", "Longer stopping distance"]
    });
  }
  
  if (mileage >= 90000) {
    defaults.push({
      repair: "Timing Belt/Chain Service",
      description: "Timing components require attention around 90,000-100,000 miles to prevent engine damage.",
      urgency: "high",
      typicalMileageRange: "90,000 - 100,000 miles",
      symptoms: ["Engine misfires", "Ticking noise from engine"]
    });
  }
  
  if (mileage >= 75000) {
    defaults.push({
      repair: "Water Pump Replacement",
      description: "Water pumps commonly fail between 60,000-100,000 miles.",
      urgency: "medium",
      typicalMileageRange: "60,000 - 100,000 miles",
      symptoms: ["Coolant leak", "Engine overheating"]
    });
  }
  
  return defaults;
}

async function matchFailuresToShopHistory(
  failures: CommonFailure[],
  shopIds: number[],
  existingPatterns: PatternMatch[]
): Promise<MatchedFailure[]> {
  if (failures.length === 0) {
    return [];
  }
  
  const matchedFailures: MatchedFailure[] = failures.map(failure => {
    let bestMatch: PatternMatch | null = null;
    let bestScore = 0;
    
    for (const pattern of existingPatterns) {
      const score = calculateMatchScore(failure.repair, pattern.jobTitle);
      if (score > bestScore && score >= 40) {
        bestScore = score;
        bestMatch = pattern;
      }
    }
    
    const result: MatchedFailure = {
      ...failure,
      matchConfidence: bestScore,
      source: "ai",
    };
    
    if (bestMatch) {
      result.shopMatch = {
        title: bestMatch.jobTitle,
        avgTotal: bestMatch.avgTotal,
        avgHours: bestMatch.avgHours,
        occurrences: bestMatch.occurrences,
        lastPerformed: bestMatch.lastPerformed,
      };
    }
    
    return result;
  });
  
  const unmatchedFailures = matchedFailures.filter(f => !f.shopMatch);
  if (unmatchedFailures.length > 0 && shopIds.length > 0 && existingPatterns.length === 0) {
    const shopIdStrs = shopIds.map(id => String(id));
    
    const repairKeywords = unmatchedFailures.map(f => {
      const words = f.repair.toLowerCase().split(/\s+/).filter(w => w.length > 2);
      return words;
    });
    
    const allKeywords = [...new Set(repairKeywords.flat())];
    
    if (allKeywords.length > 0) {
      const keywordPattern = allKeywords.join('|');
      
      const rows = await sql`
        SELECT 
          LOWER(TRIM(title)) as normalized_title,
          MIN(title) as title,
          AVG(total) as avg_total,
          AVG(COALESCE(labor_hours_billed, labor_hours_actual)) as avg_hours,
          COUNT(*) as count,
          MAX(completed_at) as last_performed
        FROM service_jobs sj
        JOIN shops s ON sj.shop_id = s.id
        WHERE s.shop_id = ANY(${shopIdStrs})
          AND (sj.soft_delete IS NULL OR sj.soft_delete->>'isDeleted' != 'true')
          AND sj.status IN ('completed', 'authorized')
          AND LOWER(sj.title) ~ ${keywordPattern}
        GROUP BY LOWER(TRIM(title))
        LIMIT 100
      `;
      
      for (const failure of unmatchedFailures) {
        let bestJobMatch: any = null;
        let bestJobScore = 0;
        
        for (const job of rows) {
          const score = calculateMatchScore(failure.repair, job.title as string);
          if (score > bestJobScore && score >= 40) {
            bestJobScore = score;
            bestJobMatch = job;
          }
        }
        
        if (bestJobMatch) {
          failure.matchConfidence = bestJobScore;
          failure.shopMatch = {
            title: bestJobMatch.title,
            avgTotal: bestJobMatch.avg_total ? Math.round(Number(bestJobMatch.avg_total) * 100) / 100 : 0,
            avgHours: bestJobMatch.avg_hours ? Math.round(Number(bestJobMatch.avg_hours) * 10) / 10 : 0,
            occurrences: Number(bestJobMatch.count),
            lastPerformed: bestJobMatch.last_performed ? new Date(bestJobMatch.last_performed as string) : undefined,
          };
        }
      }
    }
  }
  
  return matchedFailures;
}
