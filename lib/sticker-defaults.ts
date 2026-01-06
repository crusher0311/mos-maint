const EUROPEAN_MAKES = [
  "BMW", "Mercedes-Benz", "Mercedes", "Audi", "Volkswagen", "VW", "Porsche",
  "Volvo", "Jaguar", "Land Rover", "Range Rover", "Mini", "Bentley", "Rolls-Royce",
  "Alfa Romeo", "Fiat", "Ferrari", "Lamborghini", "Maserati", "Peugeot", "Renault",
  "Citroën", "Citroen", "Saab", "Opel", "Vauxhall", "Skoda", "SEAT"
];

export type OilType = "diesel" | "euro" | "synthetic" | "conventional";

export interface IntervalConfig {
  mileage: number;
  months: number;
}

export interface IntervalsConfig {
  diesel: IntervalConfig;
  euro: IntervalConfig;
  synthetic: IntervalConfig;
  conventional: IntervalConfig;
}

export const DEFAULT_INTERVALS: IntervalsConfig = {
  diesel: { mileage: 7500, months: 6 },
  euro: { mileage: 10000, months: 12 },
  synthetic: { mileage: 7500, months: 6 },
  conventional: { mileage: 3000, months: 3 },
};

export interface VehicleContext {
  make?: string;
  fuelType?: string;
  jobDescription?: string;
  oilType?: string;
}

export function determineOilType(context: VehicleContext): OilType {
  const { make, fuelType, jobDescription, oilType } = context;

  if (fuelType?.toLowerCase().includes("diesel")) {
    return "diesel";
  }

  if (make) {
    const normalizedMake = make.trim().toUpperCase();
    const isEuropean = EUROPEAN_MAKES.some(
      (euroMake) => normalizedMake.includes(euroMake.toUpperCase())
    );
    if (isEuropean) {
      return "euro";
    }
  }

  const textToCheck = [jobDescription, oilType].filter(Boolean).join(" ").toLowerCase();
  
  if (textToCheck.includes("synthetic") || textToCheck.includes("full syn")) {
    return "synthetic";
  }

  return "conventional";
}

export function getIntervalForOilType(
  oilType: OilType,
  intervals: Partial<IntervalsConfig> | undefined
): IntervalConfig {
  const merged: IntervalsConfig = {
    diesel: intervals?.diesel || DEFAULT_INTERVALS.diesel,
    euro: intervals?.euro || DEFAULT_INTERVALS.euro,
    synthetic: intervals?.synthetic || DEFAULT_INTERVALS.synthetic,
    conventional: intervals?.conventional || DEFAULT_INTERVALS.conventional,
  };

  return merged[oilType];
}

export function getOilTypeLabel(oilType: OilType): string {
  const labels: Record<OilType, string> = {
    diesel: "Diesel",
    euro: "European",
    synthetic: "Synthetic",
    conventional: "Conventional",
  };
  return labels[oilType];
}
