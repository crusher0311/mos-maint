// lib/job-scoring.ts
// Shared job scoring logic for Job Lookup

type EngineInfo = {
  cylinders: number | null;
  displacement: number | null;
  aspiration: "na" | "turbo" | "supercharged" | null;
  fuelType: "gas" | "diesel" | "hybrid" | "electric" | null;
};

export type ScoreBand = "exact" | "likely" | "possible" | "poor";

export const STOPWORDS = new Set([
  "replace", "inspect", "check", "service", "repair", "install", "remove",
  "adjust", "flush", "bleed", "test", "clean", "lube", "lubricate", 
  "change", "perform", "complete", "top", "off", "the", "and", "for"
]);

export function parseEngineString(engine: string): EngineInfo {
  if (!engine) return { cylinders: null, displacement: null, aspiration: null, fuelType: null };
  
  const normalized = engine.toUpperCase();
  
  let cylinders: number | null = null;
  if (/V\s*8|8\s*CYL|8[-\s]?CYLINDER/.test(normalized)) cylinders = 8;
  else if (/V\s*6|6\s*CYL|6[-\s]?CYLINDER/.test(normalized)) cylinders = 6;
  else if (/I\s*4|L\s*4|4\s*CYL|4[-\s]?CYLINDER/.test(normalized)) cylinders = 4;
  else if (/V\s*10|10\s*CYL/.test(normalized)) cylinders = 10;
  else if (/I\s*6|L\s*6/.test(normalized)) cylinders = 6;
  else if (/I\s*3|L\s*3|3\s*CYL/.test(normalized)) cylinders = 3;
  
  let displacement: number | null = null;
  const literMatch = normalized.match(/(\d+\.?\d*)\s*L(?:ITER)?/);
  if (literMatch) {
    displacement = parseFloat(literMatch[1]);
  } else {
    const ccMatch = normalized.match(/(\d{3,4})\s*CC/);
    if (ccMatch) {
      displacement = parseInt(ccMatch[1]) / 1000;
    }
  }
  
  let aspiration: EngineInfo["aspiration"] = "na";
  if (/TURBO|TWIN\s*TURBO|TT|ECOBOOST/.test(normalized)) aspiration = "turbo";
  else if (/SUPERCHARGE|SC|BLOWER/.test(normalized)) aspiration = "supercharged";
  
  let fuelType: EngineInfo["fuelType"] = "gas";
  if (/DIESEL|TDI|DURAMAX|POWERSTROKE|CUMMINS/.test(normalized)) fuelType = "diesel";
  else if (/HYBRID|HEV|PHEV/.test(normalized)) fuelType = "hybrid";
  else if (/ELECTRIC|EV|BATTERY/.test(normalized)) fuelType = "electric";
  
  return { cylinders, displacement, aspiration, fuelType };
}

export function getScoreBand(score: number, yearDiff?: number): ScoreBand {
  // "Exact" requires high score AND close year match (within 1 year)
  if (score >= 90 && (yearDiff === undefined || yearDiff <= 1)) return "exact";
  if (score >= 75) return "likely";
  if (score >= 50) return "possible";
  return "poor";
}

export function getBandLabel(band: ScoreBand): string {
  switch (band) {
    case "exact": return "Exact Fit";
    case "likely": return "Great Match";
    case "possible": return "Good Match";
    case "poor": return "Low Match";
  }
}

export interface VehicleContext {
  year?: string | number | null;
  make?: string | null;
  model?: string | null;
  engine?: string | null;
}

export interface ScoredJob {
  matchScore: number;
  matchBand: ScoreBand;
  matchBandLabel: string;
  matchReason: string;
  gatePass: boolean;
  scoreBreakdown?: {
    powertrain: number;
    makeModel: number;
    year: number;
    constraints: number;
    evidence: number;
    recency: number;
  };
  [key: string]: any;
}

export function scoreJob(job: any, targetVehicle: VehicleContext): ScoredJob {
  const targetEngine = parseEngineString(targetVehicle.engine || "");
  const targetYear = targetVehicle.year ? parseInt(String(targetVehicle.year)) : null;
  const vehicleMake = targetVehicle.make;
  const vehicleModel = targetVehicle.model;
  
  const jobEngine = parseEngineString(job.vehicle?.engine || "");
  const jobYear = job.vehicle?.year;
  const matchDetails: string[] = [];
  let gatePass = true;
  let gateReason = "";
  let enginePenalty = 0;
  
  // ONLY fuel type is a hard gate - diesel vs gas is truly incompatible
  if (targetEngine.fuelType && jobEngine.fuelType && 
      targetEngine.fuelType !== jobEngine.fuelType) {
    // Diesel/gas mismatch is a hard gate
    if ((targetEngine.fuelType === "diesel" || jobEngine.fuelType === "diesel") &&
        targetEngine.fuelType !== jobEngine.fuelType) {
      gatePass = false;
      gateReason = `Fuel mismatch (${targetEngine.fuelType} vs ${jobEngine.fuelType})`;
    }
  }
  
  // Cylinder and aspiration mismatches are soft penalties, not hard gates
  // Many jobs (oil change, brakes, filters) work across different engine configs
  if (gatePass && targetEngine.cylinders && jobEngine.cylinders && 
      targetEngine.cylinders !== jobEngine.cylinders) {
    enginePenalty += 15;
    matchDetails.push(`Different cylinder count (${jobEngine.cylinders}-cyl)`);
  }
  
  if (gatePass && targetEngine.aspiration && jobEngine.aspiration &&
      targetEngine.aspiration !== jobEngine.aspiration) {
    enginePenalty += 10;
    matchDetails.push(`Different aspiration`);
  }
  
  if (!gatePass) {
    return {
      ...job,
      matchScore: 0,
      matchBand: "poor" as ScoreBand,
      matchBandLabel: "Failed Gate",
      matchReason: gateReason,
      gatePass: false,
    };
  }
  
  // Powertrain scoring
  let powertrainScore = 0;
  if (targetEngine.cylinders && jobEngine.cylinders) {
    if (targetEngine.cylinders === jobEngine.cylinders) {
      if (targetEngine.displacement && jobEngine.displacement) {
        const dispDiff = Math.abs(targetEngine.displacement - jobEngine.displacement);
        if (dispDiff < 0.1) {
          powertrainScore = 40;
          matchDetails.push("Exact engine match");
        } else if (dispDiff < 0.3) {
          powertrainScore = 36;
          matchDetails.push("Same cylinders, similar displacement");
        } else {
          powertrainScore = 30;
          matchDetails.push("Same cylinders");
        }
      } else {
        powertrainScore = 28;
        matchDetails.push("Same cylinders");
      }
    }
  } else if (!targetEngine.cylinders && !jobEngine.cylinders) {
    powertrainScore = 20;
  }
  
  // Make/Model scoring
  let makeModelScore = 0;
  const targetMakeLower = vehicleMake?.toLowerCase() || "";
  const targetModelLower = vehicleModel?.toLowerCase() || "";
  const jobMakeLower = job.vehicle?.make?.toLowerCase() || "";
  const jobModelLower = job.vehicle?.model?.toLowerCase() || "";
  
  if (targetMakeLower === jobMakeLower) {
    makeModelScore += 15;
    matchDetails.push("Same make");
  }
  
  if (targetModelLower && jobModelLower) {
    if (targetModelLower === jobModelLower) {
      makeModelScore += 15;
      matchDetails.push("Same model");
    } else if (targetModelLower.includes(jobModelLower) || jobModelLower.includes(targetModelLower)) {
      makeModelScore += 10;
      matchDetails.push("Model family match");
    }
  }
  
  // Year scoring
  let yearScore = 0;
  if (targetYear && jobYear) {
    const yearDiff = Math.abs(targetYear - jobYear);
    if (yearDiff === 0) {
      yearScore = 10;
      matchDetails.push("Exact year");
    } else if (yearDiff <= 2) {
      yearScore = 8;
      matchDetails.push(`${yearDiff} year${yearDiff > 1 ? 's' : ''} off`);
    } else if (yearDiff <= 4) {
      yearScore = 5;
      matchDetails.push(`${yearDiff} years off`);
    } else {
      yearScore = 2;
      matchDetails.push(`${yearDiff} years off`);
    }
    
    if (powertrainScore >= 36 && yearDiff <= 4) {
      yearScore = Math.min(yearScore + 2, 10);
    }
  }
  
  // Base constraints score
  let constraintScore = 10;
  
  // Evidence scoring
  let evidenceScore = 0;
  const hasPartNumbers = job.lines?.some((l: any) => l.lineType === "part" && l.partNumber);
  if (hasPartNumbers) {
    evidenceScore += 6;
    matchDetails.push("Has part numbers");
  }
  
  // Recency scoring - exponential decay with 180-day half-life (max +10 points)
  // Recent jobs likely have more up-to-date pricing
  let recencyScore = 0;
  if (job.performedAt) {
    const daysSincePerformed = (Date.now() - new Date(job.performedAt).getTime()) / (1000 * 60 * 60 * 24);
    // Formula: 10 * 2^(-days/180) gives +10 at day 0, +5 at 180 days, +2.5 at 360 days
    recencyScore = Math.round(10 * Math.pow(2, -(daysSincePerformed / 180)));
    recencyScore = Math.max(0, Math.min(10, recencyScore)); // Clamp to 0-10
    
    if (recencyScore >= 8) {
      matchDetails.push("Very recent job");
    } else if (recencyScore >= 5) {
      matchDetails.push("Recent job");
    }
  }
  
  const totalScore = powertrainScore + makeModelScore + yearScore + constraintScore + evidenceScore + recencyScore - enginePenalty;
  const normalizedScore = Math.max(0, Math.min(100, totalScore));
  
  // Calculate year difference for band determination
  const yearDiffForBand = (targetYear && jobYear) ? Math.abs(targetYear - jobYear) : undefined;
  const band = getScoreBand(normalizedScore, yearDiffForBand);
  
  return {
    ...job,
    matchScore: normalizedScore,
    matchBand: band,
    matchBandLabel: getBandLabel(band),
    matchReason: matchDetails.join(" | ") || "Keyword match",
    gatePass: true,
    scoreBreakdown: {
      powertrain: powertrainScore,
      makeModel: makeModelScore,
      year: yearScore,
      constraints: constraintScore,
      evidence: evidenceScore,
      recency: recencyScore,
    },
  };
}

export function buildSearchQuery(query: string): { coreTokens: string[]; allTokens: string[] } {
  const allTokens = query.toLowerCase().split(/\s+/).filter(w => w.length > 2);
  const coreTokens = allTokens.filter(w => !STOPWORDS.has(w));
  return { coreTokens, allTokens };
}
