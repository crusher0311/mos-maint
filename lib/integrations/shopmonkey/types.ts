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

export interface ShopmonkeyCustomer {
  id: string;
  firstName?: string | null;
  lastName?: string | null;
  companyName?: string | null;
  email?: string | null;
  phoneNumbers?: ShopmonkeyPhoneNumber[];
  address?: ShopmonkeyAddress | null;
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
  unitNumber?: string | null;
  fleet?: boolean;
  notes?: string | null;
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

export interface ShopmonkeyOrder {
  id: string;
  number?: number | null;
  invoiceNumber?: number | null;
  status?: string | null;
  label?: ShopmonkeyLabel | null;
  customerId?: string | null;
  vehicleId?: string | null;
  customer?: ShopmonkeyCustomer | null;
  vehicle?: ShopmonkeyVehicle | null;
  services?: ShopmonkeyService[];
  payments?: ShopmonkeyPayment[];
  mileage?: number | null;
  mileageIn?: number | null;
  mileageOut?: number | null;
  customerConcern?: string | null;
  technicianNotes?: string | null;
  notes?: string | null;
  serviceWriterName?: string | null;
  laborTotalCents?: number | null;
  partsTotalCents?: number | null;
  subletTotalCents?: number | null;
  feesTotalCents?: number | null;
  taxTotalCents?: number | null;
  discountTotalCents?: number | null;
  totalCents?: number | null;
  balanceDueCents?: number | null;
  warranty?: boolean;
  internal?: boolean;
  createdDate?: string;
  updatedDate?: string;
  completedDate?: string;
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
