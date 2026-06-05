// Shopmonkey API v3 type definitions.
//
// Shopmonkey's public API (https://api.shopmonkey.cloud/v3) returns most
// collection endpoints wrapped in a `{ success, data, error }` envelope and
// paginates with cursor/limit. Monetary amounts are returned in cents.
//
// These shapes are intentionally permissive (most fields optional) so the
// transform/adapter layers stay resilient to the parts of the payload a given
// endpoint includes — mirroring how the Tekmetric and Shop-Ware types are
// modeled. Field-name fallbacks for the same concept are handled in the
// transform/normalized-adapter, not here.

export interface ShopmonkeyEnvelope<T> {
  success?: boolean;
  data: T;
  error?: string | null;
}

export interface ShopmonkeyPaginatedResponse<T> {
  success?: boolean;
  data: T[];
  error?: string | null;
  meta?: {
    limit?: number;
    offset?: number;
    total?: number;
    cursor?: string | null;
    nextCursor?: string | null;
    hasMore?: boolean;
  };
}

export interface ShopmonkeyApiKeyStatus {
  valid?: boolean;
  companyId?: string;
  locationId?: string;
  name?: string;
  scopes?: string[];
}

export interface ShopmonkeyAddress {
  address1?: string | null;
  address2?: string | null;
  city?: string | null;
  state?: string | null;
  zip?: string | null;
  postalCode?: string | null;
  country?: string | null;
}

export interface ShopmonkeyPhoneNumber {
  number: string;
  type?: string | null;
  primary?: boolean;
}

export interface ShopmonkeyEmail {
  email: string;
  primary?: boolean;
  id?: string;
}

export interface ShopmonkeyCustomer {
  id: string;
  firstName?: string | null;
  lastName?: string | null;
  companyName?: string | null;
  // Live v3 returns emails as an array; `email` is kept only as a defensive
  // fallback for any single-email payload shape.
  emails?: ShopmonkeyEmail[];
  email?: string | null;
  phoneNumbers?: ShopmonkeyPhoneNumber[];
  // Live v3 returns address as FLAT fields on the customer (address1, city,
  // state, postalCode, country) rather than a nested object. The nested
  // `address` is kept as a defensive fallback.
  address?: ShopmonkeyAddress | null;
  address1?: string | null;
  address2?: string | null;
  city?: string | null;
  state?: string | null;
  zip?: string | null;
  postalCode?: string | null;
  country?: string | null;
  marketingOptIn?: boolean;
  smsOptIn?: boolean;
  emailOptIn?: boolean;
  taxExempt?: boolean;
  createdDate?: string;
  updatedDate?: string;
}

export interface ShopmonkeyVehicle {
  id: string;
  customerId?: string | null;
  vin?: string | null;
  year?: number | null;
  make?: string | null;
  model?: string | null;
  submodel?: string | null;
  subModel?: string | null;
  engine?: string | null;
  transmission?: string | null;
  color?: string | null;
  licensePlate?: string | null;
  licensePlateState?: string | null;
  mileage?: number | null;
  mileageIn?: number | null;
  mileageOut?: number | null;
  // Live v3 carries the odometer unit per-vehicle as "Mile"/"Kilometer".
  mileageUnit?: string | null;
  unitNumber?: string | null;
  fleet?: boolean;
  notes?: string | null;
  note?: string | null;
  createdDate?: string;
  updatedDate?: string;
}

export interface ShopmonkeyLabor {
  id: string;
  name?: string | null;
  description?: string | null;
  hours?: number | null;
  rateCents?: number | null;
  totalCents?: number | null;
  technicianName?: string | null;
}

export interface ShopmonkeyPart {
  id: string;
  name?: string | null;
  description?: string | null;
  partNumber?: string | null;
  brand?: string | null;
  manufacturer?: string | null;
  quantity?: number | null;
  costCents?: number | null;
  retailCents?: number | null;
  totalCents?: number | null;
}

export interface ShopmonkeyService {
  id: string;
  name?: string | null;
  title?: string | null;
  note?: string | null;
  authorized?: boolean | null;
  declined?: boolean | null;
  sortOrder?: number | null;
  labors?: ShopmonkeyLabor[];
  parts?: ShopmonkeyPart[];
  laborCents?: number | null;
  partsCents?: number | null;
  subletCents?: number | null;
  discountCents?: number | null;
  totalCents?: number | null;
}

export interface ShopmonkeyPayment {
  id: string;
  amountCents?: number | null;
  method?: string | null;
  type?: string | null;
  status?: string | null;
  cardBrand?: string | null;
  cardLast4?: string | null;
  checkNumber?: string | null;
  paymentDate?: string | null;
  createdDate?: string | null;
}

export interface ShopmonkeyLabel {
  id?: string;
  text?: string | null;
  colorCode?: string | null;
}

/**
 * A single order line item from the live `/service_item` endpoint. Shopmonkey
 * v3 does NOT embed labor/part arrays inside the order; line items are flat
 * records fetched separately (filtered by `customerId`/`vehicleId` via a
 * `where` clause) and linked back to their order via the nested `order` object.
 * All monetary amounts are in cents and may be fractional.
 */
export interface ShopmonkeyServiceItem {
  id: string;
  type?: string | null; // "labor" | "part" | "tire" | "fee" | "subcontract"
  name?: string | null;
  note?: string | null;
  completed?: boolean | null;
  // Labor
  hours?: number | null;
  laborRateCents?: number | null;
  // Parts
  quantity?: number | null;
  partNumber?: string | null;
  brand?: string | null;
  retailCostCents?: number | null; // per-unit retail price (cents)
  vendor?: { name?: string | null } | null;
  // Pricing (cents)
  priceCents?: number | null; // extended price
  subtotalCents?: number | null;
  discountCents?: number | null;
  feeAmountCents?: number | null;
  feePercent?: number | null;
  feeType?: string | null;
  inventoryCategory?: string | null;
  tireModelName?: string | null;
  user?: { firstName?: string | null; lastName?: string | null } | null;
  // The order this line item belongs to (used to group items per order).
  order?: { id?: string | null; number?: string | number | null } | null;
}

export interface ShopmonkeyOrder {
  id: string;
  number?: number | null;
  invoiceNumber?: number | null;
  externalNumber?: string | null;
  name?: string | null;
  generatedName?: string | null;
  status?: string | null;
  label?: ShopmonkeyLabel | null;
  labels?: ShopmonkeyLabel[] | null;
  customerId?: string | null;
  vehicleId?: string | null;
  customer?: ShopmonkeyCustomer | null;
  vehicle?: ShopmonkeyVehicle | null;
  // Not embedded by live v3 — populated by the client from `/service_item`.
  services?: ShopmonkeyService[];
  serviceItems?: ShopmonkeyServiceItem[];
  payments?: ShopmonkeyPayment[];
  mileage?: number | null;
  mileageIn?: number | null;
  mileageOut?: number | null;
  complaint?: string | null;
  customerConcern?: string | null;
  technicianNotes?: string | null;
  notes?: string | null;
  serviceWriterName?: string | null;
  // Live v3 money fields (all cents). There is no top-level `totalCents`;
  // the order grand total is `totalCostCents`.
  laborCents?: number | null;
  partsCents?: number | null;
  tiresCents?: number | null;
  subcontractsCents?: number | null;
  feesCents?: number | null;
  shopSuppliesCents?: number | null;
  epaCents?: number | null;
  taxCents?: number | null;
  gstCents?: number | null;
  pstCents?: number | null;
  hstCents?: number | null;
  discountCents?: number | null;
  appliedDiscountCents?: number | null;
  totalCostCents?: number | null; // grand total
  paidCostCents?: number | null;
  remainingCostCents?: number | null; // balance due
  warranty?: boolean;
  internal?: boolean;
  archived?: boolean;
  createdDate?: string;
  orderCreatedDate?: string;
  updatedDate?: string;
  authorizedDate?: string;
  completedDate?: string;
  invoicedDate?: string;
  fullyPaidDate?: string;
  closedDate?: string;
  postedDate?: string;
}

export interface ShopmonkeyCannedService {
  id: string;
  name?: string | null;
  code?: string | null;
  labors?: ShopmonkeyLabor[];
  parts?: ShopmonkeyPart[];
}

export interface ShopmonkeyCredentials {
  apiKey: string;
  locationId?: string | null;
  companyId?: string | null;
}
