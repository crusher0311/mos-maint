import type { Db } from "mongodb";
import { findDeferredWorkByShopAndVin } from "@/lib/data/repositories/protractor-deferred-work";
import { findDviResultByRo } from "@/lib/data/repositories/dvi";
import { findAutoVitalsVehicleByVinCaseInsensitive } from "@/lib/data/repositories/autovitals-vehicles";
import { findLatestAppointmentForVehicle } from "@/lib/data/repositories/autovitals-appointments";
import { findAutoVitalsInspection } from "@/lib/data/repositories/autovitals-inspections";

const PROTRACTOR_MAX_AGE_MS = 6 * 60 * 60 * 1000;
const DVI_MAX_AGE_MS = 3 * 24 * 60 * 60 * 1000;

function isFresh(value: unknown, maxAgeMs: number): boolean {
  const time = value ? new Date(value as any).getTime() : NaN;
  return Number.isFinite(time) && Date.now() - time <= maxAgeMs;
}

export type PreparedPartnerInputs = {
  protractor?: {
    vehicleResult: { ok: true; vehicle: any; source: "cache" };
    deferredWork?: any[];
  };
  autoVitals?: { ok: true; inspection: any; items: any[] };
  autoflow?: any;
};

/**
 * Reads only already-persisted provider snapshots. Every lookup is independent
 * and runs concurrently. A missing/stale entry is omitted so plan-build can
 * preserve its normal complete fetch path rather than silently dropping data.
 */
export async function loadPreparedPartnerInputs(input: {
  db: Db;
  shopId: number;
  vin: string;
  latestRoNumber: string | null;
  protractorConfigured: boolean;
  autoVitalsConfigured: boolean;
  autoflowConfigured: boolean;
}): Promise<PreparedPartnerInputs> {
  const vin = input.vin.toUpperCase();
  const [protractor, autoVitals, autoflow] = await Promise.all([
    input.protractorConfigured
      ? (async () => {
          const [vehicle, deferred] = await Promise.all([
            input.db.collection("protractor_vehicles").findOne({ shopId: input.shopId, vin }),
            findDeferredWorkByShopAndVin(input.shopId, vin),
          ]);
          if (!vehicle || !isFresh(vehicle.fetchedAt, PROTRACTOR_MAX_AGE_MS)) return undefined;
          return {
            vehicleResult: {
              ok: true as const,
              source: "cache" as const,
              vehicle: {
                ID: vehicle.protractorId,
                VIN: vehicle.vin,
                Year: vehicle.year,
                Make: vehicle.make,
                Model: vehicle.model,
                Color: vehicle.color,
                Engine: vehicle.engine,
                Transmission: vehicle.transmission,
                Odometer: vehicle.odometer,
                OdometerDate: vehicle.odometerDate,
                LicensePlate: vehicle.licensePlate,
                OwnerID: vehicle.ownerId,
              },
            },
            ...(deferred && isFresh(deferred.fetchedAt, PROTRACTOR_MAX_AGE_MS)
              ? { deferredWork: deferred.items || [] }
              : {}),
          };
        })()
      : Promise.resolve(undefined),
    input.autoVitalsConfigured
      ? (async () => {
          const vehicle = await findAutoVitalsVehicleByVinCaseInsensitive(vin, String(input.shopId));
          if (!vehicle?.vehicleId) return undefined;
          const appointment = await findLatestAppointmentForVehicle(String(input.shopId), vehicle.vehicleId);
          if (!appointment?.appointmentId) return undefined;
          const inspection = await findAutoVitalsInspection(appointment.appointmentId, String(input.shopId));
          if (!inspection || !isFresh(inspection.updatedAt, PROTRACTOR_MAX_AGE_MS) ||
              !Array.isArray(inspection.items) || inspection.items.length === 0) return undefined;
          return { ok: true as const, inspection, items: inspection.items };
        })()
      : Promise.resolve(undefined),
    input.autoflowConfigured && input.latestRoNumber
      ? (async () => {
          const doc = await findDviResultByRo(input.shopId, input.latestRoNumber!);
          if (!doc || !isFresh(doc.fetchedAt, DVI_MAX_AGE_MS)) return undefined;
          return {
            ok: !!doc.ok,
            invoice: doc.roNumber ?? null,
            vin: doc.vin ?? null,
            mileage: doc.mileage ?? null,
            advisor: doc.advisor ?? null,
            technician: doc.technician ?? null,
            categories: doc.categories ?? null,
            error: doc.error ?? null,
          };
        })()
      : Promise.resolve(undefined),
  ]);
  return { protractor, autoVitals, autoflow };
}