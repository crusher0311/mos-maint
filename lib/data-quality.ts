// lib/data-quality.ts
import { getDb } from "@/lib/mongo";

export interface DataQualityReport {
  timestamp: Date;
  summary: {
    totalCustomers: number;
    activeCustomers: number;
    orphanedCustomers: number;
    incompleteVehicles: number;
    staleRecords: number;
    duplicateEmails: number;
    invalidVins: number;
  };
  issues: DataQualityIssue[];
  recommendations: string[];
}

export interface DataQualityIssue {
  type: 'orphaned_customer' | 'incomplete_vehicle' | 'stale_record' | 'duplicate_email' | 'invalid_vin' | 'missing_data' | 'mileage_discrepancy';
  severity: 'low' | 'medium' | 'high' | 'critical';
  description: string;
  entityId: string;
  entityType: 'customer' | 'vehicle' | 'repair_order';
  shopId?: number;
  suggestedAction: string;
  /**
   * Task #391: structured payload for `mileage_discrepancy` issues so the
   * admin UI can render specifics (current vs prior, source, date) and
   * link out to the vehicle detail page.
   */
  details?: {
    vin?: string;
    currentMiles?: number;
    priorMiles?: number;
    priorSource?: string;
    priorDate?: string | null;
    gapMiles?: number;
  };
}

export async function runDataQualityCheck(shopId?: number): Promise<DataQualityReport> {
  const db = await getDb();
  const issues: DataQualityIssue[] = [];
  const recommendations: string[] = [];

  // Build shop filter
  const shopFilter = shopId ? { shopId } : {};

  // 1. Find orphaned customers (customers without vehicles)
  const orphanedCustomers = await db.collection("customers").aggregate([
    { $match: shopFilter },
    {
      $lookup: {
        from: "vehicles",
        localField: "_id",
        foreignField: "customerId",
        as: "vehicles"
      }
    },
    {
      $match: {
        $or: [
          { vehicles: { $size: 0 } },
          { vehicles: { $exists: false } }
        ]
      }
    },
    { $project: { _id: 1, name: 1, firstName: 1, lastName: 1, email: 1, shopId: 1 } }
  ]).toArray();

  orphanedCustomers.forEach(customer => {
    issues.push({
      type: 'orphaned_customer',
      severity: 'medium',
      description: `Customer "${customer.name || customer.firstName + ' ' + customer.lastName}" has no vehicles`,
      entityId: customer._id.toString(),
      entityType: 'customer',
      shopId: customer.shopId,
      suggestedAction: 'Add vehicle or archive customer'
    });
  });

  // 2. Find incomplete vehicles (missing VIN, year, make, model)
  const incompleteVehicles = await db.collection("vehicles").find({
    ...shopFilter,
    $or: [
      { vin: { $exists: false } },
      { vin: null },
      { vin: "" },
      { year: { $exists: false } },
      { make: { $exists: false } },
      { model: { $exists: false } }
    ]
  }).toArray();

  incompleteVehicles.forEach(vehicle => {
    const missing = [];
    if (!vehicle.vin) missing.push("VIN");
    if (!vehicle.year) missing.push("year");
    if (!vehicle.make) missing.push("make");
    if (!vehicle.model) missing.push("model");

    issues.push({
      type: 'incomplete_vehicle',
      severity: missing.includes("VIN") ? 'high' : 'medium',
      description: `Vehicle missing: ${missing.join(", ")}`,
      entityId: vehicle._id.toString(),
      entityType: 'vehicle',
      shopId: vehicle.shopId,
      suggestedAction: `Update vehicle with missing ${missing.join(", ")}`
    });
  });

  // 3. Find invalid VINs (not 17 characters)
  const invalidVins = await db.collection("vehicles").find({
    ...shopFilter,
    vin: { $exists: true, $ne: null, $ne: "" },
    $expr: { $ne: [{ $strLenCP: "$vin" }, 17] }
  }).toArray();

  invalidVins.forEach(vehicle => {
    issues.push({
      type: 'invalid_vin',
      severity: 'high',
      description: `Invalid VIN length: "${vehicle.vin}" (${vehicle.vin?.length || 0} chars, should be 17)`,
      entityId: vehicle._id.toString(),
      entityType: 'vehicle',
      shopId: vehicle.shopId,
      suggestedAction: 'Correct VIN or remove invalid VIN'
    });
  });

  // 4. Find stale records (no activity in 90+ days)
  const staleDate = new Date();
  staleDate.setDate(staleDate.getDate() - 90);

  const staleCustomers = await db.collection("customers").find({
    ...shopFilter,
    updatedAt: { $lt: staleDate },
    status: { $ne: "archived" }
  }).toArray();

  staleCustomers.forEach(customer => {
    issues.push({
      type: 'stale_record',
      severity: 'low',
      description: `No activity since ${customer.updatedAt?.toDateString()}`,
      entityId: customer._id.toString(),
      entityType: 'customer',
      shopId: customer.shopId,
      suggestedAction: 'Review for archival or re-engagement'
    });
  });

  // 5. Find duplicate emails
  const duplicateEmails = await db.collection("customers").aggregate([
    { $match: { ...shopFilter, email: { $exists: true, $ne: null, $ne: "" } } },
    {
      $group: {
        _id: { email: "$email", shopId: "$shopId" },
        count: { $sum: 1 },
        customers: { $push: { _id: "$_id", name: "$name" } }
      }
    },
    { $match: { count: { $gt: 1 } } }
  ]).toArray();

  duplicateEmails.forEach(group => {
    group.customers.forEach((customer: any) => {
      issues.push({
        type: 'duplicate_email',
        severity: 'medium',
        description: `Duplicate email: ${group._id.email} (${group.count} records)`,
        entityId: customer._id.toString(),
        entityType: 'customer',
        shopId: group._id.shopId,
        suggestedAction: 'Merge or archive duplicate customers'
      });
    });
  });

  // 6. Mileage rollback discrepancies (Task #391). Cached plans persist
  // the worst (largest gap) prior reading on `plan.mileageDiscrepancy`
  // when the current odometer is lower than a prior shop/CARFAX entry
  // by more than the tolerance.
  let mileageDiscrepancyCount = 0;
  try {
    const planFilter: any = { "plan.mileageDiscrepancy": { $ne: null, $exists: true } };
    if (shopId) {
      planFilter.shopId = { $in: [String(shopId), Number(shopId)] };
    }
    const flagged = await db.collection("cached_plans").find(planFilter, {
      projection: { vin: 1, shopId: 1, "plan.mileageDiscrepancy": 1, "plan.vehicle": 1 },
    }).toArray();
    mileageDiscrepancyCount = flagged.length;
    for (const entry of flagged) {
      const d = (entry as any).plan?.mileageDiscrepancy;
      if (!d) continue;
      const v = (entry as any).plan?.vehicle || {};
      const vehicleLabel = [v.year, v.make, v.model].filter(Boolean).join(" ") || (entry as any).vin;
      const dateStr = d.priorDate ? new Date(d.priorDate).toLocaleDateString("en-US") : "unknown date";
      issues.push({
        type: 'mileage_discrepancy',
        severity: 'medium',
        description:
          `${vehicleLabel} (${(entry as any).vin}): current odometer ` +
          `${Number(d.currentMiles).toLocaleString()} is below prior reading ` +
          `${Number(d.priorMiles).toLocaleString()} from ${d.priorSource} on ${dateStr}.`,
        entityId: (entry as any).vin,
        entityType: 'vehicle',
        shopId: typeof (entry as any).shopId === "number" ? (entry as any).shopId : Number((entry as any).shopId),
        suggestedAction: 'Verify the current odometer against the source record; an odometer rollback or data-entry error may be present.',
        details: {
          vin: (entry as any).vin,
          currentMiles: d.currentMiles,
          priorMiles: d.priorMiles,
          priorSource: d.priorSource,
          priorDate: d.priorDate,
          gapMiles: d.gapMiles,
        },
      });
    }
  } catch (err) {
    console.warn("[DataQuality] mileage discrepancy scan failed:", err);
  }

  // Generate summary
  const totalCustomers = await db.collection("customers").countDocuments(shopFilter);
  const activeCustomers = await db.collection("customers").countDocuments({
    ...shopFilter,
    status: { $ne: "archived" },
    updatedAt: { $gte: staleDate }
  });

  // Generate recommendations
  if (orphanedCustomers.length > 0) {
    recommendations.push(`${orphanedCustomers.length} customers need vehicles added or should be archived`);
  }
  if (incompleteVehicles.length > 0) {
    recommendations.push(`${incompleteVehicles.length} vehicles need complete information (VIN, year, make, model)`);
  }
  if (invalidVins.length > 0) {
    recommendations.push(`${invalidVins.length} vehicles have invalid VINs that need correction`);
  }
  if (staleCustomers.length > 0) {
    recommendations.push(`${staleCustomers.length} customers haven't been updated in 90+ days - consider archiving`);
  }
  if (duplicateEmails.length > 0) {
    recommendations.push(`${duplicateEmails.length} email duplicates found - merge or clean up records`);
  }
  if (mileageDiscrepancyCount > 0) {
    recommendations.push(`${mileageDiscrepancyCount} vehicle(s) have a mileage rollback warning — verify the current odometer against shop / CARFAX history`);
  }

  return {
    timestamp: new Date(),
    summary: {
      totalCustomers,
      activeCustomers,
      orphanedCustomers: orphanedCustomers.length,
      incompleteVehicles: incompleteVehicles.length,
      staleRecords: staleCustomers.length,
      duplicateEmails: duplicateEmails.length,
      invalidVins: invalidVins.length
    },
    issues,
    recommendations
  };
}

export async function autoCleanupData(shopId?: number, dryRun: boolean = true): Promise<{
  actions: string[];
  cleaned: number;
  errors: string[];
}> {
  const db = await getDb();
  const actions: string[] = [];
  const errors: string[] = [];
  let cleaned = 0;

  const shopFilter = shopId ? { shopId } : {};

  try {
    // 1. Archive customers with no vehicles and no activity in 180+ days
    const archiveDate = new Date();
    archiveDate.setDate(archiveDate.getDate() - 180);

    const toArchive = await db.collection("customers").find({
      ...shopFilter,
      status: { $ne: "archived" },
      updatedAt: { $lt: archiveDate }
    }).toArray();

    const toArchiveIds = [];
    for (const customer of toArchive) {
      const vehicleCount = await db.collection("vehicles").countDocuments({
        customerId: customer._id
      });
      if (vehicleCount === 0) {
        toArchiveIds.push(customer._id);
      }
    }

    if (toArchiveIds.length > 0 && !dryRun) {
      await db.collection("customers").updateMany(
        { _id: { $in: toArchiveIds } },
        { 
          $set: { 
            status: "archived", 
            archivedAt: new Date(),
            archivedReason: "Auto-archived: No vehicles, inactive 180+ days"
          } 
        }
      );
      cleaned += toArchiveIds.length;
    }
    actions.push(`${dryRun ? 'Would archive' : 'Archived'} ${toArchiveIds.length} inactive customers`);

    // 2. Clean up empty VIN fields (set to null instead of empty string)
    if (!dryRun) {
      const vinResult = await db.collection("vehicles").updateMany(
        { ...shopFilter, vin: "" },
        { $set: { vin: null } }
      );
      cleaned += vinResult.modifiedCount;
      actions.push(`Cleaned ${vinResult.modifiedCount} empty VIN fields`);
    } else {
      const emptyVins = await db.collection("vehicles").countDocuments({
        ...shopFilter, 
        vin: ""
      });
      actions.push(`Would clean ${emptyVins} empty VIN fields`);
    }

  } catch (error) {
    errors.push(`Cleanup error: ${error}`);
  }

  return { actions, cleaned, errors };
}