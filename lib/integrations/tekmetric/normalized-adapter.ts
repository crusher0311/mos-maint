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
import { resolveTekmetricJobStatus } from '@/lib/integrations/tekmetric/normalized-payload';

// =============================================================================
// TEKMETRIC ADAPTER
// =============================================================================

export class TekmetricAdapter implements INormalizedAdapter {
  sourceSystem: SourceSystem = 'tekmetric';
  
  getSourceIds(sourceData: any): SourceId[] {
    const ids: SourceId[] = [];
    
    if (sourceData.id) {
      ids.push({
        system: 'tekmetric',
        idType: 'repair_order_id',
        idValue: String(sourceData.id),
        isPrimary: true,
      });
    }
    
    if (sourceData.repairOrderNumber) {
      ids.push({
        system: 'tekmetric',
        idType: 'repair_order_number',
        idValue: String(sourceData.repairOrderNumber),
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
      submodel: cleanString(v.subModel),
      trim: cleanString(v.trim),
      engineDescription: cleanString(v.engineDescription || v.engine),
      licensePlate: cleanString(v.licensePlate),
      licensePlateState: cleanString(v.licensePlateState),
      exteriorColor: cleanString(v.color),
      odometerUnit: 'miles' as DistanceUnit,
      odometerHistory: [],
      isFleet: Boolean(v.isFleet),
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
      customerType: c.companyName ? 'business' : 'individual',
      firstName,
      lastName,
      fullName: [firstName, lastName].filter(Boolean).join(' ') || cleanString(c.companyName),
      companyName: cleanString(c.companyName),
      contacts: [],
      taxExempt: Boolean(c.isTaxExempt),
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
    
    const status = this.mapTekmetricStatus(ro.repairOrderStatus);
    
    return {
      enterpriseId,
      shopId,
      workOrderNumber: String(ro.repairOrderNumber || ro.id),
      workOrderType: 'repair',
      status,
      statusHistory: [],
      vehicleId: '',
      vehicle: vehicle as VehicleSnapshot,
      customerId: undefined,
      customer: customer as CustomerSnapshot,
      odometerIn: parseNumber(ro.milesIn || ro.mileageIn || ro.rawPayload?.repairOrder?.milesIn || ro.rawPayload?.repairOrder?.mileageIn),
      odometerOut: parseNumber(ro.milesOut || ro.mileageOut || ro.rawPayload?.repairOrder?.milesOut || ro.rawPayload?.repairOrder?.mileageOut),
      odometerUnit: 'miles',
      promisedDate: parseDate(ro.promisedDate),
      checkInDate: parseDate(ro.createdDate),
      completedDate: parseDate(ro.completedDate),
      closedDate: parseDate(ro.postedDate),
      serviceAdvisorId: cleanString(ro.serviceWriterId || ro.serviceWriter?.id),
      serviceAdvisorName: cleanString(
        ro.serviceWriter?.name ||
        ro.serviceWriter?.fullName ||
        ro.serviceWriterName ||
        ro.serviceAdvisorName ||
        [ro.serviceWriterAccountFirstName, ro.serviceWriterAccountLastName]
          .filter(Boolean)
          .join(' ')
      ),
      technicians: [],
      customerConcern: cleanString(ro.customerConcern),
      technicianNotes: cleanString(ro.technicianNotes),
      internalNotes: cleanString(ro.notes),
      serviceJobs: [],
      inspections: [],
      recommendations: [],
      subtotal: (parseNumber(ro.laborSubtotal) ?? 0) + (parseNumber(ro.partsSubtotal) ?? 0) + (parseNumber(ro.subletSubtotal) ?? 0),
      taxTotal: parseNumber(ro.taxTotal) || 0,
      discountTotal: parseNumber(ro.discountTotal) || 0,
      grandTotal: parseNumber(ro.total) || 0,
      laborTotal: parseNumber(ro.laborSubtotal) || 0,
      partsTotal: parseNumber(ro.partsSubtotal) || 0,
      subletTotal: parseNumber(ro.subletSubtotal) || 0,
      feesTotal: parseNumber(ro.feeSubtotal || ro.shopSuppliesTotal) || 0,
      laborHoursTotal: parseNumber(ro.totalLaborHours) || 0,
      laborHoursBilled: parseNumber(ro.billedLaborHours) || 0,
      payments: [],
      balanceDue: parseNumber(ro.balanceDue) || 0,
      isWarranty: Boolean(ro.isWarranty),
      isInternal: Boolean(ro.isInternal),
      isComeback: Boolean(ro.isComeback),
      tags: [],
      customFields: {},
    };
  }
  
  mapServiceJob(shopId: number, workOrderId: string, sourceData: any): Partial<NormalizedServiceJob> {
    const job = sourceData;
    
    return {
      shopId,
      workOrderId,
      jobNumber: cleanString(job.id),
      sequence: parseNumber(job.sortOrder) || 0,
      jobType: job.cannedJobId ? 'canned' : 'custom',
      status: resolveTekmetricJobStatus(job),
      statusHistory: [],
      title: cleanString(job.name || job.description) || 'Unknown Service',
      description: cleanString(job.description || job.note),
      cannedJobId: cleanString(job.cannedJobId),
      cannedJobCode: cleanString(job.cannedJobCode),
      cannedJobName: cleanString(job.cannedJobName),
      laborOperationCodes: [],
      technicianName: cleanString(job.technicianName),
      lineItems: [],
      laborTotal: parseNumber(job.laborTotal) ?? 0,
      partsTotal: parseNumber(job.partsTotal) ?? 0,
      subletTotal: parseNumber(job.subletTotal) ?? 0,
      feesTotal: 0,
      discountTotal: parseNumber(job.discountTotal) ?? 0,
      total: parseNumber(job.total) ?? 0,
      laborHoursEstimated: parseNumber(job.estimatedHours),
      laborHoursActual: parseNumber(job.actualHours),
      laborHoursBilled: parseNumber(job.billedHours),
      isWarranty: Boolean(job.isWarranty),
      isSublet: Boolean(job.isSublet),
      technicianNotes: cleanString(job.techNote),
      advisorNotes: cleanString(job.advisorNote),
      authorizedAt: job.authorized === true ? parseDate(job.authorizedDate) : undefined,
      declinedAt: job.authorized === false ? parseDate(job.declinedDate) : undefined,
      declineReason: cleanString(job.declineReason),
      componentsCodes: [],
      tags: [],
      customFields: {
        recordedPriceAvailable: job.recordedPriceAvailable === true,
        ...(job.status != null ? { providerStatus: String(job.status) } : {}),
        ...(typeof job.authorized === 'boolean' ? { authorized: job.authorized } : {}),
      },
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
      partDescription: cleanString(li.description || li.name) || 'Unknown Item',
      partBrand: cleanString(li.brand),
      partManufacturer: cleanString(li.manufacturer),
      quantity: parseNumber(li.quantity) || 1,
      quantityUnit: 'each',
      unitCost: parseNumber(li.cost) || 0,
      unitPrice: parseNumber(li.price) || 0,
      extendedPrice: parseNumber(li.total) || 0,
      discountPercent: parseNumber(li.discountPercent),
      discountAmount: parseNumber(li.discountAmount),
      taxable: li.taxable !== false,
      laborType: lineType === 'labor' ? 'flat_rate' : undefined,
      laborHours: lineType === 'labor' ? parseNumber(li.hours || li.quantity) : undefined,
      laborRate: lineType === 'labor' ? parseNumber(li.rate || li.price) : undefined,
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
      submodel: cleanString(v.subModel),
      engineDescription: cleanString(v.engineDescription),
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
      fullName: [firstName, lastName].filter(Boolean).join(' '),
      companyName: cleanString(c.companyName),
    };
  }
  
  extractServiceJobsFromWorkOrder(sourceData: any): Partial<NormalizedServiceJob>[] {
    const jobs = sourceData.jobs || [];
    
    if (!Array.isArray(jobs)) return [];
    
    return jobs.map((job: any, index: number) => ({
      sequence: index,
      title: cleanString(job.name || job.description) || 'Unknown Service',
      description: cleanString(job.description),
      laborHoursBilled: parseNumber(job.billedHours) || parseNumber(job.hours),
      total: parseNumber(job.total),
      laborTotal: parseNumber(job.laborTotal),
      partsTotal: parseNumber(job.partsTotal),
    }));
  }
  
  extractRawServiceJobsFromWorkOrder(sourceData: any): any[] {
    const jobs = sourceData.jobs || [];
    return Array.isArray(jobs) ? jobs : [];
  }

  /**
   * Tekmetric exposes labor and parts as separate per-job arrays where the
   * money amounts are in CENTS (`rate`, `cost`, `retail`). We collapse them
   * into a single line-items list and normalize cents → dollars here so
   * `mapLineItem` can stay generic. Each item carries a `_sourceId` of the
   * form `labor-<id>` or `part-<id>` to keep the (already-disjoint) labor
   * and parts ID namespaces explicitly separated for `ingestLineItem`'s
   * dedupe key.
   */
  extractLineItemsFromServiceJob(job: any): any[] {
    const out: any[] = [];
    const labor = Array.isArray(job?.labor) ? job.labor : [];
    for (let idx = 0; idx < labor.length; idx++) {
      const l = labor[idx] || {};
      const hours = parseNumber(l.hours) || 0;
      const rateDollars = (parseNumber(l.rate) || 0) / 100;
      out.push({
        _sourceId: `labor-${l.id ?? idx}`,
        id: l.id,
        type: 'labor',
        sortOrder: idx,
        name: l.name || job.name,
        description: l.name || job.name,
        quantity: 1,
        hours,
        rate: rateDollars,
        price: rateDollars,
        cost: 0,
        total: hours * rateDollars,
      });
    }
    const parts = Array.isArray(job?.parts) ? job.parts : [];
    for (let idx = 0; idx < parts.length; idx++) {
      const p = parts[idx] || {};
      const qty = parseNumber(p.quantity) || 1;
      const retailDollars = (parseNumber(p.retail) || 0) / 100;
      const costDollars = (parseNumber(p.cost) || 0) / 100;
      out.push({
        _sourceId: `part-${p.id ?? idx}`,
        id: p.id,
        type: 'part',
        sortOrder: labor.length + idx,
        name: p.name || p.description || '',
        description: p.name || p.description || '',
        partNumber: p.partNumber,
        brand: p.brand,
        manufacturer: p.brand,
        quantity: qty,
        price: retailDollars,
        cost: costDollars,
        total: qty * retailDollars,
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
    const jobs = sourceData.jobs || [];
    const recommendations: any[] = [];
    
    if (Array.isArray(jobs)) {
      for (const job of jobs) {
        if (job.authorized === false && job.name) {
          recommendations.push({
            ...job,
            status: 'declined',
          });
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
      method: this.mapPaymentMethod(p.paymentType || p.method),
      amount: parseNumber(p.amount) || 0,
      tipAmount: parseNumber(p.tipAmount),
      processedAt: parseDate(p.paymentDate || p.createdDate),
      cardBrand: cleanString(p.cardBrand),
      cardLast4: cleanString(p.cardLastFour || p.last4),
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
    
    const hasRed = items.some((item: any) => item.status === 'bad');
    const hasYellow = items.some((item: any) => item.status === 'marginal');
    const overallCondition = hasRed ? 'immediate_attention' as InspectionFinding 
      : hasYellow ? 'caution' as InspectionFinding 
      : this.mapInspectionFinding(i.overallCondition);
    
    return {
      shopId,
      workOrderId,
      vehicleId,
      inspectionType: 'multi_point',
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
        redCount: items.filter((item: any) => item.status === 'bad').length,
        yellowCount: items.filter((item: any) => item.status === 'marginal').length,
        greenCount: items.filter((item: any) => item.status === 'good').length,
      },
    };
  }
  
  private mapInspectionItemStatus(status: string): InspectionFinding {
    const statusMap: Record<string, InspectionFinding> = {
      'good': 'pass',
      'bad': 'immediate_attention',
      'marginal': 'caution',
      'not_inspected': 'not_inspected',
    };
    return statusMap[String(status).toLowerCase()] || 'not_inspected';
  }
  
  mapRecommendation(shopId: number, vehicleId: string, sourceData: any): Partial<NormalizedRecommendation> {
    const r = sourceData;
    return {
      shopId,
      vehicleId,
      status: this.mapRecommendationStatus(r.status || (r.authorized === false ? 'declined' : 'recommended')),
      statusHistory: [],
      title: cleanString(r.name || r.description) || 'Unknown Recommendation',
      description: cleanString(r.description || r.note),
      urgency: this.mapUrgency(r.urgency),
      priority: parseNumber(r.priority) || 3,
      estimatedCost: parseNumber(r.total || r.estimatedCost),
      estimatedHours: parseNumber(r.estimatedHours || r.billedHours),
      dateDeclined: parseDate(r.declinedDate),
      declineReason: cleanString(r.declineReason),
      followUpSent: false,
      mediaIds: [],
      notes: cleanString(r.note),
      customFields: {},
    };
  }
  
  private mapPaymentStatus(status: string): PaymentStatus {
    const statusMap: Record<string, PaymentStatus> = {
      'paid': 'paid',
      'pending': 'pending',
      'authorized': 'authorized',
      'refunded': 'refunded',
      'voided': 'voided',
      'failed': 'failed',
    };
    return statusMap[String(status).toLowerCase()] || 'paid';
  }
  
  private mapPaymentMethod(method: string): PaymentMethod {
    const methodMap: Record<string, PaymentMethod> = {
      'cash': 'cash',
      'check': 'check',
      'credit': 'credit_card',
      'credit_card': 'credit_card',
      'creditCard': 'credit_card',
      'debit': 'debit_card',
      'debit_card': 'debit_card',
      'debitCard': 'debit_card',
      'financing': 'financing',
      'fleet': 'fleet_account',
      'ar': 'ar_account',
      'account': 'ar_account',
    };
    return methodMap[String(method).toLowerCase()] || 'other';
  }
  
  private mapInspectionStatus(status: string): InspectionStatus {
    const statusMap: Record<string, InspectionStatus> = {
      'not_started': 'not_started',
      'in_progress': 'in_progress',
      'completed': 'completed',
      'reviewed': 'reviewed',
      'sent': 'sent_to_customer',
    };
    return statusMap[String(status).toLowerCase()] || 'completed';
  }
  
  private mapInspectionFinding(finding: string): InspectionFinding {
    const findingMap: Record<string, InspectionFinding> = {
      'pass': 'pass',
      'good': 'pass',
      'fair': 'fair',
      'caution': 'caution',
      'warning': 'caution',
      'immediate': 'immediate_attention',
      'safety': 'safety_concern',
    };
    return findingMap[String(finding).toLowerCase()] || 'not_inspected';
  }
  
  private mapRecommendationStatus(status: string): RecommendationStatus {
    const statusMap: Record<string, RecommendationStatus> = {
      'recommended': 'recommended',
      'presented': 'presented',
      'authorized': 'authorized',
      'declined': 'declined',
      'deferred': 'deferred',
      'scheduled': 'scheduled',
      'completed': 'completed',
    };
    return statusMap[String(status).toLowerCase()] || 'declined';
  }
  
  private mapUrgency(urgency: string | number | undefined): 'immediate' | 'soon' | 'next_visit' | 'monitor' | 'informational' {
    if (!urgency) return 'next_visit';
    if (typeof urgency === 'number') {
      if (urgency >= 5) return 'immediate';
      if (urgency >= 4) return 'soon';
      if (urgency >= 3) return 'next_visit';
      if (urgency >= 2) return 'monitor';
      return 'informational';
    }
    const urgencyMap: Record<string, 'immediate' | 'soon' | 'next_visit' | 'monitor' | 'informational'> = {
      'immediate': 'immediate',
      'critical': 'immediate',
      'soon': 'soon',
      'warning': 'soon',
      'next_visit': 'next_visit',
      'monitor': 'monitor',
      'info': 'informational',
    };
    return urgencyMap[String(urgency).toLowerCase()] || 'next_visit';
  }
  
  private mapTekmetricStatus(status: string): WorkOrderStatus {
    const statusMap: Record<string, WorkOrderStatus> = {
      'Estimate': 'estimate',
      'Work-In-Progress': 'work_in_progress',
      'Complete': 'closed',
      'Saved for Later': 'draft',
      'Archived': 'archived',
    };
    return statusMap[status] || 'closed';
  }
  
  private mapServiceJobStatus(statusOrAuth: any): ServiceJobStatus {
    if (statusOrAuth === true) return 'authorized';
    if (statusOrAuth === false) return 'declined';
    
    const statusMap: Record<string, ServiceJobStatus> = {
      'pending': 'pending',
      'authorized': 'authorized',
      'declined': 'declined',
      'completed': 'completed',
    };
    return statusMap[String(statusOrAuth).toLowerCase()] || 'pending';
  }
  
  private mapLineItemType(item: any): LineItemType {
    const type = String(item.type || item.lineType || '').toLowerCase();
    if (type.includes('labor')) return 'labor';
    if (type.includes('part')) return 'part';
    if (type.includes('sublet')) return 'sublet';
    if (type.includes('fee')) return 'fee';
    if (type.includes('tire')) return 'tire';
    if (type.includes('fluid')) return 'fluid';
    if (type.includes('discount')) return 'discount';
    return 'misc';
  }
}
