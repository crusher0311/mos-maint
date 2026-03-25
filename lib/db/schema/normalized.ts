import {
  pgTable,
  pgEnum,
  text,
  varchar,
  timestamp,
  integer,
  boolean,
  jsonb,
  decimal,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const sourceSystemEnum = pgEnum("source_system", [
  "protractor",
  "tekmetric",
  "autoflow",
  "autovitals",
  "mitchell",
  "shopware",
  "rowriter",
  "shopmonkey",
  "shopboss",
  "alldata",
  "identifix",
  "manual",
  "import",
  "unknown",
]);

export const workOrderStatusEnum = pgEnum("work_order_status", [
  "draft",
  "estimate",
  "pending_approval",
  "approved",
  "authorized",
  "scheduled",
  "checked_in",
  "inspection_pending",
  "inspection_in_progress",
  "inspection_complete",
  "waiting_parts",
  "waiting_approval",
  "work_in_progress",
  "work_paused",
  "work_complete",
  "quality_check",
  "ready_for_pickup",
  "invoiced",
  "paid",
  "closed",
  "voided",
  "archived",
]);

export const workOrderTypeEnum = pgEnum("work_order_type", [
  "repair",
  "maintenance",
  "inspection",
  "estimate_only",
  "warranty",
  "internal",
  "comeback",
  "sublet",
  "quick_service",
  "fleet",
  "insurance",
]);

export const serviceJobStatusEnum = pgEnum("service_job_status", [
  "pending",
  "authorized",
  "declined",
  "deferred",
  "in_progress",
  "completed",
  "cancelled",
  "warranty",
]);

export const serviceJobTypeEnum = pgEnum("service_job_type", [
  "canned",
  "custom",
  "diagnostic",
  "inspection",
  "sublet",
  "internal",
  "warranty",
  "comeback",
]);

export const lineItemTypeEnum = pgEnum("line_item_type", [
  "part",
  "labor",
  "sublet",
  "fee",
  "shop_supply",
  "hazmat",
  "disposal",
  "tax",
  "discount",
  "core_charge",
  "tire",
  "fluid",
  "misc",
]);

export const partConditionEnum = pgEnum("part_condition", [
  "new_oem",
  "new_aftermarket",
  "remanufactured",
  "rebuilt",
  "used",
  "customer_supplied",
  "core_return",
]);

export const laborTypeEnum = pgEnum("labor_type", [
  "flat_rate",
  "hourly",
  "diagnostic",
  "warranty",
  "internal",
  "sublet",
]);

export const paymentMethodEnum = pgEnum("payment_method", [
  "cash",
  "check",
  "credit_card",
  "debit_card",
  "financing",
  "fleet_account",
  "warranty",
  "insurance",
  "ar_account",
  "other",
]);

export const paymentStatusEnum = pgEnum("payment_status", [
  "pending",
  "authorized",
  "captured",
  "partially_paid",
  "paid",
  "refunded",
  "partially_refunded",
  "voided",
  "failed",
  "chargeback",
]);

export const distanceUnitEnum = pgEnum("distance_unit", [
  "miles",
  "kilometers",
]);

export const vehicleOwnershipTypeEnum = pgEnum("vehicle_ownership_type", [
  "owned",
  "financed",
  "leased",
  "fleet",
  "rental",
  "dealer",
  "wholesale",
]);

export const customerTypeEnum = pgEnum("customer_type", [
  "individual",
  "business",
  "fleet",
  "government",
  "dealer",
]);

export const partOrderStatusEnum = pgEnum("part_order_status", [
  "needed",
  "ordered",
  "backordered",
  "shipped",
  "received",
  "installed",
  "returned",
  "cancelled",
]);

export const normalizedVehicles = pgTable("normalized_vehicles", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  enterpriseId: text("enterprise_id"),
  shopId: integer("shop_id").notNull(),
  locationId: text("location_id"),

  provenance: jsonb("provenance").notNull(),
  softDelete: jsonb("soft_delete").notNull().default(sql`'{"isDeleted":false}'::jsonb`),
  version: integer("version").notNull().default(1),

  vin: text("vin"),
  vinDecoded: boolean("vin_decoded").notNull().default(false),
  vinDecodeData: jsonb("vin_decode_data"),

  year: integer("year"),
  make: text("make"),
  model: text("model"),
  submodel: text("submodel"),
  trim: text("trim"),
  bodyStyle: text("body_style"),
  engineCode: text("engine_code"),
  engineDescription: text("engine_description"),
  engineDisplacement: decimal("engine_displacement", { precision: 6, scale: 2 }),
  engineDisplacementUnit: text("engine_displacement_unit"),
  engineCylinders: integer("engine_cylinders"),
  engineConfiguration: text("engine_configuration"),
  fuelType: text("fuel_type"),
  transmission: text("transmission"),
  transmissionSpeeds: integer("transmission_speeds"),
  drivetrain: text("drivetrain"),

  exteriorColor: text("exterior_color"),
  interiorColor: text("interior_color"),
  licensePlate: text("license_plate"),
  licensePlateState: text("license_plate_state"),

  ownershipType: vehicleOwnershipTypeEnum("ownership_type"),
  isFleet: boolean("is_fleet").notNull().default(false),
  fleetId: text("fleet_id"),
  fleetUnitNumber: text("fleet_unit_number"),

  currentOdometer: integer("current_odometer"),
  odometerUnit: distanceUnitEnum("odometer_unit").notNull().default("miles"),
  odometerHistory: jsonb("odometer_history").notNull().default(sql`'[]'::jsonb`),
  estimatedAnnualMileage: integer("estimated_annual_mileage"),

  purchaseDate: timestamp("purchase_date"),
  inServiceDate: timestamp("in_service_date"),
  warrantyExpirationDate: timestamp("warranty_expiration_date"),
  warrantyExpirationMileage: integer("warranty_expiration_mileage"),

  telematicsProvider: text("telematics_provider"),
  telematicsDeviceId: text("telematics_device_id"),

  notes: text("notes"),
  tags: jsonb("tags").notNull().default(sql`'[]'::jsonb`),
  customFields: jsonb("custom_fields").notNull().default(sql`'{}'::jsonb`),

  customerIds: jsonb("customer_ids").notNull().default(sql`'[]'::jsonb`),
  primaryCustomerId: text("primary_customer_id"),

  lastServiceDate: timestamp("last_service_date"),
  lastServiceMileage: integer("last_service_mileage"),
  totalServicesCount: integer("total_services_count").notNull().default(0),
  totalServicesAmount: decimal("total_services_amount", { precision: 12, scale: 2 }).notNull().default("0"),

  rawData: jsonb("raw_data"),

  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (table) => ({
  shopIdVinIdx: uniqueIndex("nv_shop_id_vin_idx").on(table.shopId, table.vin),
  enterpriseIdIdx: index("nv_enterprise_id_idx").on(table.enterpriseId),
  vinIdx: index("nv_vin_idx").on(table.vin),
  makeModelYearIdx: index("nv_make_model_year_idx").on(table.make, table.model, table.year),
  contentHashIdx: index("nv_content_hash_idx").on(sql`(provenance->>'contentHash')`),
  sourceSystemIdx: index("nv_source_system_idx").on(sql`(provenance->>'sourceSystem')`),
  createdAtIdx: index("nv_created_at_idx").on(table.createdAt),
  updatedAtIdx: index("nv_updated_at_idx").on(table.updatedAt),
}));

export const normalizedCustomers = pgTable("normalized_customers", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  enterpriseId: text("enterprise_id"),
  shopId: integer("shop_id").notNull(),
  locationId: text("location_id"),

  provenance: jsonb("provenance").notNull(),
  softDelete: jsonb("soft_delete").notNull().default(sql`'{"isDeleted":false}'::jsonb`),
  version: integer("version").notNull().default(1),

  customerType: customerTypeEnum("customer_type").notNull().default("individual"),

  firstName: text("first_name"),
  lastName: text("last_name"),
  fullName: text("full_name"),
  companyName: text("company_name"),

  contacts: jsonb("contacts").notNull().default(sql`'[]'::jsonb`),
  primaryContactId: text("primary_contact_id"),

  billingAddress: jsonb("billing_address"),
  mailingAddress: jsonb("mailing_address"),

  taxExempt: boolean("tax_exempt").notNull().default(false),
  taxExemptNumber: text("tax_exempt_number"),

  accountNumber: text("account_number"),
  arBalance: decimal("ar_balance", { precision: 12, scale: 2 }).notNull().default("0"),
  creditLimit: decimal("credit_limit", { precision: 12, scale: 2 }),
  paymentTerms: text("payment_terms"),
  defaultPaymentMethod: paymentMethodEnum("default_payment_method"),

  marketingConsent: boolean("marketing_consent").notNull().default(false),
  marketingConsentDate: timestamp("marketing_consent_date"),
  smsConsent: boolean("sms_consent").notNull().default(false),
  smsConsentDate: timestamp("sms_consent_date"),
  emailConsent: boolean("email_consent").notNull().default(false),
  emailConsentDate: timestamp("email_consent_date"),

  referralSource: text("referral_source"),
  acquisitionDate: timestamp("acquisition_date"),

  notes: text("notes"),
  internalNotes: text("internal_notes"),
  tags: jsonb("tags").notNull().default(sql`'[]'::jsonb`),
  customFields: jsonb("custom_fields").notNull().default(sql`'{}'::jsonb`),

  vehicleIds: jsonb("vehicle_ids").notNull().default(sql`'[]'::jsonb`),

  totalVisits: integer("total_visits").notNull().default(0),
  totalSpent: decimal("total_spent", { precision: 12, scale: 2 }).notNull().default("0"),
  averageTicket: decimal("average_ticket", { precision: 12, scale: 2 }).notNull().default("0"),
  lastVisitDate: timestamp("last_visit_date"),

  loyaltyPoints: integer("loyalty_points"),
  loyaltyTier: text("loyalty_tier"),

  dedupeKey: text("dedupe_key"),

  rawData: jsonb("raw_data"),

  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (table) => ({
  shopIdIdx: index("nc_shop_id_idx").on(table.shopId),
  enterpriseIdIdx: index("nc_enterprise_id_idx").on(table.enterpriseId),
  fullNameIdx: index("nc_full_name_idx").on(table.fullName),
  companyNameIdx: index("nc_company_name_idx").on(table.companyName),
  dedupeKeyIdx: index("nc_dedupe_key_idx").on(table.dedupeKey),
  contentHashIdx: index("nc_content_hash_idx").on(sql`(provenance->>'contentHash')`),
  sourceSystemIdx: index("nc_source_system_idx").on(sql`(provenance->>'sourceSystem')`),
  createdAtIdx: index("nc_created_at_idx").on(table.createdAt),
  updatedAtIdx: index("nc_updated_at_idx").on(table.updatedAt),
}));

export const normalizedWorkOrders = pgTable("normalized_work_orders", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  enterpriseId: text("enterprise_id"),
  shopId: integer("shop_id").notNull(),
  locationId: text("location_id"),

  provenance: jsonb("provenance").notNull(),
  softDelete: jsonb("soft_delete").notNull().default(sql`'{"isDeleted":false}'::jsonb`),
  version: integer("version").notNull().default(1),

  workOrderNumber: text("work_order_number").notNull(),
  workOrderType: workOrderTypeEnum("work_order_type").notNull().default("repair"),
  status: workOrderStatusEnum("status").notNull().default("draft"),
  statusHistory: jsonb("status_history").notNull().default(sql`'[]'::jsonb`),

  vehicleId: text("vehicle_id").notNull(),
  vehicle: jsonb("vehicle").notNull(),

  customerId: text("customer_id"),
  customer: jsonb("customer"),

  odometerIn: integer("odometer_in"),
  odometerOut: integer("odometer_out"),
  odometerUnit: distanceUnitEnum("odometer_unit").notNull().default("miles"),

  promisedDate: timestamp("promised_date"),
  promisedTime: text("promised_time"),
  dueDate: timestamp("due_date"),

  checkInDate: timestamp("check_in_date"),
  checkInTime: text("check_in_time"),
  checkInBy: text("check_in_by"),

  startedDate: timestamp("started_date"),
  completedDate: timestamp("completed_date"),
  closedDate: timestamp("closed_date"),

  serviceAdvisorId: text("service_advisor_id"),
  serviceAdvisorName: text("service_advisor_name"),

  technicians: jsonb("technicians").notNull().default(sql`'[]'::jsonb`),

  customerConcern: text("customer_concern"),
  technicianNotes: text("technician_notes"),
  internalNotes: text("internal_notes"),

  subtotal: decimal("subtotal", { precision: 12, scale: 2 }).notNull().default("0"),
  taxTotal: decimal("tax_total", { precision: 12, scale: 2 }).notNull().default("0"),
  discountTotal: decimal("discount_total", { precision: 12, scale: 2 }).notNull().default("0"),
  grandTotal: decimal("grand_total", { precision: 12, scale: 2 }).notNull().default("0"),

  laborTotal: decimal("labor_total", { precision: 12, scale: 2 }).notNull().default("0"),
  partsTotal: decimal("parts_total", { precision: 12, scale: 2 }).notNull().default("0"),
  subletTotal: decimal("sublet_total", { precision: 12, scale: 2 }).notNull().default("0"),
  feesTotal: decimal("fees_total", { precision: 12, scale: 2 }).notNull().default("0"),

  laborHoursTotal: decimal("labor_hours_total", { precision: 8, scale: 2 }).notNull().default("0"),
  laborHoursBilled: decimal("labor_hours_billed", { precision: 8, scale: 2 }).notNull().default("0"),

  payments: jsonb("payments").notNull().default(sql`'[]'::jsonb`),
  balanceDue: decimal("balance_due", { precision: 12, scale: 2 }).notNull().default("0"),

  isWarranty: boolean("is_warranty").notNull().default(false),
  isInternal: boolean("is_internal").notNull().default(false),
  isComeback: boolean("is_comeback").notNull().default(false),
  comebackFromWorkOrderId: text("comeback_from_work_order_id"),

  appointmentId: text("appointment_id"),

  authorizedBy: text("authorized_by"),
  authorizedAt: timestamp("authorized_at"),
  authorizedMethod: text("authorized_method"),

  tags: jsonb("tags").notNull().default(sql`'[]'::jsonb`),
  customFields: jsonb("custom_fields").notNull().default(sql`'{}'::jsonb`),

  rawData: jsonb("raw_data"),

  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (table) => ({
  shopIdWoNumIdx: uniqueIndex("nwo_shop_id_wo_num_idx").on(table.shopId, table.workOrderNumber),
  enterpriseIdIdx: index("nwo_enterprise_id_idx").on(table.enterpriseId),
  vehicleIdIdx: index("nwo_vehicle_id_idx").on(table.vehicleId),
  customerIdIdx: index("nwo_customer_id_idx").on(table.customerId),
  statusIdx: index("nwo_status_idx").on(table.status),
  closedDateIdx: index("nwo_closed_date_idx").on(table.closedDate),
  contentHashIdx: index("nwo_content_hash_idx").on(sql`(provenance->>'contentHash')`),
  sourceSystemIdx: index("nwo_source_system_idx").on(sql`(provenance->>'sourceSystem')`),
  createdAtIdx: index("nwo_created_at_idx").on(table.createdAt),
  updatedAtIdx: index("nwo_updated_at_idx").on(table.updatedAt),
}));

export const normalizedServiceJobs = pgTable("normalized_service_jobs", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  enterpriseId: text("enterprise_id"),
  shopId: integer("shop_id").notNull(),
  locationId: text("location_id"),

  provenance: jsonb("provenance").notNull(),
  softDelete: jsonb("soft_delete").notNull().default(sql`'{"isDeleted":false}'::jsonb`),
  version: integer("version").notNull().default(1),

  workOrderId: varchar("work_order_id").notNull().references(() => normalizedWorkOrders.id),

  jobNumber: text("job_number"),
  sequence: integer("sequence").notNull().default(0),

  jobType: serviceJobTypeEnum("job_type").notNull().default("custom"),
  status: serviceJobStatusEnum("status").notNull().default("pending"),
  statusHistory: jsonb("status_history").notNull().default(sql`'[]'::jsonb`),

  title: text("title").notNull(),
  description: text("description"),

  cannedJobId: text("canned_job_id"),
  cannedJobCode: text("canned_job_code"),
  cannedJobName: text("canned_job_name"),

  laborOperationCodes: jsonb("labor_operation_codes").notNull().default(sql`'[]'::jsonb`),

  technicianId: text("technician_id"),
  technicianName: text("technician_name"),

  laborTotal: decimal("labor_total", { precision: 12, scale: 2 }).notNull().default("0"),
  partsTotal: decimal("parts_total", { precision: 12, scale: 2 }).notNull().default("0"),
  subletTotal: decimal("sublet_total", { precision: 12, scale: 2 }).notNull().default("0"),
  feesTotal: decimal("fees_total", { precision: 12, scale: 2 }).notNull().default("0"),
  discountTotal: decimal("discount_total", { precision: 12, scale: 2 }).notNull().default("0"),
  total: decimal("total", { precision: 12, scale: 2 }).notNull().default("0"),

  laborHoursEstimated: decimal("labor_hours_estimated", { precision: 8, scale: 2 }),
  laborHoursActual: decimal("labor_hours_actual", { precision: 8, scale: 2 }),
  laborHoursBilled: decimal("labor_hours_billed", { precision: 8, scale: 2 }),

  isWarranty: boolean("is_warranty").notNull().default(false),
  warrantyClaimId: text("warranty_claim_id"),

  isSublet: boolean("is_sublet").notNull().default(false),
  subletVendor: text("sublet_vendor"),
  subletCost: decimal("sublet_cost", { precision: 12, scale: 2 }),

  technicianNotes: text("technician_notes"),
  advisorNotes: text("advisor_notes"),

  authorizedAt: timestamp("authorized_at"),
  authorizedBy: text("authorized_by"),
  declinedAt: timestamp("declined_at"),
  declinedBy: text("declined_by"),
  declineReason: text("decline_reason"),

  startedAt: timestamp("started_at"),
  completedAt: timestamp("completed_at"),

  inspectionId: text("inspection_id"),
  recommendationId: text("recommendation_id"),

  componentsCodes: jsonb("components_codes").notNull().default(sql`'[]'::jsonb`),

  tags: jsonb("tags").notNull().default(sql`'[]'::jsonb`),
  customFields: jsonb("custom_fields").notNull().default(sql`'{}'::jsonb`),

  rawData: jsonb("raw_data"),

  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (table) => ({
  workOrderIdIdx: index("nsj_work_order_id_idx").on(table.workOrderId),
  workOrderSeqIdx: index("nsj_work_order_seq_idx").on(table.workOrderId, table.sequence),
  shopIdIdx: index("nsj_shop_id_idx").on(table.shopId),
  enterpriseIdIdx: index("nsj_enterprise_id_idx").on(table.enterpriseId),
  cannedJobCodeIdx: index("nsj_canned_job_code_idx").on(table.cannedJobCode),
  contentHashIdx: index("nsj_content_hash_idx").on(sql`(provenance->>'contentHash')`),
  sourceSystemIdx: index("nsj_source_system_idx").on(sql`(provenance->>'sourceSystem')`),
  createdAtIdx: index("nsj_created_at_idx").on(table.createdAt),
  updatedAtIdx: index("nsj_updated_at_idx").on(table.updatedAt),
}));

export const normalizedLineItems = pgTable("normalized_line_items", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  enterpriseId: text("enterprise_id"),
  shopId: integer("shop_id").notNull(),
  locationId: text("location_id"),

  provenance: jsonb("provenance").notNull(),
  softDelete: jsonb("soft_delete").notNull().default(sql`'{"isDeleted":false}'::jsonb`),
  version: integer("version").notNull().default(1),

  workOrderId: varchar("work_order_id").notNull().references(() => normalizedWorkOrders.id),
  serviceJobId: varchar("service_job_id").notNull().references(() => normalizedServiceJobs.id),

  lineNumber: integer("line_number").notNull(),
  lineType: lineItemTypeEnum("line_type").notNull(),

  partId: text("part_id"),
  partNumber: text("part_number"),
  partDescription: text("part_description").notNull(),
  partBrand: text("part_brand"),
  partManufacturer: text("part_manufacturer"),
  partCondition: partConditionEnum("part_condition"),

  quantity: decimal("quantity", { precision: 10, scale: 3 }).notNull().default("1"),
  quantityUnit: text("quantity_unit").notNull().default("each"),

  unitCost: decimal("unit_cost", { precision: 12, scale: 2 }).notNull().default("0"),
  unitPrice: decimal("unit_price", { precision: 12, scale: 2 }).notNull().default("0"),
  extendedPrice: decimal("extended_price", { precision: 12, scale: 2 }).notNull().default("0"),

  discountPercent: decimal("discount_percent", { precision: 5, scale: 2 }),
  discountAmount: decimal("discount_amount", { precision: 12, scale: 2 }),

  taxable: boolean("taxable").notNull().default(true),
  taxRate: decimal("tax_rate", { precision: 6, scale: 4 }),
  taxAmount: decimal("tax_amount", { precision: 12, scale: 2 }),

  laborType: laborTypeEnum("labor_type"),
  laborHours: decimal("labor_hours", { precision: 8, scale: 2 }),
  laborRate: decimal("labor_rate", { precision: 12, scale: 2 }),

  technicianId: text("technician_id"),
  technicianName: text("technician_name"),

  vendorId: text("vendor_id"),
  vendorName: text("vendor_name"),
  vendorPartNumber: text("vendor_part_number"),
  vendorCost: decimal("vendor_cost", { precision: 12, scale: 2 }),

  coreCharge: decimal("core_charge", { precision: 12, scale: 2 }),
  coreReturned: boolean("core_returned").notNull().default(false),
  coreReturnedDate: timestamp("core_returned_date"),

  warrantyEligible: boolean("warranty_eligible").notNull().default(false),
  warrantyClaimId: text("warranty_claim_id"),

  serialNumber: text("serial_number"),
  lotNumber: text("lot_number"),
  expirationDate: timestamp("expiration_date"),

  installedComponentId: text("installed_component_id"),
  removedComponentId: text("removed_component_id"),

  notes: text("notes"),
  internalNotes: text("internal_notes"),

  orderStatus: partOrderStatusEnum("order_status"),
  orderedAt: timestamp("ordered_at"),
  receivedAt: timestamp("received_at"),

  customFields: jsonb("custom_fields").notNull().default(sql`'{}'::jsonb`),

  rawData: jsonb("raw_data"),

  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (table) => ({
  workOrderIdIdx: index("nli_work_order_id_idx").on(table.workOrderId),
  serviceJobIdIdx: index("nli_service_job_id_idx").on(table.serviceJobId),
  shopIdIdx: index("nli_shop_id_idx").on(table.shopId),
  enterpriseIdIdx: index("nli_enterprise_id_idx").on(table.enterpriseId),
  partNumberIdx: index("nli_part_number_idx").on(table.partNumber),
  lineTypeIdx: index("nli_line_type_idx").on(table.lineType),
  contentHashIdx: index("nli_content_hash_idx").on(sql`(provenance->>'contentHash')`),
  sourceSystemIdx: index("nli_source_system_idx").on(sql`(provenance->>'sourceSystem')`),
  createdAtIdx: index("nli_created_at_idx").on(table.createdAt),
  updatedAtIdx: index("nli_updated_at_idx").on(table.updatedAt),
}));

export const normalizedPayments = pgTable("normalized_payments", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  enterpriseId: text("enterprise_id"),
  shopId: integer("shop_id").notNull(),
  locationId: text("location_id"),

  provenance: jsonb("provenance").notNull(),
  softDelete: jsonb("soft_delete").notNull().default(sql`'{"isDeleted":false}'::jsonb`),
  version: integer("version").notNull().default(1),

  workOrderId: varchar("work_order_id").notNull().references(() => normalizedWorkOrders.id),
  invoiceId: text("invoice_id"),

  paymentNumber: text("payment_number"),

  status: paymentStatusEnum("status").notNull().default("pending"),

  method: paymentMethodEnum("method").notNull(),

  amount: decimal("amount", { precision: 12, scale: 2 }).notNull(),
  tipAmount: decimal("tip_amount", { precision: 12, scale: 2 }),

  processedAt: timestamp("processed_at"),

  cardBrand: text("card_brand"),
  cardLast4: text("card_last4"),
  cardExpiry: text("card_expiry"),

  checkNumber: text("check_number"),

  authorizationCode: text("authorization_code"),
  transactionId: text("transaction_id"),
  referenceNumber: text("reference_number"),

  processorName: text("processor_name"),
  processorResponse: text("processor_response"),

  refundedAmount: decimal("refunded_amount", { precision: 12, scale: 2 }),
  refundedAt: timestamp("refunded_at"),
  refundReason: text("refund_reason"),

  notes: text("notes"),

  customFields: jsonb("custom_fields").notNull().default(sql`'{}'::jsonb`),

  rawData: jsonb("raw_data"),

  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (table) => ({
  workOrderIdIdx: index("np_work_order_id_idx").on(table.workOrderId),
  shopIdIdx: index("np_shop_id_idx").on(table.shopId),
  enterpriseIdIdx: index("np_enterprise_id_idx").on(table.enterpriseId),
  statusIdx: index("np_status_idx").on(table.status),
  transactionIdIdx: index("np_transaction_id_idx").on(table.transactionId),
  processedAtIdx: index("np_processed_at_idx").on(table.processedAt),
  contentHashIdx: index("np_content_hash_idx").on(sql`(provenance->>'contentHash')`),
  sourceSystemIdx: index("np_source_system_idx").on(sql`(provenance->>'sourceSystem')`),
  createdAtIdx: index("np_created_at_idx").on(table.createdAt),
  updatedAtIdx: index("np_updated_at_idx").on(table.updatedAt),
}));

export type NormalizedVehicleRow = typeof normalizedVehicles.$inferSelect;
export type NormalizedCustomerRow = typeof normalizedCustomers.$inferSelect;
export type NormalizedWorkOrderRow = typeof normalizedWorkOrders.$inferSelect;
export type NormalizedServiceJobRow = typeof normalizedServiceJobs.$inferSelect;
export type NormalizedLineItemRow = typeof normalizedLineItems.$inferSelect;
export type NormalizedPaymentRow = typeof normalizedPayments.$inferSelect;
