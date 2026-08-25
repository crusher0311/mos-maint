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
  NormalizedComponentHistory,
  Provenance,
  SourceId,
  SoftDelete,
  VehicleSnapshot,
  CustomerSnapshot,
  StatusChange,
  TechnicianAssignment,
  PaymentRecord,
  OdometerReading,
  WorkOrderStatus,
  ServiceJobStatus,
  LineItemType,
  PartCondition,
  LaborType,
  PaymentMethod,
  PaymentStatus,
  DistanceUnit,
  InspectionStatus,
  InspectionFinding,
  RecommendationStatus,
  generateContentHash,
  generateEntityId,
  createProvenance,
  createSoftDelete,
  parseDate,
  parseNumber,
  cleanString,
} from '@/lib/integrations/core/normalized-adapter';
import { ObjectId } from 'mongodb';
import {
  extractProtractorServicePackages,
  getProtractorPackageLines,
  normalizeProtractorPackageLine,
  normalizeProtractorServiceJobStatus,
  summarizeProtractorPackage,
} from './package-normalization';

// Protractor (a .NET system) serializes "no date" as DateTime.MinValue —
// "0001-01-01T00:00:00" — which JS happily parses into a year-1 Date. A
// handful of invoices carry that sentinel in InvoiceTime, and it landed in
// closed_date, making Data Status report history "since year 0001". Any
// business date before 1990 is impossible for a repair order — treat it as
// absent so callers fall through to the next source (or null).
function parseBusinessDate(value: any): Date | undefined {
  const parsed = parseDate(value);
  if (!parsed) return undefined;
  return parsed.getFullYear() < 1990 ? undefined : parsed;
}

// Sum hours from a service package's labor lines. Protractor labor lines
// carry hours in `Hours` or (more commonly) `Quantity` — the same fields
// mapLineItem reads for per-line laborHours. Returns undefined (not 0) when
// there are no labor lines / no hours, because 0 is treated as a "no mileage
// math"-style sentinel by readers and the PG columns are nullable.
export function sumLaborLineHours(sp: any): number | undefined {
  const lines = getProtractorPackageLines(sp);
  let total = 0;
  for (const line of lines) {
    const type = String(line?.Type || line?.LineType || '').toLowerCase();
    if (!type.includes('labor')) continue;
    const hours = parseNumber(
      line?.EstimatedHours ?? line?.Hours ?? line?.LaborHours ?? line?.Quantity,
    );
    if (hours && hours > 0) total += hours;
  }
  if (total <= 0) return undefined;
  return Math.round(total * 100) / 100;
}

// =============================================================================
// PROTRACTOR ADAPTER
// =============================================================================

export class ProtractorAdapter implements INormalizedAdapter {
  sourceSystem: SourceSystem = 'protractor';
  
  getSourceIds(sourceData: any): SourceId[] {
    const ids: SourceId[] = [];
    
    if (sourceData.ID) {
      ids.push({
        system: 'protractor',
        idType: 'invoice_id',
        idValue: String(sourceData.ID),
        isPrimary: true,
      });
    }
    
    if (sourceData.InvoiceNumber) {
      ids.push({
        system: 'protractor',
        idType: 'invoice_number',
        idValue: String(sourceData.InvoiceNumber),
        isPrimary: false,
      });
    }

    // Protractor's terminal `/Invoice/` payloads commonly leave
    // InvoiceNumber at 0 while WorkOrderNumber carries the human-facing RO
    // number. Preserve it as a secondary identity so normalized records never
    // have to expose the opaque invoice GUID as their display number.
    if (sourceData.WorkOrderNumber) {
      ids.push({
        system: 'protractor',
        idType: 'work_order_number',
        idValue: String(sourceData.WorkOrderNumber),
        isPrimary: false,
      });
    }
    
    if (sourceData.ServiceItemID) {
      ids.push({
        system: 'protractor',
        idType: 'service_item_id',
        idValue: String(sourceData.ServiceItemID),
        isPrimary: false,
      });
    }
    
    return ids;
  }
  
  mapVehicle(shopId: number, sourceData: any, enterpriseId?: string): Partial<NormalizedVehicle> {
    const si = sourceData.ServiceItem || sourceData;
    
    return {
      enterpriseId,
      shopId,
      vin: cleanString(si.VIN),
      vinDecoded: false,
      year: parseNumber(si.Year),
      make: cleanString(si.Make),
      model: cleanString(si.Model),
      submodel: cleanString(si.SubModel),
      engineDescription: cleanString(si.Engine),
      licensePlate: cleanString(si.LicensePlate || si.Tag),
      licensePlateState: cleanString(si.LicensePlateState || si.TagState),
      exteriorColor: cleanString(si.Color),
      odometerUnit: 'miles' as DistanceUnit,
      odometerHistory: [],
      isFleet: false,
      notes: cleanString(si.Notes),
      tags: [],
      customFields: {},
      customerIds: [],
      totalServicesCount: 0,
      totalServicesAmount: 0,
    };
  }
  
  mapCustomer(shopId: number, sourceData: any, enterpriseId?: string): Partial<NormalizedCustomer> {
    const c = sourceData.Customer || sourceData;
    
    const firstName = cleanString(c.FirstName);
    const lastName = cleanString(c.LastName);
    const companyName = cleanString(c.CompanyName || c.Company);
    
    return {
      enterpriseId,
      shopId,
      customerType: companyName ? 'business' : 'individual',
      firstName,
      lastName,
      fullName: [firstName, lastName].filter(Boolean).join(' ') || companyName,
      companyName,
      contacts: [],
      taxExempt: false,
      arBalance: 0,
      marketingConsent: false,
      smsConsent: false,
      emailConsent: false,
      tags: [],
      customFields: {},
      vehicleIds: [],
      totalVisits: 0,
      totalSpent: 0,
      averageTicket: 0,
    };
  }
  
  mapWorkOrder(shopId: number, sourceData: any, enterpriseId?: string): Partial<NormalizedWorkOrder> {
    const inv = sourceData;
    const vehicle = this.extractVehicleFromWorkOrder(inv);
    const customer = this.extractCustomerFromWorkOrder(inv);
    
    const status = this.mapProtractorStatus(inv.WorkflowStage || inv.Status);
    // Protractor invoices nest their business dates: the top-level
    // `InvoiceTime` carries the invoice/close timestamp and `Header.*` carries
    // creation / last-modified times. The previously-checked top-level
    // `ClosedDate` / `InvoiceDate` / `DateIn` / `CreatedDate` fields are NOT
    // present on the real API payload, so reading only those left every
    // Protractor work-order date column empty (task #640). Fall back through
    // the legacy names for safety, then to the header timestamps.
    const closedDate = parseBusinessDate(
      inv.InvoiceTime ||
      inv.ClosedDate ||
      inv.InvoiceDate ||
      inv.Header?.LastModifiedTime,
    );
    const checkInDate = parseBusinessDate(
      inv.Header?.CreationTime ||
      inv.DateIn ||
      inv.CreatedDate ||
      inv.ScheduledTime,
    );
    // Invoices pulled from the `/Invoice/` endpoint are terminal records, so a
    // real closed/completed date must land even when WorkflowStage maps to a
    // non-"closed" terminal status (e.g. "Invoiced"/"Paid") instead of
    // defaulting to "closed".
    const isTerminal =
      status === 'closed' || status === 'invoiced' || status === 'paid';
    
    return {
      enterpriseId,
      shopId,
      // On real Protractor invoice payloads InvoiceNumber is frequently 0;
      // WorkOrderNumber is the readable RO number shown in the SMS.
      workOrderNumber: String(inv.WorkOrderNumber || inv.InvoiceNumber || inv.ID),
      workOrderType: 'repair',
      status,
      statusHistory: [],
      vehicleId: '',
      vehicle: vehicle as VehicleSnapshot,
      customerId: undefined,
      customer: customer as CustomerSnapshot,
      odometerIn: parseNumber(inv.OdometerIn || inv.InUsage || inv.Odometer || inv.ServiceItem?.Odometer || inv.ServiceItem?.Usage || inv.rawPayload?.OdometerIn || inv.rawPayload?.InUsage || inv.rawPayload?.Odometer),
      odometerOut: parseNumber(inv.OdometerOut || inv.OutUsage || inv.rawPayload?.OdometerOut || inv.rawPayload?.OutUsage),
      odometerUnit: 'miles',
      checkInDate,
      completedDate: isTerminal ? closedDate : undefined,
      closedDate: isTerminal ? closedDate : undefined,
      serviceAdvisorName: cleanString(inv.ServiceAdvisor?.Name || inv.Advisor),
      technicians: [],
      customerConcern: cleanString(inv.CustomerConcern || inv.Concern),
      technicianNotes: cleanString(inv.TechNotes),
      internalNotes: cleanString(inv.InternalNotes),
      serviceJobs: [],
      inspections: [],
      recommendations: [],
      subtotal: parseNumber(inv.Subtotal) || 0,
      taxTotal: parseNumber(inv.TaxTotal || inv.Tax) || 0,
      discountTotal: parseNumber(inv.DiscountTotal || inv.Discount) || 0,
      grandTotal: parseNumber(inv.Total || inv.GrandTotal) || 0,
      laborTotal: parseNumber(inv.LaborTotal || inv.TotalLabor) || 0,
      partsTotal: parseNumber(inv.PartsTotal || inv.TotalParts) || 0,
      subletTotal: parseNumber(inv.SubletTotal) || 0,
      feesTotal: parseNumber(inv.FeesTotal || inv.ShopSupplies) || 0,
      laborHoursTotal: parseNumber(inv.TotalHours) || 0,
      laborHoursBilled: parseNumber(inv.BilledHours) || 0,
      payments: [],
      balanceDue: parseNumber(inv.BalanceDue) || 0,
      isWarranty: Boolean(inv.IsWarranty),
      isInternal: Boolean(inv.IsInternal),
      isComeback: Boolean(inv.IsComeback),
      tags: [],
      customFields: {},
    };
  }
  
  mapServiceJob(shopId: number, workOrderId: string, sourceData: any): Partial<NormalizedServiceJob> {
    const sp = sourceData;
    const pricing = summarizeProtractorPackage(sp);

    // Protractor service packages almost never carry package-level hour
    // fields (EstimatedHours/ActualHours/BilledHours are absent), but their
    // labor LINES do carry hours (verified live: shop 66 water pump labor
    // lines all have Hours). Sum the labor-line hours so laborHoursBilled is
    // populated at ingestion instead of every reader re-deriving it from
    // normalized_line_items (task #986).
    const laborLineHours = sumLaborLineHours(sp);

    return {
      shopId,
      workOrderId,
      jobNumber: cleanString(sp.ID),
       sequence: parseNumber(sp.Sequence ?? sp._sourceSequence) || 0,
      jobType: sp.CannedJobID ? 'canned' : 'custom',
       status: normalizeProtractorServiceJobStatus(sp.Status, sp._isDeferred === true),
      statusHistory: [],
      // Protractor service packages rarely carry their own completion date, so
      // prefer the package's nested header timestamps and fall back to the
      // parent invoice's business date stamped on by
      // extractRawServiceJobsFromWorkOrder (task #640). Without this the
      // service-job completion date was never set and the Data Status panel
      // fell back to the MOS import timestamp.
      completedAt: parseBusinessDate(
        sp.Header?.LastModifiedTime ||
        sp.Header?.CreationTime ||
        sp.CompletedDate ||
        sp._parentClosedAt,
      ),
      // Protractor carries the human-readable service name under
      // ServicePackageHeader.Title (mirroring the raw-extraction path in
      // extractServiceJobsFromWorkOrder below). Without checking the header
      // first, every row landed as 'Unknown Service' (task #891, shop 66:
      // 8,454/8,454 rows) even though legacy job_index had correct titles
      // from the same source payloads.
      title: cleanString(
        sp.ServicePackageHeader?.Title ||
        sp.Name ||
        sp.Description ||
        sp.ServiceDescription ||
        sp.Title,
      ) || 'Unknown Service',
      description: cleanString(sp.ServicePackageHeader?.Description || sp.Description || sp.Notes),
      cannedJobId: cleanString(sp.CannedJobID),
      cannedJobCode: cleanString(sp.CannedJobCode),
      cannedJobName: cleanString(sp.CannedJobName),
      laborOperationCodes: [],
      technicianName: cleanString(sp.TechnicianName || sp.Technician),
      lineItems: [],
       laborTotal: pricing.laborTotal,
       partsTotal: pricing.partsTotal,
       subletTotal: pricing.subletTotal,
       feesTotal: pricing.feesTotal,
       discountTotal: pricing.discountTotal,
       total: pricing.total,
      laborHoursEstimated: parseNumber(sp.EstimatedHours),
      laborHoursActual: parseNumber(sp.ActualHours),
      laborHoursBilled: parseNumber(sp.BilledHours || sp.Hours) ?? laborLineHours,
      isWarranty: Boolean(sp.IsWarranty),
      isSublet: Boolean(sp.IsSublet),
      subletVendor: cleanString(sp.SubletVendor),
      subletCost: parseNumber(sp.SubletCost),
      technicianNotes: cleanString(sp.TechNotes),
      advisorNotes: cleanString(sp.AdvisorNotes),
      componentsCodes: [],
      tags: [],
      customFields: {},
    };
  }
  
  mapLineItem(shopId: number, workOrderId: string, serviceJobId: string, sourceData: any): Partial<NormalizedLineItem> {
    const li = sourceData;
    const lineType = this.mapLineItemType(li);
    const normalized = normalizeProtractorPackageLine(li);
    
    return {
      shopId,
      workOrderId,
      serviceJobId,
      lineNumber: parseNumber(li.Sequence) || 0,
      lineType,
      partNumber: cleanString(li.PartNumber),
       partDescription: cleanString(normalized.description) || 'Unknown Item',
       partBrand: cleanString(li.Brand || normalized.manufacturer),
       partManufacturer: cleanString(normalized.manufacturer),
      partCondition: this.mapPartCondition(li),
       quantity: normalized.quantity,
      quantityUnit: cleanString(li.Unit) || 'each',
       unitCost: normalized.cost ?? parseNumber(li.UnitCost) ?? 0,
       unitPrice: normalized.unitPrice,
       extendedPrice: normalized.extendedPrice,
      discountPercent: parseNumber(li.DiscountPercent),
      discountAmount: parseNumber(li.DiscountAmount),
      taxable: li.Taxable !== false,
      taxRate: parseNumber(li.TaxRate),
      taxAmount: parseNumber(li.TaxAmount),
      laborType: lineType === 'labor' ? 'flat_rate' : undefined,
       laborHours: lineType === 'labor' ? normalized.quantity : undefined,
       laborRate: lineType === 'labor' ? normalized.unitPrice : undefined,
      technicianName: cleanString(li.Technician),
      vendorName: cleanString(li.Vendor || li.Supplier),
      vendorPartNumber: cleanString(li.VendorPartNumber),
      vendorCost: parseNumber(li.VendorCost),
      coreCharge: parseNumber(li.CoreCharge),
      coreReturned: Boolean(li.CoreReturned),
      warrantyEligible: Boolean(li.WarrantyEligible),
      serialNumber: cleanString(li.SerialNumber),
      notes: cleanString(li.Notes),
      customFields: {},
    };
  }
  
  extractVehicleFromWorkOrder(sourceData: any): Partial<NormalizedVehicle> | null {
    const si = sourceData.ServiceItem;
    if (!si) return null;
    
    return {
      vin: cleanString(si.VIN),
      year: parseNumber(si.Year),
      make: cleanString(si.Make),
      model: cleanString(si.Model),
      submodel: cleanString(si.SubModel),
      engineDescription: cleanString(si.Engine),
      licensePlate: cleanString(si.LicensePlate || si.Tag),
    };
  }
  
  extractCustomerFromWorkOrder(sourceData: any): Partial<NormalizedCustomer> | null {
    // Protractor uses "Contact" instead of "Customer"
    const c = sourceData.Customer || sourceData.Contact;
    if (!c) return null;
    
    // Handle Protractor's Name object vs flat FirstName/LastName
    let firstName: string | undefined;
    let lastName: string | undefined;
    let fullName: string | undefined;
    
    if (c.Name && typeof c.Name === 'object') {
      // Protractor structure: Contact.Name.First, Contact.Name.Last
      firstName = cleanString(c.Name.First);
      lastName = cleanString(c.Name.Last);
    } else if (c.Name && typeof c.Name === 'string') {
      // Protractor sometimes uses FileAs or Name as full name string
      fullName = cleanString(c.Name);
    } else {
      firstName = cleanString(c.FirstName);
      lastName = cleanString(c.LastName);
    }
    
    // Try FileAs as fallback for full name
    if (!fullName && !firstName && !lastName) {
      fullName = cleanString(c.FileAs);
    }
    
    return {
      firstName,
      lastName,
      fullName: fullName || [firstName, lastName].filter(Boolean).join(' ') || undefined,
      companyName: cleanString(c.CompanyName || c.Company),
    };
  }
  
  extractServiceJobsFromWorkOrder(sourceData: any): Partial<NormalizedServiceJob>[] {
    return extractProtractorServicePackages(sourceData).map((sp: any) => {
      const mapped = this.mapServiceJob(0, '', sp);
      const lineItems = this.extractLineItemsFromServiceJob(sp).map((line) =>
        this.mapLineItem(0, '', '', line),
      ) as NormalizedLineItem[];
      return { ...mapped, lineItems };
    });
  }
  
  extractRawServiceJobsFromWorkOrder(sourceData: any): any[] {
    return extractProtractorServicePackages(sourceData);
  }

  extractLineItemsFromServiceJob(sp: any): any[] {
    const lines = getProtractorPackageLines(sp);
    return lines.map((line: any, idx: number) => ({
      ...line,
      _sourceId:
        line.ID || line.LineID ||
        `${sp.ID || sp.ServicePackageHeader?.ID || 'sp'}-${idx}`,
      Sequence: line.Sequence ?? idx,
    }));
  }

  extractPaymentsFromWorkOrder(sourceData: any): any[] {
    const payments = sourceData.Payments?.ItemCollection || sourceData.Payments || [];
    return Array.isArray(payments) ? payments : [];
  }
  
  extractInspectionsFromWorkOrder(sourceData: any): any[] {
    const inspections = sourceData.Inspections?.ItemCollection || sourceData.Inspections || [];
    return Array.isArray(inspections) ? inspections : [];
  }
  
  extractRecommendationsFromWorkOrder(sourceData: any): any[] {
    const recommendations = sourceData.Recommendations?.ItemCollection || 
                           sourceData.DeferredServices?.ItemCollection ||
                           sourceData.DeclinedServices ||
                           [];
    return Array.isArray(recommendations) ? recommendations : [];
  }
  
  mapPayment(shopId: number, workOrderId: string, sourceData: any): Partial<NormalizedPayment> {
    const p = sourceData;
    return {
      shopId,
      workOrderId,
      paymentNumber: cleanString(p.ID || p.PaymentNumber),
      status: this.mapPaymentStatus(p.Status),
      method: this.mapPaymentMethod(p.PaymentMethod || p.Method),
      amount: parseNumber(p.Amount) || 0,
      tipAmount: parseNumber(p.TipAmount),
      processedAt: parseDate(p.PaymentDate || p.ProcessedAt),
      cardBrand: cleanString(p.CardType || p.CardBrand),
      cardLast4: cleanString(p.CardLast4 || p.Last4),
      checkNumber: cleanString(p.CheckNumber),
      authorizationCode: cleanString(p.AuthCode),
      transactionId: cleanString(p.TransactionID || p.TransactionId),
      notes: cleanString(p.Notes),
      customFields: {},
    };
  }
  
  mapInspection(shopId: number, workOrderId: string, vehicleId: string, sourceData: any): Partial<NormalizedInspection> {
    const i = sourceData;
    return {
      shopId,
      workOrderId,
      vehicleId,
      inspectionType: 'multi_point',
      templateName: cleanString(i.TemplateName || i.Name),
      status: this.mapInspectionStatus(i.Status),
      technicianName: cleanString(i.TechnicianName || i.Technician),
      startedAt: parseDate(i.StartedAt || i.StartDate),
      completedAt: parseDate(i.CompletedAt || i.EndDate),
      overallCondition: this.mapInspectionFinding(i.OverallCondition),
      summary: cleanString(i.Summary || i.Notes),
      sections: [],
      mediaItems: [],
      recommendations: [],
      customFields: {},
    };
  }
  
  mapRecommendation(shopId: number, vehicleId: string, sourceData: any): Partial<NormalizedRecommendation> {
    const r = sourceData;
    return {
      shopId,
      vehicleId,
      status: this.mapRecommendationStatus(r.Status),
      statusHistory: [],
      title: cleanString(r.Name || r.Description || r.ServiceName) || 'Unknown Recommendation',
      description: cleanString(r.Description || r.Notes),
      urgency: this.mapUrgency(r.Urgency || r.Priority),
      priority: parseNumber(r.Priority) || 3,
      estimatedCost: parseNumber(r.EstimatedCost || r.Price),
      estimatedHours: parseNumber(r.EstimatedHours || r.Hours),
      dateDeclined: parseDate(r.DeclinedDate),
      declineReason: cleanString(r.DeclineReason),
      followUpSent: false,
      mediaIds: [],
      notes: cleanString(r.Notes),
      customFields: {},
    };
  }
  
  private mapPaymentStatus(status: string): PaymentStatus {
    const statusMap: Record<string, PaymentStatus> = {
      'Paid': 'paid',
      'Pending': 'pending',
      'Authorized': 'authorized',
      'Refunded': 'refunded',
      'Voided': 'voided',
      'Failed': 'failed',
    };
    return statusMap[status] || 'paid';
  }
  
  private mapPaymentMethod(method: string): PaymentMethod {
    const methodMap: Record<string, PaymentMethod> = {
      'Cash': 'cash',
      'Check': 'check',
      'CreditCard': 'credit_card',
      'Credit Card': 'credit_card',
      'DebitCard': 'debit_card',
      'Debit Card': 'debit_card',
      'Financing': 'financing',
      'Fleet': 'fleet_account',
      'AR': 'ar_account',
      'Account': 'ar_account',
    };
    return methodMap[method] || 'other';
  }
  
  private mapInspectionStatus(status: string): InspectionStatus {
    const statusMap: Record<string, InspectionStatus> = {
      'NotStarted': 'not_started',
      'InProgress': 'in_progress',
      'Completed': 'completed',
      'Reviewed': 'reviewed',
      'Sent': 'sent_to_customer',
    };
    return statusMap[status] || 'completed';
  }
  
  private mapInspectionFinding(finding: string): InspectionFinding {
    const findingMap: Record<string, InspectionFinding> = {
      'Pass': 'pass',
      'Good': 'pass',
      'Fair': 'fair',
      'Caution': 'caution',
      'Warning': 'caution',
      'Immediate': 'immediate_attention',
      'Safety': 'safety_concern',
    };
    return findingMap[finding] || 'not_inspected';
  }
  
  private mapRecommendationStatus(status: string): RecommendationStatus {
    const statusMap: Record<string, RecommendationStatus> = {
      'Recommended': 'recommended',
      'Presented': 'presented',
      'Authorized': 'authorized',
      'Declined': 'declined',
      'Deferred': 'deferred',
      'Scheduled': 'scheduled',
      'Completed': 'completed',
    };
    return statusMap[status] || 'declined';
  }
  
  private mapUrgency(urgency: string | number): 'immediate' | 'soon' | 'next_visit' | 'monitor' | 'informational' {
    if (typeof urgency === 'number') {
      if (urgency >= 5) return 'immediate';
      if (urgency >= 4) return 'soon';
      if (urgency >= 3) return 'next_visit';
      if (urgency >= 2) return 'monitor';
      return 'informational';
    }
    const urgencyMap: Record<string, 'immediate' | 'soon' | 'next_visit' | 'monitor' | 'informational'> = {
      'Immediate': 'immediate',
      'Critical': 'immediate',
      'Soon': 'soon',
      'Warning': 'soon',
      'NextVisit': 'next_visit',
      'Monitor': 'monitor',
      'Info': 'informational',
    };
    return urgencyMap[urgency] || 'next_visit';
  }
  
  private mapProtractorStatus(stage: string): WorkOrderStatus {
    const stageMap: Record<string, WorkOrderStatus> = {
      'Unassigned': 'draft',
      'ScheduledWork': 'scheduled',
      'CheckedIn': 'checked_in',
      'EstimateCompleted': 'estimate',
      'WorkAuthorized': 'authorized',
      'InspectionInProgress': 'inspection_in_progress',
      'InspectionCompleted': 'inspection_complete',
      'WaitingForParts': 'waiting_parts',
      'WaitingForApproval': 'waiting_approval',
      'WorkInProgress': 'work_in_progress',
      'WorkPaused': 'work_paused',
      'WorkCompleted': 'work_complete',
      'Invoiced': 'invoiced',
      'Paid': 'paid',
      'Closed': 'closed',
      'Voided': 'voided',
    };
    return stageMap[stage] || 'closed';
  }
  
  private mapServiceJobStatus(status: string): ServiceJobStatus {
    return normalizeProtractorServiceJobStatus(status);
  }
  
  private mapLineItemType(item: any): LineItemType {
    const type = String(item.Type || item.LineType || '').toLowerCase();
    if (type.includes('labor')) return 'labor';
    if (type.includes('part') || type.includes('material')) return 'part';
    if (type.includes('sublet')) return 'sublet';
    if (type.includes('fee') || type.includes('shop')) return 'fee';
    if (type.includes('tire')) return 'tire';
    if (type.includes('fluid') || type.includes('oil')) return 'fluid';
    if (type.includes('discount')) return 'discount';
    if (type.includes('tax')) return 'tax';
    return 'misc';
  }
  
  private mapPartCondition(item: any): PartCondition {
    const condition = String(item.Condition || '').toLowerCase();
    if (condition.includes('oem')) return 'new_oem';
    if (condition.includes('reman')) return 'remanufactured';
    if (condition.includes('rebuilt')) return 'rebuilt';
    if (condition.includes('used')) return 'used';
    if (condition.includes('customer')) return 'customer_supplied';
    return 'new_aftermarket';
  }
}

