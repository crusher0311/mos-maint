// Task #991 — Auto DVI: write the confirmed inspection to a Protractor work
// order as a single "Vehicle Inspection" ServicePackage with one $0 labor
// line per inspected item. Mirrors the add-to-RO route's WO resolution
// (GUID hint → RO# OData search → VIN fallback; open WOs do NOT return by
// number, so the GUID hint is authoritative when present) and its REST →
// SOAP fallback on the "Invalid column name 'Status'" Protractor bug.

import { randomUUID } from "crypto";
import {
  resolveProtractorConfig,
  protractorFetch,
  fetchWorkOrderById,
  buildMinimalPayloadForPost,
  soapAddServicePackage,
  updateInspectionResults,
} from "@/lib/integrations/protractor";

export interface ProtractorInspectionPushResult {
  ok: boolean;
  workOrderGuid?: string;
  error?: string;
  status?: number;
  requiresManualEntry?: boolean;
  /** Whether the native Protractor inspection-results write succeeded
   * (§1.9.4 InspectionResultUpdate). Best-effort — never fails the push. */
  inspectionResultsWritten?: boolean;
  inspectionResultsError?: string;
}

// Protractor inspection Result values must match the shop's configured
// Inspection Results (Shop Manager > Setup > Work Order Setup > Inspection
// Results) or the O/R/S grid shows nothing. Live-probed on shop 66:
// O = "OK", R = "Requires Future Attention", S = "Required".
const RESULT_BY_RATING: Record<string, string> = {
  green: "OK",
  yellow: "Requires Future Attention",
  red: "Required",
};

export interface InspectionResultItem {
  name: string;
  rating?: "green" | "yellow" | "red" | null;
  notes?: string | null;
  recommendation?: string | null;
  /** Plan-context note (buildVhiContextNote) prepended before tech notes. */
  context?: string | null;
}

export async function pushInspectionPackageToProtractor(opts: {
  shopId: number;
  vin?: string | null;
  roNumber?: string | null;
  workOrderGuid?: string | null;
  packageTitle: string;
  lineTitles: string[];
  note?: string | null;
  /** Priced recommended-work packages written alongside the inspection —
   * one ServicePackage per package so advisors can approve/decline each. */
  extraPackages?: Array<{ title: string; hours: number; rate: number }>;
  /** Per-item findings for the NATIVE inspection-results write (§1.9.4).
   * When present, results also land in Protractor's inspection view. */
  inspectionItems?: InspectionResultItem[];
}): Promise<ProtractorInspectionPushResult> {
  const { shopId } = opts;
  const config = await resolveProtractorConfig(shopId);
  if (!config.configured) {
    return { ok: false, status: 400, error: "Protractor is not configured for this shop" };
  }

  let workOrderGuid: string | null = null;
  const hint = (opts.workOrderGuid || "").trim();
  if (/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(hint)) {
    workOrderGuid = hint;
  }

  const sanitizedRoNumber = opts.roNumber ? String(opts.roNumber).replace(/[^a-zA-Z0-9\-_]/g, "") : "";
  if (!workOrderGuid && sanitizedRoNumber) {
    const searchResult = await protractorFetch<any>(
      `/WorkOrder?$filter=WorkOrderNumber eq '${sanitizedRoNumber}'&$top=5`,
      config,
      {},
      0,
      shopId,
      { priority: true },
    );
    if (searchResult.ok && searchResult.data) {
      const items = Array.isArray(searchResult.data)
        ? searchResult.data
        : searchResult.data?.Items || searchResult.data?.value || [];
      const openWo = items.find(
        (wo: any) =>
          !wo.Completed &&
          (String(wo.WorkOrderNumber) === sanitizedRoNumber || String(wo.Number) === sanitizedRoNumber),
      );
      if (openWo) workOrderGuid = openWo.ID || openWo.Guid;
    }
  }

  if (!workOrderGuid && opts.vin) {
    const { fetchVehicleByVin, fetchWorkOrdersForVehicle } = await import("@/lib/integrations/protractor");
    const vehicleResult = await fetchVehicleByVin(shopId, opts.vin);
    if (vehicleResult.ok && vehicleResult.vehicle) {
      const woResult = await fetchWorkOrdersForVehicle(shopId, vehicleResult.vehicle.ID, { includeOpen: true });
      if (woResult.ok) {
        const openWos = (woResult.workOrders || []).filter((wo: any) => !wo.Completed);
        if (openWos.length > 0) workOrderGuid = openWos[0].ID;
      }
    }
  }

  if (!workOrderGuid) {
    return {
      ok: false,
      status: 404,
      requiresManualEntry: true,
      error: sanitizedRoNumber
        ? `No open work order found for RO# ${sanitizedRoNumber}`
        : "No open work order found for this vehicle",
    };
  }

  const existingWOResult = await fetchWorkOrderById(shopId, workOrderGuid, { priority: true });
  if (!existingWOResult.ok || !existingWOResult.workOrder) {
    return { ok: false, status: 404, error: existingWOResult.error || "Work order not found" };
  }
  const existingWorkOrder = existingWOResult.workOrder;
  const workOrderStage = existingWorkOrder.WorkflowStage || (existingWorkOrder as any).workflowStage;
  const blockedStages = ["WorkCompleted", "Invoiced", "Void", "Closed"];
  if (blockedStages.includes(workOrderStage)) {
    return {
      ok: false,
      status: 400,
      error: `Cannot add to this work order — it is ${String(workOrderStage).replace(/([A-Z])/g, " $1").trim().toLowerCase()}`,
    };
  }

  const existingPackagesRaw = existingWorkOrder.ServicePackages as any;
  const existingPackages = Array.isArray(existingPackagesRaw)
    ? existingPackagesRaw
    : existingPackagesRaw?.ItemCollection || [];

  // Re-push idempotency: Protractor cannot delete service packages, so a
  // second push must REUSE the existing MOS Auto DVI package instead of
  // stacking a new one. Line titles are compared with rating tags stripped
  // (a rating change alone doesn't duplicate the evidence line — ratings
  // live in the native inspection write below).
  const normalizeLineTitle = (t: string) =>
    String(t || "").replace(/\s*\[(red|yellow)\]\s*$/i, "").trim().toLowerCase();
  const isMosDviPackage = (p: any) =>
    p?.Chapter !== "Inspection" &&
    (String(p?.Code || "").startsWith("MOS-DVI") ||
      (p?.ServicePackageHeader?.Title || p?.Title) === opts.packageTitle);
  const existingDviPackage = existingPackages.find(isMosDviPackage);

  const makeEvidenceLine = (title: string, rank: number) => ({
    ID: randomUUID(),
    Rank: rank,
    Type: "Labor",
    Description: title,
    Quantity: "0",
    RateCode: "1",
    TechnicianHour: "0",
    Price: "0.00",
    Total: "0.00",
    ExtendedTotal: "0.00",
    MinimumCharge: 0,
    Discount: 0,
    TotalCost: "0.00",
    Completed: false,
  });

  let updatedWorkOrder: Record<string, any>;
  let woPostNeeded = true;
  if (existingDviPackage) {
    // Reuse: append only lines not already present (normalized compare).
    updatedWorkOrder = buildMinimalPayloadForPost(existingWorkOrder as any, existingPackages, null as any);
    const collection: any[] = updatedWorkOrder.ServicePackages?.ItemCollection || [];
    updatedWorkOrder.ServicePackages.ItemCollection = collection.filter(Boolean);
    const target = updatedWorkOrder.ServicePackages.ItemCollection.find(isMosDviPackage);
    const targetLines: any[] = target?.ServicePackageLines?.ItemCollection || [];
    const have = new Set(
      targetLines.map((l: any) => normalizeLineTitle(l.Description || "")).filter(Boolean),
    );
    const missing = opts.lineTitles.filter((t) => !have.has(normalizeLineTitle(t)));
    if (target && missing.length > 0) {
      if (!target.ServicePackageLines) target.ServicePackageLines = { ItemCollection: [] };
      if (!Array.isArray(target.ServicePackageLines.ItemCollection)) target.ServicePackageLines.ItemCollection = [];
      missing.forEach((t, i) =>
        target.ServicePackageLines.ItemCollection.push(makeEvidenceLine(t, targetLines.length + 1 + i)),
      );
    } else if (missing.length === 0) {
      woPostNeeded = false; // nothing new to add on the package side
    }
  } else {
    const newServicePackage = {
      ID: randomUUID(),
      Chapter: "Service",
      Code: `MOS-DVI-${Date.now()}`,
      Rank: existingPackages.length + 1,
      ServicePackageHeader: {
        Title: opts.packageTitle,
        Description: `${opts.note ? `${opts.note} ` : ""}[Auto DVI — generated by MOS]`,
      },
      ServicePackageLines: {
        ItemCollection: opts.lineTitles.map((t, i) => makeEvidenceLine(t, i + 1)),
      },
    };
    updatedWorkOrder = buildMinimalPayloadForPost(existingWorkOrder as any, existingPackages, newServicePackage);
  }

  // Priced recommended-work packages (overdue / due-soon plan items the user
  // opted to add as real jobs). Appended into the same single WO POST.
  const extras = (opts.extraPackages || []).filter((p) => p.title && p.title.trim());
  if (extras.length > 0) {
    woPostNeeded = true;
    const collection: any[] = updatedWorkOrder.ServicePackages?.ItemCollection;
    if (Array.isArray(collection)) {
      extras.forEach((pkg, i) => {
        const hours = Number.isFinite(pkg.hours) && pkg.hours > 0 ? pkg.hours : 1;
        const rate = Number.isFinite(pkg.rate) && pkg.rate > 0 ? pkg.rate : 0;
        const total = (Math.round(hours * rate * 100) / 100).toFixed(2);
        collection.push({
          ID: randomUUID(),
          Chapter: "Service",
          Code: `MOS-REC-${Date.now()}-${i}`,
          Rank: existingPackages.length + 2 + i,
          ServicePackageHeader: {
            Title: pkg.title.trim(),
            Description: "[Recommended from vehicle maintenance plan — MOS Auto DVI]",
          },
          ServicePackageLines: {
            ItemCollection: [
              {
                ID: randomUUID(),
                Rank: 1,
                Type: "Labor",
                Description: pkg.title.trim(),
                Quantity: String(hours),
                RateCode: "1",
                TechnicianHour: String(hours),
                Price: rate.toFixed(2),
                Total: total,
                ExtendedTotal: total,
                MinimumCharge: 0,
                Discount: 0,
                TotalCost: "0.00",
                Completed: false,
              },
            ],
          },
        });
      });
    }
  }

  if (woPostNeeded) {
    const updateResult = await protractorFetch<any>(
      `/WorkOrder/${workOrderGuid}`,
      config,
      { method: "POST", body: JSON.stringify(updatedWorkOrder) },
      0,
      shopId,
      { priority: true },
    );

    if (!updateResult.ok) {
      const isStatusColumnError = (updateResult.error || "").includes("Invalid column name 'Status'");
      if (isStatusColumnError) {
        const soapResult = await soapAddServicePackage(shopId, workOrderGuid, updatedWorkOrder);
        if (!soapResult.ok) {
          return {
            ok: false,
            status: 500,
            error: "Failed to add inspection — Protractor database issue. Please contact Protractor support.",
          };
        }
      } else {
        return { ok: false, status: 500, error: updateResult.error || "Failed to add inspection to work order" };
      }
    }
  }

  // Native inspection-results write (best-effort): POST
  // /WorkOrder/{id}/Inspection with one Chapter:"Inspection" package whose
  // ServicePackageInspectionLines carry each item's Title/Result/Notes
  // (live-probed 2026-07-31: lines persist under ServicePackageInspectionLines,
  // item name goes in Title, and re-posting the same IDs updates in place).
  // Reuse the existing MOS inspection package + line IDs so re-pushes update
  // instead of duplicating. A failure here never fails the package push above.
  let inspectionResultsWritten = false;
  let inspectionResultsError: string | undefined;
  const inspectionItems = (opts.inspectionItems || []).filter((i) => i.name && i.name.trim());
  if (inspectionItems.length > 0) {
    try {
      const existingInspPkg = existingPackages.find(
        (p: any) =>
          p?.Chapter === "Inspection" &&
          (p?.ServicePackageHeader?.Title || p?.Title) === opts.packageTitle,
      );
      const existingInspLines: any[] =
        existingInspPkg?.ServicePackageInspectionLines?.ItemCollection || [];
      const lineIdByTitle = new Map<string, string>(
        existingInspLines
          .filter((l: any) => l?.ID && l?.Title)
          .map((l: any) => [String(l.Title).trim().toLowerCase(), String(l.ID)]),
      );
      const inspectionPackage = {
        ID: existingInspPkg?.ID || randomUUID(),
        Chapter: "Inspection",
        ServicePackageHeader: {
          Title: opts.packageTitle,
          Description: "[Auto DVI — generated by MOS]",
        },
        ServicePackageInspectionLines: {
          ItemCollection: inspectionItems.map((item, idx) => {
            const name = item.name.trim();
            const noteParts = [
              item.context?.trim() || "",
              item.notes?.trim() || "",
              item.recommendation?.trim() ? `Recommend: ${item.recommendation.trim()}` : "",
            ].filter(Boolean);
            return {
              ID: lineIdByTitle.get(name.toLowerCase()) || randomUUID(),
              Rank: idx + 1,
              // Native template lines use Type "Line"; without it the grid
              // renders a broken tri-state and reverts user clicks.
              Type: "Line",
              Title: name,
              Result: item.rating ? RESULT_BY_RATING[item.rating] || "" : "",
              Notes: noteParts.join(" — "),
            };
          }),
        },
      };
      // Prune stale MOS lines from previous pushes: posting a line with a
      // blank Title deletes it (live-verified). Only lines NOT in the current
      // selection are blanked, so shrinking the selection cleans up.
      const pushedTitles = new Set(inspectionItems.map((i) => i.name.trim().toLowerCase()));
      const staleLines = existingInspLines
        .filter((l: any) => l?.ID && !pushedTitles.has(String(l.Title || "").trim().toLowerCase()))
        .map((l: any, i: number) => ({
          ID: String(l.ID),
          Rank: inspectionItems.length + 1 + i,
          Type: "Line",
          Title: "",
          Result: "",
          Notes: "",
          Header: {
            ...(l.Header || {}),
            DeletionTime: new Date().toISOString(),
            DeletionTimeSpecified: true,
          },
        }));
      inspectionPackage.ServicePackageInspectionLines.ItemCollection.push(...(staleLines as any));
      const inspectionResult = await updateInspectionResults(shopId, workOrderGuid, {
        ItemCollection: [inspectionPackage],
      });
      inspectionResultsWritten = inspectionResult.ok;
      if (!inspectionResult.ok) inspectionResultsError = inspectionResult.error;
    } catch (err: any) {
      inspectionResultsError = err?.message || "inspection-results write threw";
      console.error("[AutoDVI push] InspectionResultUpdate failed (non-fatal):", inspectionResultsError);
    }
  }

  return { ok: true, workOrderGuid, inspectionResultsWritten, inspectionResultsError };
}
