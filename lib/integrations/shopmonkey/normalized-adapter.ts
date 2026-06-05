import {
  INormalizedAdapter,
  SourceSystem,
  NormalizedVehicle,
  NormalizedCustomer,
  NormalizedWorkOrder,
  NormalizedServiceJob,
  NormalizedLineItem,
  NormalizedInspection,
  NormalizedRecommendation,
  NormalizedPayment,
  SourceId,
  VehicleSnapshot,
  CustomerSnapshot,
  WorkOrderStatus,
  ServiceJobStatus,
  LineItemType,
  PaymentMethod,
  PaymentStatus,
  DistanceUnit,
  InspectionStatus,
  InspectionFinding,
  RecommendationStatus,
  parseDate,
  parseNumber,
  cleanString,
} from "@/lib/integrations/core/normalized-adapter";

// =============================================================================
// SHOPMONKEY ADAPTER
// =============================================================================
//
// Mirrors the Tekmetric normalized adapter. Shopmonkey returns monetary amounts
// in CENTS on labor/part line items (`rateCents`, `costCents`, `retailCents`,
// `totalCents`); those are normalized to dollars in
// `extractLineItemsFromServiceJob` so the generic `mapLineItem` stays unit-agnostic.

export class ShopmonkeyAdapter implements INormalizedAdapter {
  sourceSystem: SourceSystem = "shopmonkey";

  getSourceIds(sourceData: any): SourceId[] {
    const ids: SourceId[] = [];

    if (sourceData.id) {
      ids.push({
        system: "shopmonkey",
        idType: "repair_order_id",
        idValue: String(sourceData.id),
        isPrimary: true,
      });
    }

    const number = sourceData.number ?? sourceData.invoiceNumber;
    if (number) {
      ids.push({
        system: "shopmonkey",
        idType: "repair_order_number",
        idValue: String(number),
        isPrimary: false,
      });
    }

    return ids;
  }

  mapVehicle(shopId: number, sourceData: any, enterpriseId?: string): Partial<NormalizedVehicle> {
    const v = sourceData.vehicle || sourceData;

    return {
      enterpriseId,
      shopId,
      vin: cleanString(v.vin),
      vinDecoded: false,
      year: parseNumber(v.year),
      make: cleanString(v.make),
      model: cleanString(v.model),
      submodel: cleanString(v.submodel || v.subModel),
      trim: cleanString(v.trim),
      engineDescription: cleanString(v.engine || v.engineDescription),
      licensePlate: cleanString(v.licensePlate),
      licensePlateState: cleanString(v.licensePlateState),
      exteriorColor: cleanString(v.color),
      odometerUnit: "miles" as DistanceUnit,
      odometerHistory: [],
      isFleet: Boolean(v.fleet),
      fleetUnitNumber: cleanString(v.unitNumber),
      notes: cleanString(v.notes),
      tags: [],
      customFields: {},
      customerIds: [],
      totalServicesCount: 0,
      totalServicesAmount: 0,
    };
  }

  mapCustomer(shopId: number, sourceData: any, enterpriseId?: string): Partial<NormalizedCustomer> {
    const c = sourceData.customer || sourceData;

    const firstName = cleanString(c.firstName);
    const lastName = cleanString(c.lastName);

    return {
      enterpriseId,
      shopId,
      customerType: c.companyName ? "business" : "individual",
      firstName,
      lastName,
      fullName: [firstName, lastName].filter(Boolean).join(" ") || cleanString(c.companyName),
      companyName: cleanString(c.companyName),
      contacts: [],
      taxExempt: Boolean(c.taxExempt),
      arBalance: parseNumber(c.balance) || 0,
      marketingConsent: Boolean(c.marketingOptIn),
      smsConsent: Boolean(c.smsOptIn),
      emailConsent: Boolean(c.emailOptIn),
      tags: [],
      customFields: {},
      vehicleIds: [],
      totalVisits: 0,
      totalSpent: 0,
      averageTicket: 0,
    };
  }

  mapWorkOrder(shopId: number, sourceData: any, enterpriseId?: string): Partial<NormalizedWorkOrder> {
    const ro = sourceData;
    const vehicle = this.extractVehicleFromWorkOrder(ro);
    const customer = this.extractCustomerFromWorkOrder(ro);

    const status = this.mapShopmonkeyStatus(ro.status);
    const centsToDollars = (c: any): number => (parseNumber(c) ?? 0) / 100;

    return {
      enterpriseId,
      shopId,
      workOrderNumber: String(ro.number ?? ro.invoiceNumber ?? ro.id),
      workOrderType: "repair",
      status,
      statusHistory: [],
      vehicleId: "",
      vehicle: vehicle as VehicleSnapshot,
      customerId: undefined,
      customer: customer as CustomerSnapshot,
      odometerIn: parseNumber(ro.mileageIn ?? ro.mileage),
      odometerOut: parseNumber(ro.mileageOut),
      odometerUnit: "miles",
      promisedDate: parseDate(ro.promisedDate),
      checkInDate: parseDate(ro.createdDate),
      completedDate: parseDate(ro.completedDate),
      closedDate: parseDate(ro.postedDate ?? ro.closedDate),
      serviceAdvisorName: cleanString(ro.serviceWriterName),
      technicians: [],
      customerConcern: cleanString(ro.customerConcern),
      technicianNotes: cleanString(ro.technicianNotes),
      internalNotes: cleanString(ro.notes),
      serviceJobs: [],
      inspections: [],
      recommendations: [],
      subtotal: centsToDollars(ro.laborTotalCents) + centsToDollars(ro.partsTotalCents) + centsToDollars(ro.subletTotalCents),
      taxTotal: centsToDollars(ro.taxTotalCents),
      discountTotal: centsToDollars(ro.discountTotalCents),
      grandTotal: centsToDollars(ro.totalCents),
      laborTotal: centsToDollars(ro.laborTotalCents),
      partsTotal: centsToDollars(ro.partsTotalCents),
      subletTotal: centsToDollars(ro.subletTotalCents),
      feesTotal: centsToDollars(ro.feesTotalCents),
      laborHoursTotal: parseNumber(ro.totalLaborHours) || 0,
      laborHoursBilled: parseNumber(ro.billedLaborHours) || 0,
      payments: [],
      balanceDue: centsToDollars(ro.balanceDueCents),
      isWarranty: Boolean(ro.warranty),
      isInternal: Boolean(ro.internal),
      isComeback: Boolean(ro.comeback),
      tags: [],
      customFields: {},
    };
  }

  mapServiceJob(shopId: number, workOrderId: string, sourceData: any): Partial<NormalizedServiceJob> {
    const job = sourceData;
    const centsToDollars = (c: any): number => (parseNumber(c) ?? 0) / 100;

    return {
      shopId,
      workOrderId,
      jobNumber: cleanString(job.id),
      sequence: parseNumber(job.sortOrder) || 0,
      jobType: job.cannedServiceId ? "canned" : "custom",
      status: this.mapServiceJobStatus(job.authorized ?? job.declined),
      statusHistory: [],
      title: cleanString(job.name || job.title || job.description) || "Unknown Service",
      description: cleanString(job.description || job.note),
      cannedJobId: cleanString(job.cannedServiceId),
      cannedJobCode: cleanString(job.cannedServiceCode),
      cannedJobName: cleanString(job.cannedServiceName),
      laborOperationCodes: [],
      technicianName: cleanString(job.technicianName),
      lineItems: [],
      laborTotal: centsToDollars(job.laborCents),
      partsTotal: centsToDollars(job.partsCents),
      subletTotal: centsToDollars(job.subletCents),
      feesTotal: 0,
      discountTotal: centsToDollars(job.discountCents),
      total: centsToDollars(job.totalCents),
      laborHoursEstimated: parseNumber(job.estimatedHours),
      laborHoursActual: parseNumber(job.actualHours),
      laborHoursBilled: parseNumber(job.billedHours),
      isWarranty: Boolean(job.warranty),
      isSublet: Boolean(job.sublet),
      technicianNotes: cleanString(job.techNote),
      advisorNotes: cleanString(job.advisorNote),
      authorizedAt: job.authorized === true ? parseDate(job.authorizedDate) : undefined,
      declinedAt: job.authorized === false || job.declined === true ? parseDate(job.declinedDate) : undefined,
      declineReason: cleanString(job.declineReason),
      componentsCodes: [],
      tags: [],
      customFields: {},
    };
  }

  mapLineItem(shopId: number, workOrderId: string, serviceJobId: string, sourceData: any): Partial<NormalizedLineItem> {
    const li = sourceData;
    const lineType = this.mapLineItemType(li);

    return {
      shopId,
      workOrderId,
      serviceJobId,
      lineNumber: parseNumber(li.sortOrder) || 0,
      lineType,
      partNumber: cleanString(li.partNumber),
      partDescription: cleanString(li.description || li.name) || "Unknown Item",
      partBrand: cleanString(li.brand),
      partManufacturer: cleanString(li.manufacturer),
      quantity: parseNumber(li.quantity) || 1,
      quantityUnit: "each",
      unitCost: parseNumber(li.cost) || 0,
      unitPrice: parseNumber(li.price) || 0,
      extendedPrice: parseNumber(li.total) || 0,
      discountPercent: parseNumber(li.discountPercent),
      discountAmount: parseNumber(li.discountAmount),
      taxable: li.taxable !== false,
      laborType: lineType === "labor" ? "flat_rate" : undefined,
      laborHours: lineType === "labor" ? parseNumber(li.hours || li.quantity) : undefined,
      laborRate: lineType === "labor" ? parseNumber(li.rate || li.price) : undefined,
      technicianName: cleanString(li.technicianName),
      vendorName: cleanString(li.vendorName),
      coreCharge: parseNumber(li.coreCharge),
      coreReturned: Boolean(li.coreReturned),
      notes: cleanString(li.note),
      customFields: {},
    };
  }

  extractVehicleFromWorkOrder(sourceData: any): Partial<NormalizedVehicle> | null {
    const v = sourceData.vehicle;
    if (!v) return null;

    return {
      vin: cleanString(v.vin),
      year: parseNumber(v.year),
      make: cleanString(v.make),
      model: cleanString(v.model),
      submodel: cleanString(v.submodel || v.subModel),
      engineDescription: cleanString(v.engine || v.engineDescription),
      licensePlate: cleanString(v.licensePlate),
    };
  }

  extractCustomerFromWorkOrder(sourceData: any): Partial<NormalizedCustomer> | null {
    const c = sourceData.customer;
    if (!c) return null;

    const firstName = cleanString(c.firstName);
    const lastName = cleanString(c.lastName);

    return {
      firstName,
      lastName,
      fullName: [firstName, lastName].filter(Boolean).join(" "),
      companyName: cleanString(c.companyName),
    };
  }

  extractServiceJobsFromWorkOrder(sourceData: any): Partial<NormalizedServiceJob>[] {
    const jobs = sourceData.services || [];

    if (!Array.isArray(jobs)) return [];

    return jobs.map((job: any, index: number) => ({
      sequence: index,
      title: cleanString(job.name || job.title || job.description) || "Unknown Service",
      description: cleanString(job.description),
      laborHoursBilled: parseNumber(job.billedHours) || parseNumber(job.hours),
      total: job.totalCents != null ? job.totalCents / 100 : undefined,
      laborTotal: job.laborCents != null ? job.laborCents / 100 : undefined,
      partsTotal: job.partsCents != null ? job.partsCents / 100 : undefined,
    }));
  }

  extractRawServiceJobsFromWorkOrder(sourceData: any): any[] {
    const jobs = sourceData.services || [];
    return Array.isArray(jobs) ? jobs : [];
  }

  /**
   * Shopmonkey exposes labor and parts as separate per-service arrays with
   * money amounts in CENTS. We collapse them into a single line-items list and
   * normalize cents → dollars here so `mapLineItem` stays generic. Each item
   * carries a `_sourceId` of the form `labor-<id>` / `part-<id>` to keep the
   * labor and parts ID namespaces explicitly separated for `ingestLineItem`'s
   * dedupe key.
   */
  extractLineItemsFromServiceJob(job: any): any[] {
    const out: any[] = [];
    const labor = Array.isArray(job?.labors) ? job.labors : [];
    for (let idx = 0; idx < labor.length; idx++) {
      const l = labor[idx] || {};
      const hours = parseNumber(l.hours) || 0;
      const rateDollars = (parseNumber(l.rateCents) || 0) / 100;
      const totalDollars = l.totalCents != null ? l.totalCents / 100 : hours * rateDollars;
      out.push({
        _sourceId: `labor-${l.id ?? idx}`,
        id: l.id,
        type: "labor",
        sortOrder: idx,
        name: l.name || job.name,
        description: l.description || l.name || job.name,
        quantity: 1,
        hours,
        rate: rateDollars,
        price: rateDollars,
        cost: 0,
        total: totalDollars,
      });
    }
    const parts = Array.isArray(job?.parts) ? job.parts : [];
    for (let idx = 0; idx < parts.length; idx++) {
      const p = parts[idx] || {};
      const qty = parseNumber(p.quantity) || 1;
      const retailDollars = (parseNumber(p.retailCents) || 0) / 100;
      const costDollars = (parseNumber(p.costCents) || 0) / 100;
      const totalDollars = p.totalCents != null ? p.totalCents / 100 : qty * retailDollars;
      out.push({
        _sourceId: `part-${p.id ?? idx}`,
        id: p.id,
        type: "part",
        sortOrder: labor.length + idx,
        name: p.name || p.description || "",
        description: p.description || p.name || "",
        partNumber: p.partNumber,
        brand: p.brand,
        manufacturer: p.manufacturer || p.brand,
        quantity: qty,
        price: retailDollars,
        cost: costDollars,
        total: totalDollars,
      });
    }
    return out;
  }

  extractPaymentsFromWorkOrder(sourceData: any): any[] {
    const payments = sourceData.payments || [];
    return Array.isArray(payments) ? payments : [];
  }

  extractInspectionsFromWorkOrder(sourceData: any): any[] {
    const inspections = sourceData.inspections || [];
    return Array.isArray(inspections) ? inspections : [];
  }

  extractRecommendationsFromWorkOrder(sourceData: any): any[] {
    const jobs = sourceData.services || [];
    const recommendations: any[] = [];

    if (Array.isArray(jobs)) {
      for (const job of jobs) {
        if ((job.authorized === false || job.declined === true) && (job.name || job.title)) {
          recommendations.push({ ...job, status: "declined" });
        }
      }
    }

    return recommendations;
  }

  mapPayment(shopId: number, workOrderId: string, sourceData: any): Partial<NormalizedPayment> {
    const p = sourceData;
    return {
      shopId,
      workOrderId,
      paymentNumber: cleanString(p.id),
      status: this.mapPaymentStatus(p.status),
      method: this.mapPaymentMethod(p.method || p.type),
      amount: (parseNumber(p.amountCents) ?? 0) / 100,
      tipAmount: p.tipCents != null ? p.tipCents / 100 : undefined,
      processedAt: parseDate(p.paymentDate || p.createdDate),
      cardBrand: cleanString(p.cardBrand),
      cardLast4: cleanString(p.cardLast4),
      checkNumber: cleanString(p.checkNumber),
      authorizationCode: cleanString(p.authorizationCode),
      transactionId: cleanString(p.transactionId),
      notes: cleanString(p.notes),
      customFields: {},
    };
  }

  mapInspection(shopId: number, workOrderId: string, vehicleId: string, sourceData: any): Partial<NormalizedInspection> {
    const i = sourceData;

    const items = Array.isArray(i.items) ? i.items : [];
    const sections = items.map((item: any) => ({
      name: cleanString(item.name || item.categoryName),
      finding: this.mapInspectionItemStatus(item.status),
      notes: cleanString(item.notes),
      mediaUrls: Array.isArray(item.mediaUrls) ? item.mediaUrls : [],
    }));

    const hasRed = items.some((item: any) => item.status === "bad" || item.status === "red");
    const hasYellow = items.some((item: any) => item.status === "marginal" || item.status === "yellow");
    const overallCondition = hasRed
      ? ("immediate_attention" as InspectionFinding)
      : hasYellow
        ? ("caution" as InspectionFinding)
        : this.mapInspectionFinding(i.overallCondition);

    return {
      shopId,
      workOrderId,
      vehicleId,
      inspectionType: "multi_point",
      templateName: cleanString(i.templateName || i.name),
      status: this.mapInspectionStatus(i.status),
      technicianName: cleanString(i.technicianName),
      startedAt: parseDate(i.createdDate || i.startedAt),
      completedAt: parseDate(i.completedDate || i.updatedDate || i.completedAt),
      overallCondition,
      summary: cleanString(i.summary),
      sections,
      mediaItems: [],
      recommendations: [],
      customFields: {
        ...(i.templateId ? { templateId: i.templateId } : {}),
        itemCount: items.length,
      },
    };
  }

  mapRecommendation(shopId: number, vehicleId: string, sourceData: any): Partial<NormalizedRecommendation> {
    const r = sourceData;
    return {
      shopId,
      vehicleId,
      status: this.mapRecommendationStatus(r.status || (r.authorized === false ? "declined" : "recommended")),
      statusHistory: [],
      title: cleanString(r.name || r.title || r.description) || "Unknown Recommendation",
      description: cleanString(r.description || r.note),
      urgency: this.mapUrgency(r.urgency),
      priority: parseNumber(r.priority) || 3,
      estimatedCost: r.totalCents != null ? r.totalCents / 100 : parseNumber(r.estimatedCost),
      estimatedHours: parseNumber(r.estimatedHours || r.billedHours),
      dateDeclined: parseDate(r.declinedDate),
      declineReason: cleanString(r.declineReason),
      followUpSent: false,
      mediaIds: [],
      notes: cleanString(r.note),
      customFields: {},
    };
  }

  private mapInspectionItemStatus(status: string): InspectionFinding {
    const statusMap: Record<string, InspectionFinding> = {
      good: "pass",
      green: "pass",
      bad: "immediate_attention",
      red: "immediate_attention",
      marginal: "caution",
      yellow: "caution",
      not_inspected: "not_inspected",
    };
    return statusMap[String(status).toLowerCase()] || "not_inspected";
  }

  private mapPaymentStatus(status: string): PaymentStatus {
    const statusMap: Record<string, PaymentStatus> = {
      paid: "paid",
      pending: "pending",
      authorized: "authorized",
      refunded: "refunded",
      voided: "voided",
      failed: "failed",
    };
    return statusMap[String(status).toLowerCase()] || "paid";
  }

  private mapPaymentMethod(method: string): PaymentMethod {
    const methodMap: Record<string, PaymentMethod> = {
      cash: "cash",
      check: "check",
      credit: "credit_card",
      credit_card: "credit_card",
      creditcard: "credit_card",
      debit: "debit_card",
      debit_card: "debit_card",
      debitcard: "debit_card",
      financing: "financing",
      fleet: "fleet_account",
      ar: "ar_account",
      account: "ar_account",
    };
    return methodMap[String(method).toLowerCase()] || "other";
  }

  private mapInspectionStatus(status: string): InspectionStatus {
    const statusMap: Record<string, InspectionStatus> = {
      not_started: "not_started",
      in_progress: "in_progress",
      completed: "completed",
      reviewed: "reviewed",
      sent: "sent_to_customer",
    };
    return statusMap[String(status).toLowerCase()] || "completed";
  }

  private mapInspectionFinding(finding: string): InspectionFinding {
    const findingMap: Record<string, InspectionFinding> = {
      pass: "pass",
      good: "pass",
      fair: "fair",
      caution: "caution",
      warning: "caution",
      immediate: "immediate_attention",
      safety: "safety_concern",
    };
    return findingMap[String(finding).toLowerCase()] || "not_inspected";
  }

  private mapRecommendationStatus(status: string): RecommendationStatus {
    const statusMap: Record<string, RecommendationStatus> = {
      recommended: "recommended",
      presented: "presented",
      authorized: "authorized",
      declined: "declined",
      deferred: "deferred",
      scheduled: "scheduled",
      completed: "completed",
    };
    return statusMap[String(status).toLowerCase()] || "declined";
  }

  private mapUrgency(
    urgency: string | number | undefined,
  ): "immediate" | "soon" | "next_visit" | "monitor" | "informational" {
    if (!urgency) return "next_visit";
    if (typeof urgency === "number") {
      if (urgency >= 5) return "immediate";
      if (urgency >= 4) return "soon";
      if (urgency >= 3) return "next_visit";
      if (urgency >= 2) return "monitor";
      return "informational";
    }
    const urgencyMap: Record<string, "immediate" | "soon" | "next_visit" | "monitor" | "informational"> = {
      immediate: "immediate",
      critical: "immediate",
      soon: "soon",
      warning: "soon",
      next_visit: "next_visit",
      monitor: "monitor",
      info: "informational",
    };
    return urgencyMap[String(urgency).toLowerCase()] || "next_visit";
  }

  private mapShopmonkeyStatus(status: string): WorkOrderStatus {
    const statusMap: Record<string, WorkOrderStatus> = {
      Estimate: "estimate",
      estimate: "estimate",
      WorkInProgress: "work_in_progress",
      "Work-In-Progress": "work_in_progress",
      Invoice: "closed",
      invoice: "closed",
      Complete: "closed",
      Posted: "closed",
      Archived: "archived",
      Deleted: "archived",
    };
    return statusMap[status] || "closed";
  }

  private mapServiceJobStatus(statusOrAuth: any): ServiceJobStatus {
    if (statusOrAuth === true) return "authorized";
    if (statusOrAuth === false) return "declined";

    const statusMap: Record<string, ServiceJobStatus> = {
      pending: "pending",
      authorized: "authorized",
      declined: "declined",
      completed: "completed",
    };
    return statusMap[String(statusOrAuth).toLowerCase()] || "completed";
  }

  private mapLineItemType(item: any): LineItemType {
    const type = String(item.type || item.lineType || "").toLowerCase();
    if (type.includes("labor")) return "labor";
    if (type.includes("part")) return "part";
    if (type.includes("sublet")) return "sublet";
    if (type.includes("fee")) return "fee";
    if (type.includes("tire")) return "tire";
    if (type.includes("fluid")) return "fluid";
    if (type.includes("discount")) return "discount";
    return "misc";
  }
}
