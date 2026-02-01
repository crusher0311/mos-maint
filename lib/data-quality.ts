import sql from "@/lib/db/postgres";

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
  type: 'orphaned_customer' | 'incomplete_vehicle' | 'stale_record' | 'duplicate_email' | 'invalid_vin' | 'missing_data';
  severity: 'low' | 'medium' | 'high' | 'critical';
  description: string;
  entityId: string;
  entityType: 'customer' | 'vehicle' | 'repair_order';
  shopId?: string;
  suggestedAction: string;
}

export async function runDataQualityCheck(shopId?: number | string): Promise<DataQualityReport> {
  const issues: DataQualityIssue[] = [];
  const recommendations: string[] = [];

  const shopIdStr = shopId ? String(shopId) : null;

  const orphanedCustomers = shopIdStr
    ? await sql`
        SELECT c.id, c.name, c.first_name, c.last_name, c.email, c.shop_id
        FROM customers c
        LEFT JOIN vehicles v ON v.customer_id = c.id
        WHERE c.shop_id = ${shopIdStr} AND v.id IS NULL
      `
    : await sql`
        SELECT c.id, c.name, c.first_name, c.last_name, c.email, c.shop_id
        FROM customers c
        LEFT JOIN vehicles v ON v.customer_id = c.id
        WHERE v.id IS NULL
      `;

  orphanedCustomers.forEach((customer: Record<string, unknown>) => {
    const displayName = customer.name || `${customer.first_name || ''} ${customer.last_name || ''}`.trim();
    issues.push({
      type: 'orphaned_customer',
      severity: 'medium',
      description: `Customer "${displayName}" has no vehicles`,
      entityId: String(customer.id),
      entityType: 'customer',
      shopId: customer.shop_id ? String(customer.shop_id) : undefined,
      suggestedAction: 'Add vehicle or archive customer'
    });
  });

  const incompleteVehicles = shopIdStr
    ? await sql`
        SELECT id, vin, year, make, model, shop_id FROM vehicles
        WHERE shop_id = ${shopIdStr} AND (vin IS NULL OR vin = '' OR year IS NULL OR make IS NULL OR model IS NULL)
      `
    : await sql`
        SELECT id, vin, year, make, model, shop_id FROM vehicles
        WHERE vin IS NULL OR vin = '' OR year IS NULL OR make IS NULL OR model IS NULL
      `;

  incompleteVehicles.forEach((vehicle: Record<string, unknown>) => {
    const missing = [];
    if (!vehicle.vin) missing.push("VIN");
    if (!vehicle.year) missing.push("year");
    if (!vehicle.make) missing.push("make");
    if (!vehicle.model) missing.push("model");

    issues.push({
      type: 'incomplete_vehicle',
      severity: missing.includes("VIN") ? 'high' : 'medium',
      description: `Vehicle missing: ${missing.join(", ")}`,
      entityId: String(vehicle.id),
      entityType: 'vehicle',
      shopId: vehicle.shop_id ? String(vehicle.shop_id) : undefined,
      suggestedAction: `Update vehicle with missing ${missing.join(", ")}`
    });
  });

  const invalidVins = shopIdStr
    ? await sql`
        SELECT id, vin, shop_id FROM vehicles
        WHERE shop_id = ${shopIdStr} AND vin IS NOT NULL AND vin != '' AND LENGTH(vin) != 17
      `
    : await sql`
        SELECT id, vin, shop_id FROM vehicles
        WHERE vin IS NOT NULL AND vin != '' AND LENGTH(vin) != 17
      `;

  invalidVins.forEach((vehicle: Record<string, unknown>) => {
    const vinStr = String(vehicle.vin || '');
    issues.push({
      type: 'invalid_vin',
      severity: 'high',
      description: `Invalid VIN length: "${vinStr}" (${vinStr.length} chars, should be 17)`,
      entityId: String(vehicle.id),
      entityType: 'vehicle',
      shopId: vehicle.shop_id ? String(vehicle.shop_id) : undefined,
      suggestedAction: 'Correct VIN or remove invalid VIN'
    });
  });

  const staleDate = new Date();
  staleDate.setDate(staleDate.getDate() - 90);

  const staleCustomers = shopIdStr
    ? await sql`
        SELECT id, updated_at, shop_id FROM customers
        WHERE shop_id = ${shopIdStr} AND updated_at < ${staleDate} AND (status IS NULL OR status != 'archived')
      `
    : await sql`
        SELECT id, updated_at, shop_id FROM customers
        WHERE updated_at < ${staleDate} AND (status IS NULL OR status != 'archived')
      `;

  staleCustomers.forEach((customer: Record<string, unknown>) => {
    const updatedAt = customer.updated_at as Date;
    issues.push({
      type: 'stale_record',
      severity: 'low',
      description: `No activity since ${updatedAt?.toDateString?.() || 'unknown'}`,
      entityId: String(customer.id),
      entityType: 'customer',
      shopId: customer.shop_id ? String(customer.shop_id) : undefined,
      suggestedAction: 'Review for archival or re-engagement'
    });
  });

  const duplicateEmails = shopIdStr
    ? await sql`
        SELECT email, shop_id, COUNT(*) as count, array_agg(id) as customer_ids
        FROM customers
        WHERE shop_id = ${shopIdStr} AND email IS NOT NULL AND email != ''
        GROUP BY email, shop_id
        HAVING COUNT(*) > 1
      `
    : await sql`
        SELECT email, shop_id, COUNT(*) as count, array_agg(id) as customer_ids
        FROM customers
        WHERE email IS NOT NULL AND email != ''
        GROUP BY email, shop_id
        HAVING COUNT(*) > 1
      `;

  duplicateEmails.forEach((group: Record<string, unknown>) => {
    const customerIds = group.customer_ids as string[];
    customerIds?.forEach(customerId => {
      issues.push({
        type: 'duplicate_email',
        severity: 'medium',
        description: `Duplicate email: ${group.email} (${group.count} records)`,
        entityId: String(customerId),
        entityType: 'customer',
        shopId: group.shop_id ? String(group.shop_id) : undefined,
        suggestedAction: 'Merge or archive duplicate customers'
      });
    });
  });

  const totalCustomersResult = shopIdStr
    ? await sql`SELECT COUNT(*) as count FROM customers WHERE shop_id = ${shopIdStr}`
    : await sql`SELECT COUNT(*) as count FROM customers`;
  const totalCustomers = Number(totalCustomersResult[0]?.count || 0);

  const activeCustomersResult = shopIdStr
    ? await sql`
        SELECT COUNT(*) as count FROM customers
        WHERE shop_id = ${shopIdStr} AND (status IS NULL OR status != 'archived') AND updated_at >= ${staleDate}
      `
    : await sql`
        SELECT COUNT(*) as count FROM customers
        WHERE (status IS NULL OR status != 'archived') AND updated_at >= ${staleDate}
      `;
  const activeCustomers = Number(activeCustomersResult[0]?.count || 0);

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

export async function autoCleanupData(shopId?: number | string, dryRun: boolean = true): Promise<{
  actions: string[];
  cleaned: number;
  errors: string[];
}> {
  const actions: string[] = [];
  const errors: string[] = [];
  let cleaned = 0;

  const shopIdStr = shopId ? String(shopId) : null;

  try {
    const archiveDate = new Date();
    archiveDate.setDate(archiveDate.getDate() - 180);

    const toArchive = shopIdStr
      ? await sql`
          SELECT c.id FROM customers c
          LEFT JOIN vehicles v ON v.customer_id = c.id
          WHERE c.shop_id = ${shopIdStr} AND (c.status IS NULL OR c.status != 'archived') AND c.updated_at < ${archiveDate}
          GROUP BY c.id
          HAVING COUNT(v.id) = 0
        `
      : await sql`
          SELECT c.id FROM customers c
          LEFT JOIN vehicles v ON v.customer_id = c.id
          WHERE (c.status IS NULL OR c.status != 'archived') AND c.updated_at < ${archiveDate}
          GROUP BY c.id
          HAVING COUNT(v.id) = 0
        `;

    const toArchiveIds = toArchive.map((c: Record<string, unknown>) => String(c.id));

    if (toArchiveIds.length > 0 && !dryRun) {
      for (const id of toArchiveIds) {
        await sql`
          UPDATE customers SET status = 'archived', archived_at = NOW(), archived_reason = 'Auto-archived: No vehicles, inactive 180+ days'
          WHERE id = ${id}::uuid
        `;
      }
      cleaned += toArchiveIds.length;
    }
    actions.push(`${dryRun ? 'Would archive' : 'Archived'} ${toArchiveIds.length} inactive customers`);

    if (!dryRun) {
      const vinResult = shopIdStr
        ? await sql`UPDATE vehicles SET vin = NULL WHERE shop_id = ${shopIdStr} AND vin = '' RETURNING id`
        : await sql`UPDATE vehicles SET vin = NULL WHERE vin = '' RETURNING id`;
      cleaned += vinResult.length;
      actions.push(`Cleaned ${vinResult.length} empty VIN fields`);
    } else {
      const emptyVins = shopIdStr
        ? await sql`SELECT COUNT(*) as count FROM vehicles WHERE shop_id = ${shopIdStr} AND vin = ''`
        : await sql`SELECT COUNT(*) as count FROM vehicles WHERE vin = ''`;
      actions.push(`Would clean ${emptyVins[0]?.count || 0} empty VIN fields`);
    }

  } catch (error) {
    errors.push(`Cleanup error: ${error instanceof Error ? error.message : String(error)}`);
  }

  return { actions, cleaned, errors };
}
