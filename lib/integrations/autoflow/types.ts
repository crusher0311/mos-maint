export type DviItem = {
  itemId?: number | string | null;
  name?: string | null;
  status?: string | number | null;
  notes?: string | null;
  pictures?: string[] | null;
  videos?: string[] | null;
};

export type DviCategory = {
  categoryId?: number | string | null;
  name?: string | null;
  video?: string | null;
  videoStatus?: string | null;
  videoNotes?: string | null;
  items?: DviItem[] | null;
};

export type DviResult = {
  ok: boolean;
  invoice?: string | number | null;
  vin?: string | null;
  mileage?: number | null;
  advisor?: string | null;
  technician?: string | null;
  sheetName?: string | null;
  timestamp?: string | null;
  pdfUrl?: string | null;
  shopUrl?: string | null;
  customerUrl?: string | null;
  hunter?: {
    vin?: string | null;
    orderNumber?: string | null;
    odometer?: number | null;
    url?: string | null;
    dateTime?: string | null;
  }[] | null;
  categories?: DviCategory[] | null;
  raw?: any;
  error?: string;
};

export interface AutoflowConfig {
  base: string;
  domain: string;
  subdomain: string;
  apiKey: string | null;
  apiPassword: string | null;
  configured: boolean;
}
