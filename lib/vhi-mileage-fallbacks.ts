import { estimateMileageFromCarfax } from "@/lib/integrations/carfax";
import { getEnhancedVehicleData } from "@/lib/integrations/dataone-api";

const VIN_YEAR_LETTERS_PRE_2010: Record<string, number> = {
  A: 1980, B: 1981, C: 1982, D: 1983, E: 1984, F: 1985, G: 1986, H: 1987,
  J: 1988, K: 1989, L: 1990, M: 1991, N: 1992, P: 1993, R: 1994, S: 1995,
  T: 1996, V: 1997, W: 1998, X: 1999, Y: 2000,
  "1": 2001, "2": 2002, "3": 2003, "4": 2004, "5": 2005,
  "6": 2006, "7": 2007, "8": 2008, "9": 2009,
};
const VIN_YEAR_LETTERS_POST_2010: Record<string, number> = {
  A: 2010, B: 2011, C: 2012, D: 2013, E: 2014, F: 2015, G: 2016, H: 2017,
  J: 2018, K: 2019, L: 2020, M: 2021, N: 2022, P: 2023, R: 2024, S: 2025,
  T: 2026, V: 2027, W: 2028, X: 2029, Y: 2030,
};

function decodeYearFromVin(vin: string): number | null {
  if (!vin || vin.length < 10) return null;
  const v = vin.toUpperCase();
  const pos7 = v[6];
  const pos10 = v[9];
  const isPost2010 = /[A-Z]/.test(pos7);
  const map = isPost2010 ? VIN_YEAR_LETTERS_POST_2010 : VIN_YEAR_LETTERS_PRE_2010;
  return map[pos10] ?? null;
}

export type ResolvedMileageSource = "actual" | "estimated_carfax" | "estimated_annual";

export interface ResolvedMileage {
  mileage: number;
  source: ResolvedMileageSource;
  estimateDetails: Record<string, unknown> | null;
}

/**
 * Mileage estimation waterfall used when no actual odometer is available.
 * Tries CARFAX service-history projection first, then a year×12k US-average
 * fallback. Returns null only when both fail (no CARFAX data AND no decodable
 * model year).
 *
 * Used by partner-facing routes so a request for a vehicle without an
 * odometer still returns a usable (clearly-marked-as-estimated) VHI instead
 * of a hard 400 — matches the behavior of GET /api/external/vehicles/{vin}/vhi.
 */
export async function estimateMileageWhenMissing(opts: {
  shopId: number;
  vin: string;
  /** Optional pre-fetched model year (from a vehicles doc). Skips DataOne lookup when present. */
  knownYear?: number | null;
}): Promise<ResolvedMileage | null> {
  const { shopId, vin } = opts;
  const vinUpper = vin.toUpperCase();

  // Fallback 1: CARFAX rolling miles/day projection
  try {
    const est = await estimateMileageFromCarfax(Number(shopId), vinUpper);
    if (est.estimated && est.mileage && est.mileage > 0) {
      console.log(
        `[Mileage Fallback] Estimated ${est.mileage} from CARFAX for ${vinUpper} shop=${shopId} confidence=${est.confidence}`
      );
      return {
        mileage: est.mileage,
        source: "estimated_carfax",
        estimateDetails: {
          confidence: est.confidence,
          dataPoints: est.dataPoints,
          lastRecordedMileage: est.lastRecordedMileage,
          lastRecordedDate: est.lastRecordedDate,
          milesPerDay: est.milesPerDay,
        },
      };
    } else {
      console.log(
        `[Mileage Fallback] CARFAX estimate unavailable for ${vinUpper} shop=${shopId}: ${
          est.estimated ? "no mileage returned" : est.reason
        }`
      );
    }
  } catch (err) {
    console.warn(
      `[Mileage Fallback] CARFAX estimate threw for ${vinUpper}:`,
      err instanceof Error ? err.message : err
    );
  }

  // Fallback 2: model-year × 12k miles/year (US average)
  let year: number | null =
    opts.knownYear && Number(opts.knownYear) > 1980 ? Number(opts.knownYear) : null;
  let yearSource = year ? "vehicles_doc" : null;

  if (!year) {
    try {
      const enhanced = await getEnhancedVehicleData(vinUpper);
      const yr = enhanced?.vehicle?.year ? Number(enhanced.vehicle.year) : null;
      if (yr && yr > 1980) {
        year = yr;
        yearSource = "dataone_decode";
      }
    } catch (err) {
      console.warn(
        `[Mileage Fallback] DataOne decode threw for ${vinUpper}:`,
        err instanceof Error ? err.message : err
      );
    }
  }

  if (!year) {
    const decoded = decodeYearFromVin(vinUpper);
    if (decoded) {
      year = decoded;
      yearSource = "vin_position_10";
    }
  }

  if (year) {
    const age = Math.max(1, new Date().getFullYear() - year);
    const estimated = Math.min(250000, Math.max(12000, age * 12000));
    console.log(
      `[Mileage Fallback] Estimated ${estimated} from model year ${year} (source=${yearSource}) for ${vinUpper} (12k/yr)`
    );
    return {
      mileage: estimated,
      source: "estimated_annual",
      estimateDetails: {
        confidence: "very-low",
        method: "model_year_x_12k",
        modelYear: year,
        yearSource,
        assumedMilesPerYear: 12000,
      },
    };
  }

  console.warn(
    `[Mileage Fallback] No mileage and no decodable year for ${vinUpper} shop=${shopId} — caller must 400`
  );
  return null;
}
