/**
 * MOS Normalized Data Schema v1.0
 * 
 * A comprehensive, granular schema for automotive shop historical data
 * that normalizes data from ALL SMS integrations into a single canonical format.
 * 
 * Design Principles:
 * - Integration-agnostic: Works with Protractor, Tekmetric, AutoFlow, Mitchell, Shop-Ware, etc.
 * - Future-proof: Granular enough to support any feature we might build
 * - Portable: Shops can switch SMS systems and retain all history
 * - Auditable: Full change history and provenance tracking
 * - Multi-tenant: Supports enterprise/multi-location scenarios
 */

// =============================================================================
// ENUMS & CONSTANTS
// =============================================================================

export type SourceSystem = 
  | 'protractor'
  | 'tekmetric'
  | 'autoflow'
  | 'autovitals'
  | 'mitchell'
  | 'shopware'
  | 'rowriter'
  | 'shopmonkey'
  | 'shopboss'
  | 'alldata'
  | 'identifix'
  | 'manual'
  | 'import'
  | 'unknown';

export type WorkOrderStatus = 
  | 'draft'
  | 'estimate'
  | 'pending_approval'
  | 'approved'
  | 'authorized'
  | 'scheduled'
  | 'checked_in'
  | 'inspection_pending'
  | 'inspection_in_progress'
  | 'inspection_complete'
  | 'waiting_parts'
  | 'waiting_approval'
  | 'work_in_progress'
  | 'work_paused'
  | 'work_complete'
  | 'quality_check'
  | 'ready_for_pickup'
  | 'invoiced'
  | 'paid'
  | 'closed'
  | 'voided'
  | 'archived';

export type WorkOrderType = 
  | 'repair'
  | 'maintenance'
  | 'inspection'
  | 'estimate_only'
  | 'warranty'
  | 'internal'
  | 'comeback'
  | 'sublet'
  | 'quick_service'
  | 'fleet'
  | 'insurance';

export type ServiceJobStatus = 
  | 'pending'
  | 'authorized'
  | 'declined'
  | 'deferred'
  | 'in_progress'
  | 'completed'
  | 'cancelled'
  | 'warranty';

export type ServiceJobType = 
  | 'canned'
  | 'custom'
  | 'diagnostic'
  | 'inspection'
  | 'sublet'
  | 'internal'
  | 'warranty'
  | 'comeback';

export type LineItemType = 
  | 'part'
  | 'labor'
  | 'sublet'
  | 'fee'
  | 'shop_supply'
  | 'hazmat'
  | 'disposal'
  | 'tax'
  | 'discount'
  | 'core_charge'
  | 'tire'
  | 'fluid'
  | 'misc';

export type PartCondition = 
  | 'new_oem'
  | 'new_aftermarket'
  | 'remanufactured'
  | 'rebuilt'
  | 'used'
  | 'customer_supplied'
  | 'core_return';

export type LaborType = 
  | 'flat_rate'
  | 'hourly'
  | 'diagnostic'
  | 'warranty'
  | 'internal'
  | 'sublet';

export type InspectionStatus = 
  | 'not_started'
  | 'in_progress'
  | 'completed'
  | 'reviewed'
  | 'sent_to_customer';

export type InspectionFinding = 
  | 'pass'
  | 'fair'
  | 'caution'
  | 'immediate_attention'
  | 'safety_concern'
  | 'not_inspected'
  | 'not_applicable';

export type RecommendationStatus = 
  | 'recommended'
  | 'presented'
  | 'authorized'
  | 'declined'
  | 'deferred'
  | 'scheduled'
  | 'completed'
  | 'completed_elsewhere'
  | 'expired'
  | 'cancelled';

export type AppointmentStatus = 
  | 'requested'
  | 'pending_confirmation'
  | 'confirmed'
  | 'reminded'
  | 'checked_in'
  | 'in_progress'
  | 'completed'
  | 'no_show'
  | 'cancelled'
  | 'rescheduled';

export type PaymentMethod = 
  | 'cash'
  | 'check'
  | 'credit_card'
  | 'debit_card'
  | 'financing'
  | 'fleet_account'
  | 'warranty'
  | 'insurance'
  | 'ar_account'
  | 'other';

export type PaymentStatus = 
  | 'pending'
  | 'authorized'
  | 'captured'
  | 'partially_paid'
  | 'paid'
  | 'refunded'
  | 'partially_refunded'
  | 'voided'
  | 'failed'
  | 'chargeback';

export type WarrantyType = 
  | 'manufacturer'
  | 'extended'
  | 'shop_warranty'
  | 'parts_warranty'
  | 'labor_warranty'
  | 'tire_road_hazard'
  | 'powertrain'
  | 'bumper_to_bumper';

export type WarrantyClaimStatus = 
  | 'draft'
  | 'submitted'
  | 'pending_review'
  | 'approved'
  | 'partially_approved'
  | 'denied'
  | 'paid'
  | 'closed';

export type PartOrderStatus = 
  | 'needed'
  | 'ordered'
  | 'backordered'
  | 'shipped'
  | 'received'
  | 'installed'
  | 'returned'
  | 'cancelled';

export type TechnicianCertification = 
  | 'ase_master'
  | 'ase_a1_engine_repair'
  | 'ase_a2_transmission'
  | 'ase_a3_manual_drivetrain'
  | 'ase_a4_steering_suspension'
  | 'ase_a5_brakes'
  | 'ase_a6_electrical'
  | 'ase_a7_hvac'
  | 'ase_a8_engine_performance'
  | 'ase_a9_diesel'
  | 'ase_l1_advanced_engine'
  | 'ase_l2_diesel'
  | 'ase_l3_hybrid'
  | 'manufacturer_certified'
  | 'state_inspector'
  | 'emissions_certified';

export type ContactRole = 
  | 'owner'
  | 'co_owner'
  | 'driver'
  | 'authorized_contact'
  | 'fleet_manager'
  | 'billing_contact'
  | 'emergency_contact';

export type CommunicationPreference = 
  | 'phone_call'
  | 'text_sms'
  | 'email'
  | 'app_notification'
  | 'mail'
  | 'no_contact';

export type VehicleOwnershipType = 
  | 'owned'
  | 'financed'
  | 'leased'
  | 'fleet'
  | 'rental'
  | 'dealer'
  | 'wholesale';

export type DistanceUnit = 'miles' | 'kilometers';
export type VolumeUnit = 'quarts' | 'liters';
export type WeightUnit = 'pounds' | 'kilograms';

// =============================================================================
// PROVENANCE & AUDIT
// =============================================================================

export interface Provenance {
  sourceSystem: SourceSystem;
  sourceIds: SourceId[];
  firstSeenAt: Date;
  lastSeenAt: Date;
  lastSyncedAt: Date;
  syncRunId?: string;
  contentHash: string;
  rawPayloadRef?: string;
  writebackStatus?: WritebackStatus;
}

export interface SourceId {
  system: SourceSystem;
  idType: string;
  idValue: string;
  isPrimary: boolean;
}

export interface WritebackStatus {
  lastAttemptAt?: Date;
  lastSuccessAt?: Date;
  lastErrorAt?: Date;
  lastError?: string;
  retryCount: number;
  status: 'pending' | 'synced' | 'error' | 'not_applicable';
}

export interface AuditEntry {
  _id: string;
  entityType: string;
  entityId: string;
  changeType: 'create' | 'update' | 'delete' | 'restore' | 'merge';
  actor: AuditActor;
  timestamp: Date;
  changes: FieldChange[];
  metadata?: Record<string, any>;
}

export interface AuditActor {
  type: 'system' | 'user' | 'integration' | 'migration';
  id?: string;
  name?: string;
  sourceSystem?: SourceSystem;
}

export interface FieldChange {
  field: string;
  oldValue: any;
  newValue: any;
}

export interface SoftDelete {
  isDeleted: boolean;
  deletedAt?: Date;
  deletedBy?: string;
  deleteReason?: string;
  restoredAt?: Date;
  restoredBy?: string;
}

// =============================================================================
// BASE ENTITY
// =============================================================================

export interface BaseEntity {
  _id: string;
  enterpriseId?: number;
  shopId: number;
  locationId?: string;
  provenance: Provenance;
  softDelete: SoftDelete;
  createdAt: Date;
  updatedAt: Date;
  version: number;
}

// =============================================================================
// VEHICLE
// =============================================================================

export interface NormalizedVehicle extends BaseEntity {
  vin?: string;
  vinDecoded: boolean;
  vinDecodeData?: VinDecodeData;
  
  year?: number;
  make?: string;
  model?: string;
  submodel?: string;
  trim?: string;
  bodyStyle?: string;
  engineCode?: string;
  engineDescription?: string;
  engineDisplacement?: number;
  engineDisplacementUnit?: 'liters' | 'cubic_inches';
  engineCylinders?: number;
  engineConfiguration?: string;
  fuelType?: string;
  transmission?: string;
  transmissionSpeeds?: number;
  drivetrain?: string;
  
  exteriorColor?: string;
  interiorColor?: string;
  licensePlate?: string;
  licensePlateState?: string;
  
  ownershipType?: VehicleOwnershipType;
  isFleet: boolean;
  fleetId?: string;
  fleetUnitNumber?: string;
  
  currentOdometer?: number;
  odometerUnit: DistanceUnit;
  odometerHistory: OdometerReading[];
  estimatedAnnualMileage?: number;
  
  purchaseDate?: Date;
  inServiceDate?: Date;
  warrantyExpirationDate?: Date;
  warrantyExpirationMileage?: number;
  
  telematicsProvider?: string;
  telematicsDeviceId?: string;
  
  notes?: string;
  tags: string[];
  customFields: Record<string, any>;
  
  customerIds: string[];
  primaryCustomerId?: string;
  
  lastServiceDate?: Date;
  lastServiceMileage?: number;
  totalServicesCount: number;
  totalServicesAmount: number;
}

export interface VinDecodeData {
  decodedAt: Date;
  decodedBy: string;
  rawData: Record<string, any>;
  
  makeId?: string;
  modelId?: string;
  yearId?: string;
  
  gvwr?: number;
  manufacturerName?: string;
  plantCountry?: string;
  plantCity?: string;
  
  vehicleType?: string;
  vehicleClass?: string;
  
  steeringType?: string;
  absType?: string;
  airBagLocations?: string[];
  
  tireSize?: string;
  wheelSize?: string;
  
  oemMaintenanceScheduleId?: string;
}

export interface OdometerReading {
  reading: number;
  unit: DistanceUnit;
  source: 'work_order' | 'inspection' | 'customer_reported' | 'telematics' | 'carfax' | 'estimated';
  recordedAt: Date;
  workOrderId?: string;
  sourceSystem?: SourceSystem;
  isVerified: boolean;
}

// =============================================================================
// CUSTOMER / CONTACT
// =============================================================================

export interface NormalizedCustomer extends BaseEntity {
  customerType: 'individual' | 'business' | 'fleet' | 'government' | 'dealer';
  
  firstName?: string;
  lastName?: string;
  fullName?: string;
  companyName?: string;
  
  contacts: CustomerContact[];
  primaryContactId?: string;
  
  billingAddress?: Address;
  mailingAddress?: Address;
  
  taxExempt: boolean;
  taxExemptNumber?: string;
  
  accountNumber?: string;
  arBalance: number;
  creditLimit?: number;
  paymentTerms?: string;
  defaultPaymentMethod?: PaymentMethod;
  
  marketingConsent: boolean;
  marketingConsentDate?: Date;
  smsConsent: boolean;
  smsConsentDate?: Date;
  emailConsent: boolean;
  emailConsentDate?: Date;
  
  referralSource?: string;
  acquisitionDate?: Date;
  
  notes?: string;
  internalNotes?: string;
  tags: string[];
  customFields: Record<string, any>;
  
  vehicleIds: string[];
  
  totalVisits: number;
  totalSpent: number;
  averageTicket: number;
  lastVisitDate?: Date;
  
  loyaltyPoints?: number;
  loyaltyTier?: string;
  
  dedupeKey?: string;
}

export interface CustomerContact {
  id: string;
  role: ContactRole;
  isPrimary: boolean;
  
  firstName?: string;
  lastName?: string;
  fullName?: string;
  title?: string;
  
  email?: string;
  emailVerified: boolean;
  
  phone?: string;
  phoneType?: 'mobile' | 'home' | 'work' | 'fax';
  phoneVerified: boolean;
  
  preferredContactMethod?: CommunicationPreference;
  preferredContactTime?: string;
  doNotContact: boolean;
  
  notes?: string;
}

export interface Address {
  street1?: string;
  street2?: string;
  city?: string;
  state?: string;
  postalCode?: string;
  country?: string;
  isVerified: boolean;
  latitude?: number;
  longitude?: number;
}

// =============================================================================
// WORK ORDER
// =============================================================================

export interface NormalizedWorkOrder extends BaseEntity {
  workOrderNumber: string;
  workOrderType: WorkOrderType;
  status: WorkOrderStatus;
  statusHistory: StatusChange[];
  
  vehicleId: string;
  vehicle: VehicleSnapshot;
  
  customerId?: string;
  customer?: CustomerSnapshot;
  
  odometerIn?: number;
  odometerOut?: number;
  odometerUnit: DistanceUnit;
  
  promisedDate?: Date;
  promisedTime?: string;
  dueDate?: Date;
  
  checkInDate?: Date;
  checkInTime?: string;
  checkInBy?: string;
  
  startedDate?: Date;
  completedDate?: Date;
  closedDate?: Date;
  
  serviceAdvisorId?: string;
  serviceAdvisorName?: string;
  
  technicians: TechnicianAssignment[];
  
  customerConcern?: string;
  technicianNotes?: string;
  internalNotes?: string;
  
  serviceJobs: NormalizedServiceJob[];
  inspections: NormalizedInspection[];
  recommendations: NormalizedRecommendation[];
  
  subtotal: number;
  taxTotal: number;
  discountTotal: number;
  grandTotal: number;
  
  laborTotal: number;
  partsTotal: number;
  subletTotal: number;
  feesTotal: number;
  
  laborHoursTotal: number;
  laborHoursBilled: number;
  
  payments: PaymentRecord[];
  balanceDue: number;
  
  isWarranty: boolean;
  isInternal: boolean;
  isComeback: boolean;
  comebackFromWorkOrderId?: string;
  
  appointmentId?: string;
  
  authorizedBy?: string;
  authorizedAt?: Date;
  authorizedMethod?: 'in_person' | 'phone' | 'text' | 'email' | 'app';
  
  tags: string[];
  customFields: Record<string, any>;
}

export interface StatusChange {
  status: WorkOrderStatus;
  changedAt: Date;
  changedBy?: string;
  reason?: string;
}

export interface VehicleSnapshot {
  vehicleId: string;
  vin?: string;
  year?: number;
  make?: string;
  model?: string;
  submodel?: string;
  licensePlate?: string;
  engineDescription?: string;
  transmission?: string;
}

export interface CustomerSnapshot {
  customerId: string;
  fullName?: string;
  companyName?: string;
  phone?: string;
  email?: string;
}

export interface TechnicianAssignment {
  technicianId: string;
  technicianName: string;
  role: 'primary' | 'assistant' | 'inspector';
  assignedAt: Date;
  startedAt?: Date;
  completedAt?: Date;
  hoursLogged: number;
}

export interface PaymentRecord {
  paymentId: string;
  method: PaymentMethod;
  amount: number;
  status: PaymentStatus;
  processedAt?: Date;
  transactionId?: string;
  cardLast4?: string;
  checkNumber?: string;
}

// =============================================================================
// SERVICE JOB
// =============================================================================

export interface NormalizedServiceJob extends BaseEntity {
  workOrderId: string;
  
  jobNumber?: string;
  sequence: number;
  
  jobType: ServiceJobType;
  status: ServiceJobStatus;
  statusHistory: StatusChange[];
  
  title: string;
  description?: string;
  
  cannedJobId?: string;
  cannedJobCode?: string;
  cannedJobName?: string;
  
  laborOperationCodes: LaborOperationCode[];
  
  technicianId?: string;
  technicianName?: string;
  
  lineItems: NormalizedLineItem[];
  
  laborTotal: number;
  partsTotal: number;
  subletTotal: number;
  feesTotal: number;
  discountTotal: number;
  total: number;
  
  laborHoursEstimated?: number;
  laborHoursActual?: number;
  laborHoursBilled?: number;
  
  isWarranty: boolean;
  warrantyClaimId?: string;
  
  isSublet: boolean;
  subletVendor?: string;
  subletCost?: number;
  
  technicianNotes?: string;
  advisorNotes?: string;
  
  authorizedAt?: Date;
  authorizedBy?: string;
  declinedAt?: Date;
  declinedBy?: string;
  declineReason?: string;
  
  startedAt?: Date;
  completedAt?: Date;
  
  inspectionId?: string;
  recommendationId?: string;
  
  componentsCodes: string[];
  
  tags: string[];
  customFields: Record<string, any>;
}

export interface LaborOperationCode {
  code: string;
  description?: string;
  source: 'alldata' | 'mitchell' | 'identifix' | 'motor' | 'ase' | 'custom';
  hours?: number;
}

// =============================================================================
// LINE ITEM
// =============================================================================

export interface NormalizedLineItem extends BaseEntity {
  workOrderId: string;
  serviceJobId: string;
  
  lineNumber: number;
  lineType: LineItemType;
  
  partId?: string;
  partNumber?: string;
  partDescription: string;
  partBrand?: string;
  partManufacturer?: string;
  partCondition?: PartCondition;
  
  quantity: number;
  quantityUnit: string;
  
  unitCost: number;
  unitPrice: number;
  extendedPrice: number;
  
  discountPercent?: number;
  discountAmount?: number;
  
  taxable: boolean;
  taxRate?: number;
  taxAmount?: number;
  
  laborType?: LaborType;
  laborHours?: number;
  laborRate?: number;
  
  technicianId?: string;
  technicianName?: string;
  
  vendorId?: string;
  vendorName?: string;
  vendorPartNumber?: string;
  vendorCost?: number;
  
  coreCharge?: number;
  coreReturned: boolean;
  coreReturnedDate?: Date;
  
  warrantyEligible: boolean;
  warrantyClaimId?: string;
  
  serialNumber?: string;
  lotNumber?: string;
  expirationDate?: Date;
  
  installedComponentId?: string;
  removedComponentId?: string;
  
  notes?: string;
  internalNotes?: string;
  
  orderStatus?: PartOrderStatus;
  orderedAt?: Date;
  receivedAt?: Date;
  
  customFields: Record<string, any>;
}

// =============================================================================
// PARTS MASTER
// =============================================================================

export interface NormalizedPart extends BaseEntity {
  partNumbers: PartNumber[];
  primaryPartNumber: string;
  
  description: string;
  longDescription?: string;
  
  category?: string;
  subcategory?: string;
  
  brand?: string;
  manufacturer?: string;
  manufacturerPartNumber?: string;
  
  isOem: boolean;
  oeMPartNumber?: string;
  
  supersededBy?: string;
  supersedes?: string[];
  
  alternates: PartNumber[];
  
  unitOfMeasure: string;
  packageQuantity?: number;
  
  cost?: number;
  listPrice?: number;
  retailPrice?: number;
  
  weight?: number;
  weightUnit?: WeightUnit;
  
  dimensions?: {
    length?: number;
    width?: number;
    height?: number;
    unit?: string;
  };
  
  warrantyMonths?: number;
  warrantyMiles?: number;
  
  applicationYears?: string;
  applicationMakes?: string[];
  applicationModels?: string[];
  applicationEngines?: string[];
  
  hazmat: boolean;
  hazmatClass?: string;
  
  coreRequired: boolean;
  coreValue?: number;
  
  imageUrls: string[];
  
  notes?: string;
  
  isActive: boolean;
  discontinuedDate?: Date;
  
  customFields: Record<string, any>;
}

export interface PartNumber {
  number: string;
  type: 'primary' | 'oem' | 'aftermarket' | 'alternate' | 'superseded' | 'cross_reference';
  brand?: string;
  source?: string;
}

// =============================================================================
// INSPECTION / DVI
// =============================================================================

export interface NormalizedInspection extends BaseEntity {
  workOrderId: string;
  vehicleId: string;
  
  inspectionType: 'multi_point' | 'safety' | 'emissions' | 'pre_purchase' | 'courtesy' | 'custom';
  templateId?: string;
  templateName?: string;
  
  status: InspectionStatus;
  
  technicianId?: string;
  technicianName?: string;
  
  startedAt?: Date;
  completedAt?: Date;
  reviewedAt?: Date;
  reviewedBy?: string;
  
  sentToCustomerAt?: Date;
  sentVia?: 'email' | 'text' | 'app';
  customerViewedAt?: Date;
  
  overallCondition?: InspectionFinding;
  summary?: string;
  
  sections: InspectionSection[];
  
  mediaItems: InspectionMedia[];
  
  recommendations: string[];
  
  customerSignature?: string;
  customerSignedAt?: Date;
  
  notes?: string;
  
  customFields: Record<string, any>;
}

export interface InspectionSection {
  id: string;
  name: string;
  sequence: number;
  items: InspectionItem[];
}

export interface InspectionItem {
  id: string;
  name: string;
  sequence: number;
  finding: InspectionFinding;
  measurement?: string;
  measurementUnit?: string;
  minimumSpec?: string;
  maximumSpec?: string;
  notes?: string;
  mediaIds: string[];
  recommendationCreated: boolean;
  recommendationId?: string;
}

export interface InspectionMedia {
  id: string;
  type: 'photo' | 'video' | 'document';
  url: string;
  thumbnailUrl?: string;
  caption?: string;
  sectionId?: string;
  itemId?: string;
  uploadedAt: Date;
  uploadedBy?: string;
}

// =============================================================================
// RECOMMENDATION
// =============================================================================

export interface NormalizedRecommendation extends BaseEntity {
  vehicleId: string;
  customerId?: string;
  
  originWorkOrderId?: string;
  originInspectionId?: string;
  originServiceJobId?: string;
  
  completedWorkOrderId?: string;
  completedServiceJobId?: string;
  
  status: RecommendationStatus;
  statusHistory: StatusChange[];
  
  title: string;
  description?: string;
  
  urgency: 'immediate' | 'soon' | 'next_visit' | 'monitor' | 'informational';
  priority: number;
  
  category?: string;
  serviceCode?: string;
  
  estimatedCost?: number;
  estimatedHours?: number;
  
  mileageRecommended?: number;
  dateRecommended?: Date;
  
  mileageDeclined?: number;
  dateDeclined?: Date;
  declineReason?: string;
  
  followUpDate?: Date;
  followUpSent: boolean;
  followUpSentAt?: Date;
  followUpMethod?: 'email' | 'text' | 'phone' | 'app';
  
  appointmentId?: string;
  
  expiresAt?: Date;
  
  presentedBy?: string;
  presentedAt?: Date;
  
  mediaIds: string[];
  
  notes?: string;
  
  customFields: Record<string, any>;
}

// =============================================================================
// APPOINTMENT
// =============================================================================

export interface NormalizedAppointment extends BaseEntity {
  appointmentNumber?: string;
  
  vehicleId?: string;
  customerId?: string;
  
  status: AppointmentStatus;
  statusHistory: StatusChange[];
  
  scheduledDate: Date;
  scheduledTime?: string;
  estimatedDuration?: number;
  
  dropOffTime?: string;
  pickUpTime?: string;
  
  isDropOff: boolean;
  isWaiter: boolean;
  needsLoaner: boolean;
  needsShuttle: boolean;
  
  serviceAdvisorId?: string;
  serviceAdvisorName?: string;
  
  technicianId?: string;
  technicianName?: string;
  
  bay?: string;
  
  services: AppointmentService[];
  
  estimatedTotal?: number;
  
  customerConcern?: string;
  internalNotes?: string;
  
  confirmationSentAt?: Date;
  reminderSentAt?: Date;
  
  bookingChannel?: 'phone' | 'web' | 'app' | 'walk_in' | 'text' | 'scheduler';
  bookedBy?: string;
  bookedAt?: Date;
  
  checkedInAt?: Date;
  checkedInBy?: string;
  
  workOrderId?: string;
  
  cancelledAt?: Date;
  cancelledBy?: string;
  cancelReason?: string;
  
  rescheduledFrom?: string;
  rescheduledTo?: string;
  
  customFields: Record<string, any>;
}

export interface AppointmentService {
  id: string;
  description: string;
  estimatedHours?: number;
  estimatedCost?: number;
  isFromRecommendation: boolean;
  recommendationId?: string;
}

// =============================================================================
// PAYMENT
// =============================================================================

export interface NormalizedPayment extends BaseEntity {
  workOrderId: string;
  invoiceId?: string;
  
  paymentNumber?: string;
  
  status: PaymentStatus;
  
  method: PaymentMethod;
  
  amount: number;
  tipAmount?: number;
  
  processedAt?: Date;
  
  cardBrand?: string;
  cardLast4?: string;
  cardExpiry?: string;
  
  checkNumber?: string;
  
  authorizationCode?: string;
  transactionId?: string;
  referenceNumber?: string;
  
  processorName?: string;
  processorResponse?: string;
  
  refundedAmount?: number;
  refundedAt?: Date;
  refundReason?: string;
  
  notes?: string;
  
  customFields: Record<string, any>;
}

// =============================================================================
// INVOICE
// =============================================================================

export interface NormalizedInvoice extends BaseEntity {
  workOrderId: string;
  
  invoiceNumber: string;
  invoiceDate: Date;
  dueDate?: Date;
  
  customerId?: string;
  billingAddress?: Address;
  
  subtotal: number;
  taxTotal: number;
  discountTotal: number;
  grandTotal: number;
  
  amountPaid: number;
  balanceDue: number;
  
  lineItems: InvoiceLineItem[];
  
  taxBreakdown: TaxBreakdown[];
  
  paymentTerms?: string;
  
  notes?: string;
  termsAndConditions?: string;
  
  sentAt?: Date;
  sentVia?: 'email' | 'print' | 'text';
  viewedAt?: Date;
  
  paidInFullAt?: Date;
  
  arStatus?: 'current' | 'past_due_30' | 'past_due_60' | 'past_due_90' | 'collections';
  
  customFields: Record<string, any>;
}

export interface InvoiceLineItem {
  description: string;
  quantity: number;
  unitPrice: number;
  extendedPrice: number;
  taxable: boolean;
  lineItemId?: string;
}

export interface TaxBreakdown {
  taxName: string;
  taxRate: number;
  taxableAmount: number;
  taxAmount: number;
}

// =============================================================================
// TECHNICIAN
// =============================================================================

export interface NormalizedTechnician extends BaseEntity {
  userId?: string;
  
  employeeNumber?: string;
  
  firstName: string;
  lastName: string;
  fullName: string;
  
  email?: string;
  phone?: string;
  
  hireDate?: Date;
  terminationDate?: Date;
  isActive: boolean;
  
  laborRate?: number;
  costRate?: number;
  
  certifications: TechnicianCert[];
  
  specialties: string[];
  
  defaultBay?: string;
  
  hoursTargetDaily?: number;
  hoursTargetWeekly?: number;
  
  notes?: string;
  
  customFields: Record<string, any>;
}

export interface TechnicianCert {
  certification: TechnicianCertification | string;
  issuedDate?: Date;
  expirationDate?: Date;
  certificationNumber?: string;
  isActive: boolean;
}

// =============================================================================
// LABOR TIME LOG
// =============================================================================

export interface NormalizedLaborTimeLog extends BaseEntity {
  workOrderId: string;
  serviceJobId?: string;
  lineItemId?: string;
  
  technicianId: string;
  technicianName: string;
  
  clockIn: Date;
  clockOut?: Date;
  
  duration?: number;
  
  type: 'productive' | 'non_productive' | 'training' | 'break' | 'meeting';
  
  notes?: string;
  
  customFields: Record<string, any>;
}

// =============================================================================
// WARRANTY CLAIM
// =============================================================================

export interface NormalizedWarrantyClaim extends BaseEntity {
  workOrderId: string;
  vehicleId: string;
  
  claimNumber?: string;
  
  warrantyType: WarrantyType;
  warrantyProvider?: string;
  policyNumber?: string;
  
  status: WarrantyClaimStatus;
  statusHistory: StatusChange[];
  
  claimDate: Date;
  failureDate?: Date;
  repairDate?: Date;
  
  failureMileage?: number;
  currentMileage?: number;
  
  failureDescription: string;
  repairDescription?: string;
  causeCode?: string;
  complaintCode?: string;
  correctionCode?: string;
  
  laborClaimed: number;
  partsClaimed: number;
  totalClaimed: number;
  
  laborApproved?: number;
  partsApproved?: number;
  totalApproved?: number;
  
  laborPaid?: number;
  partsPaid?: number;
  totalPaid?: number;
  
  denialReason?: string;
  
  submittedAt?: Date;
  submittedBy?: string;
  
  approvedAt?: Date;
  approvedBy?: string;
  
  paidAt?: Date;
  
  partsReturned: boolean;
  partsReturnedAt?: Date;
  partsReturnTrackingNumber?: string;
  
  documents: WarrantyDocument[];
  
  notes?: string;
  
  customFields: Record<string, any>;
}

export interface WarrantyDocument {
  id: string;
  type: 'claim_form' | 'invoice' | 'photo' | 'repair_order' | 'other';
  name: string;
  url: string;
  uploadedAt: Date;
}

// =============================================================================
// VEHICLE COMPONENT HISTORY
// =============================================================================

export interface NormalizedComponentHistory extends BaseEntity {
  vehicleId: string;
  
  componentType: string;
  componentCode?: string;
  componentName: string;
  
  position?: string;
  
  installedAt?: Date;
  installedMileage?: number;
  installedWorkOrderId?: string;
  installedLineItemId?: string;
  
  removedAt?: Date;
  removedMileage?: number;
  removedWorkOrderId?: string;
  removedReason?: string;
  
  partId?: string;
  partNumber?: string;
  partBrand?: string;
  serialNumber?: string;
  
  condition: 'new' | 'used' | 'remanufactured' | 'rebuilt' | 'original';
  
  warrantyMonths?: number;
  warrantyMiles?: number;
  warrantyExpiresAt?: Date;
  warrantyExpiresMileage?: number;
  
  lastServiceAt?: Date;
  lastServiceMileage?: number;
  
  nextServiceDue?: Date;
  nextServiceMileage?: number;
  
  notes?: string;
  
  customFields: Record<string, any>;
}

// =============================================================================
// FLEET
// =============================================================================

export interface NormalizedFleet extends BaseEntity {
  fleetNumber?: string;
  
  companyName: string;
  
  primaryContactId?: string;
  
  billingAddress?: Address;
  
  accountNumber?: string;
  paymentTerms?: string;
  creditLimit?: number;
  arBalance: number;
  
  discountPercent?: number;
  laborRate?: number;
  
  vehicleIds: string[];
  vehicleCount: number;
  
  notes?: string;
  
  customFields: Record<string, any>;
}

// =============================================================================
// CANNED JOB / SERVICE TEMPLATE
// =============================================================================

export interface NormalizedCannedJob extends BaseEntity {
  code: string;
  name: string;
  description?: string;
  
  category?: string;
  subcategory?: string;
  
  isActive: boolean;
  
  laborHours?: number;
  laborRate?: number;
  
  parts: CannedJobPart[];
  
  laborOperationCodes: LaborOperationCode[];
  
  estimatedTotal?: number;
  
  applicationYears?: string;
  applicationMakes?: string[];
  applicationModels?: string[];
  applicationEngines?: string[];
  
  maintenanceInterval?: {
    miles?: number;
    months?: number;
    hours?: number;
  };
  
  notes?: string;
  internalNotes?: string;
  
  customFields: Record<string, any>;
}

export interface CannedJobPart {
  partNumber?: string;
  description: string;
  quantity: number;
  unitPrice?: number;
  isRequired: boolean;
}

// =============================================================================
// COLLECTION NAMES
// =============================================================================

export const NORMALIZED_COLLECTIONS = {
  vehicles: 'normalized_vehicles',
  customers: 'normalized_customers',
  workOrders: 'normalized_work_orders',
  serviceJobs: 'normalized_service_jobs',
  lineItems: 'normalized_line_items',
  parts: 'normalized_parts',
  inspections: 'normalized_inspections',
  recommendations: 'normalized_recommendations',
  appointments: 'normalized_appointments',
  payments: 'normalized_payments',
  invoices: 'normalized_invoices',
  technicians: 'normalized_technicians',
  laborTimeLogs: 'normalized_labor_time_logs',
  warrantyClaims: 'normalized_warranty_claims',
  componentHistory: 'normalized_component_history',
  fleets: 'normalized_fleets',
  cannedJobs: 'normalized_canned_jobs',
  audit: 'normalized_audit_log',
} as const;

// =============================================================================
// INDEX DEFINITIONS
// =============================================================================

export const NORMALIZED_INDEXES = {
  vehicles: [
    { key: { shopId: 1, vin: 1 }, unique: true, sparse: true },
    { key: { enterpriseId: 1 } },
    { key: { 'provenance.sourceSystem': 1, 'provenance.sourceIds.idValue': 1 } },
    { key: { customerIds: 1 } },
    { key: { make: 1, model: 1, year: 1 } },
    { key: { 'softDelete.isDeleted': 1 } },
  ],
  workOrders: [
    { key: { shopId: 1, workOrderNumber: 1 }, unique: true },
    { key: { enterpriseId: 1 } },
    { key: { vehicleId: 1 } },
    { key: { customerId: 1 } },
    { key: { status: 1 } },
    { key: { createdAt: -1 } },
    { key: { closedDate: -1 } },
    { key: { 'provenance.sourceSystem': 1, 'provenance.sourceIds.idValue': 1 } },
    { key: { 'softDelete.isDeleted': 1 } },
  ],
  serviceJobs: [
    { key: { workOrderId: 1, sequence: 1 } },
    { key: { shopId: 1 } },
    { key: { title: 'text', description: 'text' } },
    { key: { cannedJobCode: 1 } },
    { key: { 'vehicle.make': 1, 'vehicle.model': 1, 'vehicle.year': 1 } },
    { key: { createdAt: -1 } },
  ],
  // ... additional indexes for other collections
};
