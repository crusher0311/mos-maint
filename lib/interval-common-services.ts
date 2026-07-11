/**
 * The canonical list of shop-adjustable maintenance services shown on
 * Settings → Intervals. Extracted from the intervals page so the
 * document-import API route and inference lib can share the same key set
 * without importing a page module.
 */
export type CommonService = {
  key: string;
  name: string;
  category: string;
  defaultMiles: number | null;
  defaultMonths: number | null;
};

export const COMMON_SERVICES: CommonService[] = [
  { key: "oil", name: "Oil Change / Engine Oil Filter", category: "Fluids & Filters", defaultMiles: 5000, defaultMonths: 6 },
  { key: "cabin_air", name: "Cabin Air Filter Replacement", category: "Fluids & Filters", defaultMiles: 25000, defaultMonths: 24 },
  { key: "engine_air", name: "Engine Air Filter Replacement", category: "Fluids & Filters", defaultMiles: 30000, defaultMonths: 36 },
  { key: "coolant", name: "Coolant / Antifreeze Service", category: "Fluids & Filters", defaultMiles: 60000, defaultMonths: 60 },
  { key: "brake_fluid", name: "Brake Fluid Service", category: "Fluids & Filters", defaultMiles: 30000, defaultMonths: 24 },
  { key: "trans_auto", name: "Automatic Transmission Fluid", category: "Fluids & Filters", defaultMiles: 60000, defaultMonths: 60 },
  { key: "trans_manual", name: "Manual Transmission Fluid", category: "Fluids & Filters", defaultMiles: 60000, defaultMonths: 60 },
  { key: "transfer_case", name: "Transfer Case Fluid Service", category: "Fluids & Filters", defaultMiles: 30000, defaultMonths: null },
  { key: "front_differential", name: "Front Differential Fluid Service", category: "Fluids & Filters", defaultMiles: 30000, defaultMonths: null },
  { key: "rear_differential", name: "Rear Differential Fluid Service", category: "Fluids & Filters", defaultMiles: 30000, defaultMonths: null },
  { key: "power_steering", name: "Power Steering Fluid", category: "Fluids & Filters", defaultMiles: 60000, defaultMonths: 60 },
  { key: "fuel_filter", name: "Fuel Filter Replacement", category: "Fluids & Filters", defaultMiles: 30000, defaultMonths: 36 },
  { key: "spark_plugs", name: "Spark Plugs Replacement", category: "Engine", defaultMiles: 60000, defaultMonths: null },
  { key: "serpentine_belt", name: "Serpentine / Drive Belt Replacement", category: "Engine", defaultMiles: 60000, defaultMonths: 60 },
  { key: "timing_belt", name: "Timing Belt Replacement", category: "Engine", defaultMiles: 90000, defaultMonths: null },
  { key: "fuel_system", name: "Fuel System / Injection Cleaning", category: "Engine", defaultMiles: 30000, defaultMonths: 36 },
  { key: "front_brake_pads", name: "Front Brake Pads Replacement", category: "Brakes & Suspension", defaultMiles: 40000, defaultMonths: 48 },
  { key: "rear_brake_pads", name: "Rear Brake Pads Replacement", category: "Brakes & Suspension", defaultMiles: 50000, defaultMonths: 48 },
  { key: "front_brake_rotors", name: "Front Brake Rotors Replacement", category: "Brakes & Suspension", defaultMiles: 70000, defaultMonths: null },
  { key: "rear_brake_rotors", name: "Rear Brake Rotors Replacement", category: "Brakes & Suspension", defaultMiles: 70000, defaultMonths: null },
  { key: "front_shocks", name: "Front Shocks / Struts Replacement", category: "Brakes & Suspension", defaultMiles: 100000, defaultMonths: null },
  { key: "rear_shocks", name: "Rear Shocks / Struts Replacement", category: "Brakes & Suspension", defaultMiles: 100000, defaultMonths: null },
  { key: "tire_rotation", name: "Tire Rotation", category: "Tires & Wheels", defaultMiles: 7500, defaultMonths: 6 },
  { key: "wheel_alignment", name: "Wheel Alignment", category: "Tires & Wheels", defaultMiles: 15000, defaultMonths: 12 },
  { key: "battery", name: "Battery Replacement", category: "Electrical", defaultMiles: null, defaultMonths: 60 },
  { key: "wiper_blades", name: "Wiper Blades Replacement", category: "Electrical", defaultMiles: null, defaultMonths: 12 },
  { key: "ac_refrigerant", name: "A/C Refrigerant / Service", category: "Climate", defaultMiles: null, defaultMonths: 36 },
  { key: "emissions", name: "Emissions Test", category: "Compliance", defaultMiles: null, defaultMonths: 24 },
];

export const COMMON_SERVICE_KEYS: ReadonlySet<string> = new Set(
  COMMON_SERVICES.map((s) => s.key),
);

export const COMMON_SERVICE_NAME_BY_KEY: Record<string, string> = Object.fromEntries(
  COMMON_SERVICES.map((s) => [s.key, s.name]),
);
