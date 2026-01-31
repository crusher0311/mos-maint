import postgres from "postgres";

const sql = postgres(process.env.DATABASE_URL!);

function toSquish(vin: string): string {
  const v = String(vin).toUpperCase().trim();
  return v.slice(0, 8) + v.slice(9, 11);
}

export interface VinReferenceData {
  vin_id: number;
  vehicle_id: number;
  vin_pattern: string;
  year: number;
  make: string;
  model: string;
  trim: string;
  style: string;
  mfr_model_num: string | null;
  doors: number;
  drive_type: string;
  vehicle_type: string;
  body_type: string;
  body_subtype: string;
  bed_length: string | null;
  engine_id: number;
  engine_name: string;
  engine_size: number;
  engine_block: string;
  engine_cylinders: number;
  engine_valves: number;
  engine_induction: string;
  engine_aspiration: string;
  engine_cam_type: string;
  fuel_type: string;
  trans_id: number;
  trans_name: string;
  trans_type: string;
  trans_speeds: number;
  wheelbase: number;
  gross_vehicle_weight_range: string;
  restraint_type: string;
  brake_system: string;
  country_of_mfr: string;
  plant: string;
}

export interface MaintenanceItem {
  maintenance_id: number;
  maintenance_category: string;
  maintenance_name: string;
  maintenance_notes: string | null;
  intervals: {
    interval_id: number;
    interval_type: string;
    value: number;
    units: string;
    initial_value: number;
  }[];
  miles: number | null;
  months: number | null;
}

export async function decodeVinLocal(vin: string): Promise<{
  ok: boolean;
  vin: string;
  decoded?: VinReferenceData;
  error?: string;
  source: "local";
}> {
  try {
    const squish = toSquish(vin);
    
    const result = await sql<VinReferenceData[]>`
      SELECT * FROM dataone_vin_reference 
      WHERE vin_pattern = ${squish}
      LIMIT 1
    `;
    
    if (result.length === 0) {
      return { ok: false, vin, error: "VIN not found in database", source: "local" };
    }
    
    return { ok: true, vin, decoded: result[0], source: "local" };
  } catch (error) {
    console.error("DataOne VIN decode error:", error);
    return { ok: false, vin, error: String(error), source: "local" };
  }
}

export async function getMaintenanceScheduleLocal(vin: string): Promise<{
  ok: boolean;
  vin: string;
  squish: string;
  count: number;
  items: MaintenanceItem[];
  error?: string;
  source: "local";
}> {
  try {
    const squish = toSquish(vin);
    
    const vinMaintenance = await sql`
      SELECT vm.vin_maintenance_id, vm.maintenance_id, vm.maintenance_schedule_id
      FROM dataone_lkp_vin_maintenance vm
      WHERE vm.squish = ${squish}
    `;
    
    if (vinMaintenance.length === 0) {
      return { ok: false, vin, squish, count: 0, items: [], error: "No maintenance data found for this VIN", source: "local" };
    }
    
    const maintenanceIds = [...new Set(vinMaintenance.map(vm => vm.maintenance_id))];
    const vinMaintenanceIds = vinMaintenance.map(vm => vm.vin_maintenance_id);
    
    const [maintenanceDefs, intervals] = await Promise.all([
      sql`
        SELECT maintenance_id, maintenance_category, maintenance_name, maintenance_notes
        FROM dataone_def_maintenance
        WHERE maintenance_id = ANY(${maintenanceIds})
      `,
      sql`
        SELECT vmi.vin_maintenance_id, vmi.maintenance_interval_id, vmi.maintenance_operating_parameter_id
        FROM dataone_lkp_vin_maintenance_interval vmi
        WHERE vmi.vin_maintenance_id = ANY(${vinMaintenanceIds})
      `
    ]);
    
    const intervalIds = [...new Set(intervals.map(i => i.maintenance_interval_id).filter((id: number) => id > 0))];
    
    let intervalDefs: any[] = [];
    if (intervalIds.length > 0) {
      intervalDefs = await sql`
        SELECT maintenance_interval_id, interval_type, value, units, initial_value
        FROM dataone_def_maintenance_interval
        WHERE maintenance_interval_id = ANY(${intervalIds})
      `;
    }
    
    const maintenanceDefMap = new Map(maintenanceDefs.map(d => [d.maintenance_id, d]));
    const intervalDefMap = new Map(intervalDefs.map(d => [d.maintenance_interval_id, d]));
    const vinMaintenanceMap = new Map(vinMaintenance.map(vm => [vm.vin_maintenance_id, vm]));
    
    const itemsMap = new Map<number, MaintenanceItem>();
    
    for (const vm of vinMaintenance) {
      const def = maintenanceDefMap.get(vm.maintenance_id);
      if (!def) continue;
      
      if (!itemsMap.has(vm.maintenance_id)) {
        itemsMap.set(vm.maintenance_id, {
          maintenance_id: vm.maintenance_id,
          maintenance_category: def.maintenance_category || "General",
          maintenance_name: def.maintenance_name || "Unknown",
          maintenance_notes: def.maintenance_notes,
          intervals: [],
          miles: null,
          months: null,
        });
      }
    }
    
    for (const interval of intervals) {
      const vm = vinMaintenanceMap.get(interval.vin_maintenance_id);
      if (!vm) continue;
      
      const item = itemsMap.get(vm.maintenance_id);
      if (!item) continue;
      
      const intervalDef = intervalDefMap.get(interval.maintenance_interval_id);
      if (intervalDef) {
        item.intervals.push({
          interval_id: intervalDef.maintenance_interval_id,
          interval_type: intervalDef.interval_type,
          value: intervalDef.value,
          units: intervalDef.units,
          initial_value: intervalDef.initial_value,
        });
        
        if (intervalDef.units === "Miles" && (item.miles === null || intervalDef.value < item.miles)) {
          item.miles = intervalDef.value;
        }
        if (intervalDef.units === "Months" && (item.months === null || intervalDef.value < item.months)) {
          item.months = intervalDef.value;
        }
      }
    }
    
    const items = Array.from(itemsMap.values()).sort((a, b) => {
      const catCompare = a.maintenance_category.localeCompare(b.maintenance_category);
      if (catCompare !== 0) return catCompare;
      return a.maintenance_name.localeCompare(b.maintenance_name);
    });
    
    return { ok: true, vin, squish, count: items.length, items, source: "local" };
  } catch (error) {
    console.error("DataOne maintenance schedule error:", error);
    return { ok: false, vin, squish: toSquish(vin), count: 0, items: [], error: String(error), source: "local" };
  }
}

export async function getEnhancedVehicleDataLocal(vin: string): Promise<{
  ok: boolean;
  vin: string;
  vehicle?: {
    year: number;
    make: string;
    model: string;
    trim: string;
    style: string;
    engine: string;
    transmission: string;
    driveType: string;
    bodyType: string;
    fuelType: string;
    cylinders: number;
    doors: number;
  };
  error?: string;
  source: "local";
}> {
  const decoded = await decodeVinLocal(vin);
  
  if (!decoded.ok || !decoded.decoded) {
    return { ok: false, vin, error: decoded.error, source: "local" };
  }
  
  const d = decoded.decoded;
  
  return {
    ok: true,
    vin,
    vehicle: {
      year: d.year,
      make: d.make,
      model: d.model,
      trim: d.trim,
      style: d.style,
      engine: d.engine_name,
      transmission: d.trans_name,
      driveType: d.drive_type,
      bodyType: d.body_type,
      fuelType: d.fuel_type === "G" ? "Gasoline" : d.fuel_type === "D" ? "Diesel" : d.fuel_type === "E" ? "Electric" : d.fuel_type,
      cylinders: d.engine_cylinders,
      doors: d.doors,
    },
    source: "local",
  };
}

export interface VehicleRecall {
  nhtsa_recall_id: number;
  nhtsa_campaign_number: string;
  report_manufacturer: string;
  component_description: string;
  defect_summary: string;
  consequence_summary: string;
  corrective_action_summary: string;
  potential_units_affected: number;
  report_received_date: string | null;
  record_creation_date: string | null;
  regulation_part_number: string | null;
  fmvvs_number: string | null;
  isSafetyCritical?: boolean;
}

const SAFETY_CRITICAL_KEYWORDS = [
  "fire", "crash", "injury", "death", "fatal", "rollover", "brake", "steering",
  "airbag", "seatbelt", "seat belt", "fuel leak", "loss of control", "collision",
  "explosion", "burn", "electrocution", "entrapment"
];

function isSafetyCriticalRecall(recall: VehicleRecall): boolean {
  const textToCheck = [
    recall.consequence_summary || "",
    recall.defect_summary || "",
    recall.component_description || ""
  ].join(" ").toLowerCase();
  
  return SAFETY_CRITICAL_KEYWORDS.some(keyword => textToCheck.includes(keyword));
}

export async function getVehicleRecallsLocal(vin: string): Promise<{
  ok: boolean;
  vin: string;
  recalls: VehicleRecall[];
  count: number;
  safetyCriticalCount: number;
  error?: string;
  source: "local";
}> {
  try {
    const decoded = await decodeVinLocal(vin);
    
    if (!decoded.ok || !decoded.decoded) {
      return { ok: false, vin, recalls: [], count: 0, safetyCriticalCount: 0, error: "Cannot decode VIN", source: "local" };
    }
    
    const vehicleId = decoded.decoded.vehicle_id;
    
    const recalls = await sql<VehicleRecall[]>`
      SELECT DISTINCT r.nhtsa_recall_id, r.nhtsa_campaign_number, r.report_manufacturer,
             r.component_description, r.defect_summary, r.consequence_summary,
             r.corrective_action_summary, r.potential_units_affected,
             r.report_received_date, r.record_creation_date,
             r.regulation_part_number, r.fmvvs_number
      FROM dataone_def_nhtsa_recall r
      JOIN dataone_lkp_veh_nhtsa_recall vr ON r.nhtsa_recall_id = vr.nhtsa_recall_id
      WHERE vr.vehicle_id = ${vehicleId}
      ORDER BY r.record_creation_date DESC
    `;
    
    // Mark safety-critical recalls
    const recallsWithSeverity = recalls.map(r => ({
      ...r,
      isSafetyCritical: isSafetyCriticalRecall(r)
    }));
    
    // Sort: safety-critical first, then by date
    recallsWithSeverity.sort((a, b) => {
      if (a.isSafetyCritical && !b.isSafetyCritical) return -1;
      if (!a.isSafetyCritical && b.isSafetyCritical) return 1;
      return 0;
    });
    
    const safetyCriticalCount = recallsWithSeverity.filter(r => r.isSafetyCritical).length;
    
    return { 
      ok: true, 
      vin, 
      recalls: recallsWithSeverity, 
      count: recallsWithSeverity.length,
      safetyCriticalCount,
      source: "local" 
    };
  } catch (error) {
    console.error("DataOne recalls error:", error);
    return { ok: false, vin, recalls: [], count: 0, safetyCriticalCount: 0, error: String(error), source: "local" };
  }
}

export interface VehicleSpecification {
  specification_id: number;
  specification_category: string;
  specification_name: string;
  specification_value: string;
}

export interface VehicleSpecsGrouped {
  weightsAndCapacities: {
    fuelTankCapacity?: string;
    baseTowingCapacity?: string;
    maxTowingCapacity?: string;
    maxPayload?: string;
    curbWeight?: string;
    gvwr?: string;
    gcwr?: string;
    tonnage?: string;
  };
  wheelsAndTires: {
    frontTireDescription?: string;
    rearTireDescription?: string;
    frontWheelDiameter?: string;
    rearWheelDiameter?: string;
    frontWheelSize?: string;
    rearWheelSize?: string;
    tireType?: string;
  };
  brakes: {
    frontBrakeDiameter?: string;
    rearBrakeDiameter?: string;
  };
  dimensions: {
    length?: string;
    width?: string;
    height?: string;
    wheelbase?: string;
    groundClearance?: string;
    frontTrackWidth?: string;
    rearTrackWidth?: string;
  };
  truckSpecs: {
    bedLength?: string;
  };
  seating: {
    maxSeating?: string;
    standardSeating?: string;
  };
  interior: {
    cargoVolume?: string;
    passengerVolume?: string;
  };
}

export async function getVehicleSpecsLocal(vin: string): Promise<{
  ok: boolean;
  vin: string;
  specs: VehicleSpecification[];
  grouped: VehicleSpecsGrouped;
  error?: string;
  source: "local";
}> {
  const emptyGrouped: VehicleSpecsGrouped = {
    weightsAndCapacities: {},
    wheelsAndTires: {},
    brakes: {},
    dimensions: {},
    truckSpecs: {},
    seating: {},
    interior: {},
  };
  
  try {
    const decoded = await decodeVinLocal(vin);
    
    if (!decoded.ok || !decoded.decoded) {
      return { ok: false, vin, specs: [], grouped: emptyGrouped, error: "Cannot decode VIN", source: "local" };
    }
    
    const vehicleId = decoded.decoded.vehicle_id;
    
    const specs = await sql<VehicleSpecification[]>`
      SELECT DISTINCT s.specification_id, s.specification_category, 
             s.specification_name, s.specification_value
      FROM dataone_def_specification s
      JOIN dataone_lkp_veh_standard_specification vs ON s.specification_id = vs.specification_id
      WHERE vs.vehicle_id = ${vehicleId}
      ORDER BY s.specification_category, s.specification_name
    `;
    
    // Group specs into structured object
    const grouped: VehicleSpecsGrouped = {
      weightsAndCapacities: {},
      wheelsAndTires: {},
      brakes: {},
      dimensions: {},
      truckSpecs: {},
      seating: {},
      interior: {},
    };
    
    for (const spec of specs) {
      const name = spec.specification_name;
      const value = spec.specification_value;
      
      // Weights and Capacities
      if (name === "Fuel Tank Capacity") grouped.weightsAndCapacities.fuelTankCapacity = value;
      else if (name === "Base Towing Capacity") grouped.weightsAndCapacities.baseTowingCapacity = value;
      else if (name === "Max Towing Capacity") grouped.weightsAndCapacities.maxTowingCapacity = value;
      else if (name === "Max Payload") grouped.weightsAndCapacities.maxPayload = value;
      else if (name === "Curb Weight") grouped.weightsAndCapacities.curbWeight = value;
      else if (name === "Gross Vehicle Weight Rating") grouped.weightsAndCapacities.gvwr = value;
      else if (name === "Gross Combined Weight Rating") grouped.weightsAndCapacities.gcwr = value;
      else if (name === "Tonnage") grouped.weightsAndCapacities.tonnage = value;
      
      // Wheels and Tires
      else if (name === "Front Tire Description") grouped.wheelsAndTires.frontTireDescription = value;
      else if (name === "Rear Tire Description") grouped.wheelsAndTires.rearTireDescription = value;
      else if (name === "Front Wheel Diameter") grouped.wheelsAndTires.frontWheelDiameter = value;
      else if (name === "Rear Wheel Diameter") grouped.wheelsAndTires.rearWheelDiameter = value;
      else if (name === "Front Wheel Size") grouped.wheelsAndTires.frontWheelSize = value;
      else if (name === "Rear Wheel Size") grouped.wheelsAndTires.rearWheelSize = value;
      else if (name === "Tire Type") grouped.wheelsAndTires.tireType = value;
      
      // Brakes
      else if (name === "Front Brake Diameter") grouped.brakes.frontBrakeDiameter = value;
      else if (name === "Rear Brake Diameter") grouped.brakes.rearBrakeDiameter = value;
      
      // Dimensions
      else if (name === "Length") grouped.dimensions.length = value;
      else if (name === "Width") grouped.dimensions.width = value;
      else if (name === "Height") grouped.dimensions.height = value;
      else if (name === "Wheelbase") grouped.dimensions.wheelbase = value;
      else if (name === "Ground Clearance") grouped.dimensions.groundClearance = value;
      else if (name === "Front Track Width") grouped.dimensions.frontTrackWidth = value;
      else if (name === "Rear Track Width") grouped.dimensions.rearTrackWidth = value;
      
      // Truck Specs
      else if (name === "Bed Length") grouped.truckSpecs.bedLength = value;
      
      // Seating
      else if (name === "Max Seating") grouped.seating.maxSeating = value;
      else if (name === "Standard Seating") grouped.seating.standardSeating = value;
      
      // Interior
      else if (name === "Cargo Volume") grouped.interior.cargoVolume = value;
      else if (name === "Passenger Volume") grouped.interior.passengerVolume = value;
    }
    
    return { ok: true, vin, specs, grouped, source: "local" };
  } catch (error) {
    console.error("DataOne specs error:", error);
    return { ok: false, vin, specs: [], grouped: emptyGrouped, error: String(error), source: "local" };
  }
}

export async function checkDataOneLocalAvailable(): Promise<boolean> {
  try {
    const result = await sql`
      SELECT COUNT(*) as count FROM dataone_vin_reference LIMIT 1
    `;
    return result[0].count > 0;
  } catch {
    return false;
  }
}

export async function getDataOneSyncStatus(): Promise<{
  available: boolean;
  lastSync?: Date;
  rowCounts?: Record<string, number>;
}> {
  try {
    const metadata = await sql`
      SELECT * FROM dataone_sync_metadata 
      WHERE sync_status = 'success'
      ORDER BY last_sync_at DESC
      LIMIT 1
    `;
    
    if (metadata.length === 0) {
      return { available: false };
    }
    
    return {
      available: true,
      lastSync: metadata[0].last_sync_at,
      rowCounts: metadata[0].rows_imported,
    };
  } catch {
    return { available: false };
  }
}

export interface QuickSpecs {
  fuelTankCapacity?: string;
  maxTowingCapacity?: string;
  maxPayload?: string;
  frontTireDescription?: string;
  frontBrakeDiameter?: string;
  bedLength?: string;
}

export async function getBatchQuickSpecs(vins: string[]): Promise<Record<string, QuickSpecs>> {
  if (!vins.length) return {};
  
  const result: Record<string, QuickSpecs> = {};
  
  try {
    const squishPatterns = vins.map(vin => ({ vin, squish: toSquish(vin) }));
    const uniqueSquishes = [...new Set(squishPatterns.map(p => p.squish))];
    
    const vinRows = await sql<{ vin_pattern: string; vehicle_id: number }[]>`
      SELECT vin_pattern, vehicle_id 
      FROM dataone_vin_reference 
      WHERE vin_pattern = ANY(${uniqueSquishes})
    `;
    
    if (!vinRows.length) return result;
    
    const squishToVehicleId = new Map(vinRows.map(r => [r.vin_pattern, r.vehicle_id]));
    const vehicleIds = [...new Set(vinRows.map(r => r.vehicle_id))];
    
    const specs = await sql<{ vehicle_id: number; specification_name: string; specification_value: string }[]>`
      SELECT DISTINCT vs.vehicle_id, s.specification_name, s.specification_value
      FROM dataone_lkp_veh_standard_specification vs
      JOIN dataone_def_specification s ON vs.specification_id = s.specification_id
      WHERE vs.vehicle_id = ANY(${vehicleIds})
        AND s.specification_name IN (
          'Fuel Tank Capacity', 'Max Towing Capacity', 'Max Payload', 
          'Front Tire Description', 'Front Brake Rotor Diameter', 'Bed Length'
        )
    `;
    
    const vehicleSpecs = new Map<number, QuickSpecs>();
    for (const row of specs) {
      if (!vehicleSpecs.has(row.vehicle_id)) {
        vehicleSpecs.set(row.vehicle_id, {});
      }
      const qs = vehicleSpecs.get(row.vehicle_id)!;
      switch (row.specification_name) {
        case 'Fuel Tank Capacity': qs.fuelTankCapacity = row.specification_value; break;
        case 'Max Towing Capacity': qs.maxTowingCapacity = row.specification_value; break;
        case 'Max Payload': qs.maxPayload = row.specification_value; break;
        case 'Front Tire Description': qs.frontTireDescription = row.specification_value; break;
        case 'Front Brake Rotor Diameter': qs.frontBrakeDiameter = row.specification_value; break;
        case 'Bed Length': qs.bedLength = row.specification_value; break;
      }
    }
    
    for (const { vin, squish } of squishPatterns) {
      const vehicleId = squishToVehicleId.get(squish);
      if (vehicleId && vehicleSpecs.has(vehicleId)) {
        result[vin] = vehicleSpecs.get(vehicleId)!;
      }
    }
    
    return result;
  } catch (err) {
    console.error("getBatchQuickSpecs error:", err);
    return result;
  }
}
