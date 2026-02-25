export interface ShopWarePaginatedResponse<T> {
  results: T[];
  limit: number;
  limited: boolean;
  total_count: number;
  current_page: number;
  total_pages: number;
}

export interface ShopWareIntegratorTag {
  id: number;
  taggable_type: string;
  taggable_id: number;
  name: string;
  value: string;
  created_at: string;
  updated_at: string;
}

export interface ShopWareTenant {
  id: number;
  cname: string;
  name: string;
  country_code: string;
  subscription_status: 'Active' | 'Canceled';
  created_at: string;
  updated_at: string;
}

export interface ShopWareShop {
  id: number;
  tenant_id: number;
  name: string;
  phone?: string | null;
  email?: string | null;
  address?: string | null;
  city?: string | null;
  state?: string | null;
  zip?: string | null;
  country?: string | null;
  timezone?: string | null;
  active: boolean;
  integrator_tags?: ShopWareIntegratorTag[];
  created_at: string;
  updated_at: string;
}

export interface ShopWareCustomer {
  id: number;
  first_name: string;
  last_name: string;
  email?: string | null;
  phone_1?: string | null;
  phone_1_type?: string | null;
  phone_2?: string | null;
  phone_2_type?: string | null;
  phone_3?: string | null;
  phone_3_type?: string | null;
  address?: string | null;
  city?: string | null;
  state?: string | null;
  zip?: string | null;
  preferred_contact_type?: string | null;
  notes?: string | null;
  shop_id: number;
  integrator_tags?: ShopWareIntegratorTag[];
  created_at: string;
  updated_at: string;
}

export interface ShopWareVehicle {
  id: number;
  year: string;
  make: string;
  model: string;
  submodel?: string | null;
  engine?: string | null;
  trim?: string | null;
  vin?: string | null;
  plate?: string | null;
  plate_state?: string | null;
  color?: string | null;
  unit_number?: string | null;
  notes?: string | null;
  detail?: string | null;
  fleet_number?: string | null;
  customer_ids: number[];
  integrator_tags?: ShopWareIntegratorTag[];
  created_at: string;
  updated_at: string;
}

export interface ShopWareLabor {
  id: number;
  name: string;
  technician_id?: number | null;
  hours: number;
  taxable: boolean;
  row_order: number;
}

export interface ShopWarePart {
  id: number;
  brand?: string | null;
  description: string;
  number?: string | null;
  sell_price_cents: number;
  cost_cents?: number | null;
  part_inventory_id?: number | null;
  taxable: boolean;
  quantity: number;
  quantity_needed?: number | null;
}

export interface ShopWareHazmat {
  id: number;
  name: string;
  fee_cents: number;
  taxable: boolean;
  quantity: number;
}

export interface ShopWareSublet {
  id: number;
  name: string;
  price_cents: number;
  cost_cents?: number | null;
  provider?: string | null;
  invoice_number?: string | null;
  description?: string | null;
  taxable: boolean;
  vendor_id?: number | null;
  invoice_date?: string | null;
}

export interface ShopWareInspection {
  id: number;
  name: string;
  state: 'red' | 'yellow' | 'green' | 'unchecked';
}

export interface ShopWareService {
  id: number;
  title: string;
  category_id?: number | null;
  canned_job_id?: number | null;
  completed: boolean;
  completed_at?: string | null;
  last_completed_at?: string | null;
  row_order: number;
  is_fixed_price_service: boolean;
  fixed_price_cents?: number | null;
  fixed_price_labor_total_cents?: number | null;
  labor_rate_cents?: number | null;
  comment?: string | null;
  labors: ShopWareLabor[];
  parts: ShopWarePart[];
  hazmats: ShopWareHazmat[];
  sublets: ShopWareSublet[];
  inspections: ShopWareInspection[];
}

export interface ShopWarePayment {
  id: number;
  amount_cents: number;
  payment_type?: string | null;
  note?: string | null;
  created_at: string;
  updated_at: string;
}

export interface ShopWareLabel {
  id: number;
  text: string;
  color_code: string;
  row_order: number;
}

export interface ShopWareRepairOrder {
  id: number;
  number: number;
  state: 'estimate' | 'in_progress' | 'invoice';
  shop_id: number;
  customer_id?: number | null;
  vehicle_id?: number | null;
  technician_id?: number | null;
  advisor_id?: number | null;
  status_id?: number | null;
  odometer?: number | null;
  odometer_out?: number | null;
  detail?: string | null;
  customer_concern?: string | null;
  vehicle_use?: string | null;
  customer_source?: string | null;
  preferred_contact_type?: string | null;
  fleet_po?: string | null;
  supply_fee_cents?: number | null;
  taxable?: boolean;
  part_tax_rate?: number;
  labor_tax_rate?: number;
  sublet_tax_rate?: number;
  hazmat_tax_rate?: number;
  part_discount_cents?: number | null;
  labor_discount_cents?: number | null;
  part_discount_percentage?: number | null;
  labor_discount_percentage?: number | null;
  started_at?: string | null;
  closed_at?: string | null;
  picked_up_at?: string | null;
  due_in_at?: string | null;
  due_out_at?: string | null;
  label?: ShopWareLabel | null;
  services?: ShopWareService[];
  payments?: ShopWarePayment[];
  customer?: ShopWareCustomer;
  vehicle?: ShopWareVehicle;
  integrator_tags?: ShopWareIntegratorTag[];
  created_at: string;
  updated_at: string;
}

export interface ShopWareCannedJob {
  id: number;
  name: string;
  code?: string | null;
  labor_rate_cents?: number | null;
  is_fixed_price_service?: boolean;
  fixed_price_cents?: number | null;
  shop_id: number;
  integrator_tags?: ShopWareIntegratorTag[];
  created_at: string;
  updated_at: string;
}

export interface ShopWareRecommendation {
  id: number;
  repair_order_id: number;
  canned_job_id?: number | null;
  description: string;
  approved: string;
  note?: string | null;
  integrator_tags?: ShopWareIntegratorTag[];
  created_at: string;
  updated_at: string;
}

export interface ShopWarePastRecommendation {
  id: number;
  vehicle_id: number;
  canned_job_id?: number | null;
  description: string;
  note?: string | null;
  repair_order_id?: number | null;
  integrator_tags?: ShopWareIntegratorTag[];
  created_at: string;
  updated_at: string;
}

export interface ShopWareCredentials {
  tenantId: number;
  swShopId: number;
}
