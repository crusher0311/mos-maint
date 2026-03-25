import { eq, and } from "drizzle-orm";
import {
  normalizedVehicles,
  normalizedCustomers,
  normalizedWorkOrders,
  normalizedServiceJobs,
  normalizedLineItems,
  normalizedPayments,
} from "./db/schema/normalized";

type DrizzleDb = ReturnType<typeof import("./db/drizzle").getDb>;

export class SupabaseDualWriter {
  private db: DrizzleDb;

  constructor(db: DrizzleDb) {
    this.db = db;
  }

  async upsertVehicle(doc: any): Promise<void> {
    const row = {
      id: doc._id,
      shopId: doc.shopId,
      enterpriseId: doc.enterpriseId || null,
      vin: doc.vin || null,
      year: doc.year || null,
      make: doc.make || null,
      model: doc.model || null,
      submodel: doc.submodel || null,
      trim: doc.trim || null,
      bodyStyle: doc.bodyStyle || null,
      engineDescription: doc.engineDescription || null,
      engineCylinders: doc.engineCylinders || null,
      fuelType: doc.fuelType || null,
      transmission: doc.transmission || null,
      drivetrain: doc.drivetrain || null,
      exteriorColor: doc.exteriorColor || null,
      licensePlate: doc.licensePlate || null,
      licensePlateState: doc.licensePlateState || null,
      currentOdometer: doc.currentOdometer || null,
      odometerUnit: doc.odometerUnit || "miles",
      isFleet: doc.isFleet || false,
      fleetId: doc.fleetId || null,
      customerIds: doc.customerIds || [],
      primaryCustomerId: doc.primaryCustomerId || null,
      totalServicesCount: doc.totalServicesCount || 0,
      totalServicesAmount: String(doc.totalServicesAmount || 0),
      lastServiceDate: doc.lastServiceDate || null,
      notes: doc.notes || null,
      tags: doc.tags || [],
      customFields: doc.customFields || {},
      provenance: this.serializeProvenance(doc.provenance),
      contentHash: doc.provenance?.contentHash || null,
      sourceSystem: doc.provenance?.sourceSystem || "unknown",
      rawData: this.sanitizeForJson(doc),
      softDelete: doc.softDelete || { isDeleted: false },
      version: doc.version || 1,
      createdAt: doc.createdAt || new Date(),
      updatedAt: doc.updatedAt || new Date(),
    };

    await (this.db as any)
      .insert(normalizedVehicles)
      .values(row)
      .onConflictDoUpdate({
        target: normalizedVehicles.id,
        set: {
          ...row,
          id: undefined,
          createdAt: undefined,
        },
      });
  }

  async upsertCustomer(doc: any): Promise<void> {
    const row = {
      id: doc._id,
      shopId: doc.shopId,
      enterpriseId: doc.enterpriseId || null,
      customerType: doc.customerType || "individual",
      firstName: doc.firstName || null,
      lastName: doc.lastName || null,
      fullName: doc.fullName || null,
      companyName: doc.companyName || null,
      contacts: doc.contacts || [],
      billingAddress: doc.billingAddress || null,
      mailingAddress: doc.mailingAddress || null,
      taxExempt: doc.taxExempt || false,
      accountNumber: doc.accountNumber || null,
      arBalance: String(doc.arBalance || 0),
      marketingConsent: doc.marketingConsent || false,
      smsConsent: doc.smsConsent || false,
      emailConsent: doc.emailConsent || false,
      vehicleIds: doc.vehicleIds || [],
      totalVisits: doc.totalVisits || 0,
      totalSpent: String(doc.totalSpent || 0),
      averageTicket: String(doc.averageTicket || 0),
      lastVisitDate: doc.lastVisitDate || null,
      notes: doc.notes || null,
      tags: doc.tags || [],
      customFields: doc.customFields || {},
      provenance: this.serializeProvenance(doc.provenance),
      contentHash: doc.provenance?.contentHash || null,
      sourceSystem: doc.provenance?.sourceSystem || "unknown",
      rawData: this.sanitizeForJson(doc),
      softDelete: doc.softDelete || { isDeleted: false },
      version: doc.version || 1,
      createdAt: doc.createdAt || new Date(),
      updatedAt: doc.updatedAt || new Date(),
    };

    await (this.db as any)
      .insert(normalizedCustomers)
      .values(row)
      .onConflictDoUpdate({
        target: normalizedCustomers.id,
        set: {
          ...row,
          id: undefined,
          createdAt: undefined,
        },
      });
  }

  async upsertWorkOrder(doc: any): Promise<void> {
    const row = {
      id: doc._id,
      shopId: doc.shopId,
      enterpriseId: doc.enterpriseId || null,
      workOrderNumber: doc.workOrderNumber || null,
      workOrderType: doc.workOrderType || "repair",
      status: doc.status || "closed",
      vehicleId: doc.vehicleId || null,
      customerId: doc.customerId || null,
      vehicle: doc.vehicle || null,
      customer: doc.customer || null,
      odometerIn: doc.odometerIn || null,
      odometerOut: doc.odometerOut || null,
      odometerUnit: doc.odometerUnit || "miles",
      checkInDate: doc.checkInDate || null,
      startedDate: doc.startedDate || null,
      completedDate: doc.completedDate || null,
      closedDate: doc.closedDate || null,
      serviceAdvisorName: doc.serviceAdvisorName || null,
      subtotal: String(doc.subtotal || 0),
      taxTotal: String(doc.taxTotal || 0),
      discountTotal: String(doc.discountTotal || 0),
      grandTotal: String(doc.grandTotal || 0),
      laborTotal: String(doc.laborTotal || 0),
      partsTotal: String(doc.partsTotal || 0),
      subletTotal: String(doc.subletTotal || 0),
      feesTotal: String(doc.feesTotal || 0),
      laborHoursTotal: String(doc.laborHoursTotal || 0),
      laborHoursBilled: String(doc.laborHoursBilled || 0),
      balanceDue: String(doc.balanceDue || 0),
      isWarranty: doc.isWarranty || false,
      isInternal: doc.isInternal || false,
      isComeback: doc.isComeback || false,
      tags: doc.tags || [],
      customFields: doc.customFields || {},
      provenance: this.serializeProvenance(doc.provenance),
      contentHash: doc.provenance?.contentHash || null,
      sourceSystem: doc.provenance?.sourceSystem || "unknown",
      rawData: this.sanitizeForJson(doc),
      softDelete: doc.softDelete || { isDeleted: false },
      version: doc.version || 1,
      createdAt: doc.createdAt || new Date(),
      updatedAt: doc.updatedAt || new Date(),
    };

    await (this.db as any)
      .insert(normalizedWorkOrders)
      .values(row)
      .onConflictDoUpdate({
        target: normalizedWorkOrders.id,
        set: {
          ...row,
          id: undefined,
          createdAt: undefined,
        },
      });
  }

  async upsertServiceJob(doc: any): Promise<void> {
    const row = {
      id: doc._id,
      shopId: doc.shopId,
      enterpriseId: doc.enterpriseId || null,
      workOrderId: doc.workOrderId,
      jobNumber: doc.jobNumber || null,
      sequence: doc.sequence || 0,
      jobType: doc.jobType || "custom",
      status: doc.status || "completed",
      title: doc.title || "Unknown Service",
      description: doc.description || null,
      cannedJobId: doc.cannedJobId || null,
      cannedJobCode: doc.cannedJobCode || null,
      technicianId: doc.technicianId || null,
      technicianName: doc.technicianName || null,
      laborTotal: String(doc.laborTotal || 0),
      partsTotal: String(doc.partsTotal || 0),
      subletTotal: String(doc.subletTotal || 0),
      feesTotal: String(doc.feesTotal || 0),
      discountTotal: String(doc.discountTotal || 0),
      total: String(doc.total || 0),
      laborHoursEstimated: doc.laborHoursEstimated != null ? String(doc.laborHoursEstimated) : null,
      laborHoursActual: doc.laborHoursActual != null ? String(doc.laborHoursActual) : null,
      laborHoursBilled: doc.laborHoursBilled != null ? String(doc.laborHoursBilled) : null,
      isWarranty: doc.isWarranty || false,
      isSublet: doc.isSublet || false,
      subletVendor: doc.subletVendor || null,
      tags: doc.tags || [],
      customFields: doc.customFields || {},
      provenance: this.serializeProvenance(doc.provenance),
      contentHash: doc.provenance?.contentHash || null,
      sourceSystem: doc.provenance?.sourceSystem || "unknown",
      rawData: this.sanitizeForJson(doc),
      softDelete: doc.softDelete || { isDeleted: false },
      version: doc.version || 1,
      createdAt: doc.createdAt || new Date(),
      updatedAt: doc.updatedAt || new Date(),
    };

    await (this.db as any)
      .insert(normalizedServiceJobs)
      .values(row)
      .onConflictDoUpdate({
        target: normalizedServiceJobs.id,
        set: {
          ...row,
          id: undefined,
          createdAt: undefined,
        },
      });
  }

  async upsertLineItem(doc: any): Promise<void> {
    const row = {
      id: doc._id,
      shopId: doc.shopId,
      enterpriseId: doc.enterpriseId || null,
      workOrderId: doc.workOrderId,
      serviceJobId: doc.serviceJobId,
      lineNumber: doc.lineNumber || 0,
      lineType: doc.lineType || "part",
      partNumber: doc.partNumber || null,
      partDescription: doc.partDescription || null,
      partBrand: doc.partBrand || null,
      partCondition: doc.partCondition || null,
      quantity: String(doc.quantity || 0),
      quantityUnit: doc.quantityUnit || "each",
      unitCost: String(doc.unitCost || 0),
      unitPrice: String(doc.unitPrice || 0),
      extendedPrice: String(doc.extendedPrice || 0),
      discountAmount: doc.discountAmount != null ? String(doc.discountAmount) : null,
      taxable: doc.taxable !== false,
      taxAmount: doc.taxAmount != null ? String(doc.taxAmount) : null,
      laborType: doc.laborType || null,
      laborHours: doc.laborHours != null ? String(doc.laborHours) : null,
      laborRate: doc.laborRate != null ? String(doc.laborRate) : null,
      technicianName: doc.technicianName || null,
      vendorName: doc.vendorName || null,
      notes: doc.notes || null,
      customFields: doc.customFields || {},
      provenance: this.serializeProvenance(doc.provenance),
      contentHash: doc.provenance?.contentHash || null,
      sourceSystem: doc.provenance?.sourceSystem || "unknown",
      rawData: this.sanitizeForJson(doc),
      softDelete: doc.softDelete || { isDeleted: false },
      version: doc.version || 1,
      createdAt: doc.createdAt || new Date(),
      updatedAt: doc.updatedAt || new Date(),
    };

    await (this.db as any)
      .insert(normalizedLineItems)
      .values(row)
      .onConflictDoUpdate({
        target: normalizedLineItems.id,
        set: {
          ...row,
          id: undefined,
          createdAt: undefined,
        },
      });
  }

  async upsertPayment(doc: any): Promise<void> {
    const row = {
      id: doc._id,
      shopId: doc.shopId,
      enterpriseId: doc.enterpriseId || null,
      workOrderId: doc.workOrderId,
      invoiceId: doc.invoiceId || null,
      paymentNumber: doc.paymentNumber || null,
      status: doc.status || "paid",
      method: doc.method || "other",
      amount: String(doc.amount || 0),
      tipAmount: doc.tipAmount != null ? String(doc.tipAmount) : null,
      processedAt: doc.processedAt || null,
      cardBrand: doc.cardBrand || null,
      cardLast4: doc.cardLast4 || null,
      checkNumber: doc.checkNumber || null,
      transactionId: doc.transactionId || null,
      referenceNumber: doc.referenceNumber || null,
      refundedAmount: doc.refundedAmount != null ? String(doc.refundedAmount) : null,
      refundedAt: doc.refundedAt || null,
      notes: doc.notes || null,
      customFields: doc.customFields || {},
      provenance: this.serializeProvenance(doc.provenance),
      contentHash: doc.provenance?.contentHash || null,
      sourceSystem: doc.provenance?.sourceSystem || "unknown",
      rawData: this.sanitizeForJson(doc),
      softDelete: doc.softDelete || { isDeleted: false },
      version: doc.version || 1,
      createdAt: doc.createdAt || new Date(),
      updatedAt: doc.updatedAt || new Date(),
    };

    await (this.db as any)
      .insert(normalizedPayments)
      .values(row)
      .onConflictDoUpdate({
        target: normalizedPayments.id,
        set: {
          ...row,
          id: undefined,
          createdAt: undefined,
        },
      });
  }

  private sanitizeForJson(doc: any): any {
    try {
      return JSON.parse(JSON.stringify(doc, (key, value) => {
        if (value instanceof Date) return value.toISOString();
        if (typeof value === 'bigint') return Number(value);
        if (key === '_id' && value?.toHexString) return value.toHexString();
        return value;
      }));
    } catch {
      return null;
    }
  }

  private serializeProvenance(prov: any): any {
    if (!prov) return {};
    return JSON.parse(JSON.stringify(prov, (key, value) => {
      if (value instanceof Date) return value.toISOString();
      return value;
    }));
  }
}
