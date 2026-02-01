import "server-only";
import sql from "@/lib/db/postgres";

type Fetcher = typeof fetch;

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
  raw?: unknown;
  error?: string;
};

function toInt(val: unknown): number | null {
  if (val === null || val === undefined) return null;
  const n = Number(String(val).replace(/[^\d.-]/g, ""));
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

function nonEmpty(s: unknown): string | null {
  const t = s == null ? "" : String(s).trim();
  return t ? t : null;
}

function normalizeTime(s: unknown): string | null {
  const t = nonEmpty(s);
  if (!t) return null;
  if (/^0{4}-0{2}-0{2}T0{2}:0{2}:0{2}/.test(t)) return null;
  return t;
}

function basicAuthHeader(key: string, pwd: string) {
  const token = Buffer.from(`${key}:${pwd}`).toString("base64");
  return `Basic ${token}`;
}

function normalizeAutoflowDomain(input?: string | null): string {
  let d = (input ?? "").trim();
  if (!d) return "";
  d = d.replace(/^https?:\/\//i, "");
  d = d.replace(/\/.*$/, "");
  d = d.replace(/[./]+$/, "");
  if (d && !d.includes(".")) d = `${d}.autotext.me`;
  return d;
}

export async function resolveAutoflowConfig(shopId: number | string) {
  const shopIdStr = String(shopId);
  const result = await sql`
    SELECT settings FROM shops WHERE shop_id = ${shopIdStr} LIMIT 1
  `;

  const shop = result[0];
  const settings = shop?.settings as Record<string, unknown> | undefined;
  const autoflow = settings?.autoflow as Record<string, unknown> | undefined;

  const domainRaw =
    autoflow?.domain ??
    autoflow?.subdomain ??
    process.env.AUTOFLOW_DOMAIN ??
    process.env.AUTOFLOW_SUBDOMAIN ??
    "";

  const apiKey =
    autoflow?.apiKey ??
    process.env.AUTOFLOW_API_KEY ??
    "";

  const apiPassword =
    autoflow?.apiPassword ??
    process.env.AUTOFLOW_API_PASSWORD ??
    "";

  const domain = normalizeAutoflowDomain(domainRaw as string);
  const base = domain ? `https://${domain}` : "";
  const configured = Boolean(domain && apiKey && apiPassword);
  const subdomain = domain ? domain.split(".")[0] : "";

  console.log(`[AutoFlow Config] Shop ${shopId}: domain=${domain}, base=${base}, configured=${configured}`);
  
  return {
    base,
    domain,
    subdomain,
    apiKey: (apiKey as string) || null,
    apiPassword: (apiPassword as string) || null,
    configured,
  };
}

export async function fetchDviByInvoice(
  shopId: number | string,
  invoice: string | number,
  doFetch: Fetcher = fetch
): Promise<DviResult> {
  const cfg = await resolveAutoflowConfig(shopId);
  if (!cfg.configured) return { ok: false, error: "AutoFlow not configured for this shop." };

  const inv = nonEmpty(invoice);
  if (!inv) return { ok: false, error: "Missing invoice/RO." };

  const url = `${cfg.base}/api/v1/dvi/${encodeURIComponent(String(inv))}`;
  console.log(`[AutoFlow] Fetching DVI from: ${url}`);
  
  let res: Response;
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000);
    
    res = await doFetch(url, {
      headers: {
        Authorization: basicAuthHeader(String(cfg.apiKey), String(cfg.apiPassword)),
        accept: "application/json",
      },
      cache: "no-store",
      signal: controller.signal,
    });
    
    clearTimeout(timeoutId);
  } catch (err: unknown) {
    const error = err as { name?: string; message?: string };
    const isTimeout = error?.name === 'AbortError';
    const errorMsg = isTimeout ? 'Request timed out (10s)' : (error?.message || 'Network error');
    console.error(`[AutoFlow] ${isTimeout ? 'Timeout' : 'Network error'} fetching DVI for invoice ${inv} from ${cfg.domain}:`, errorMsg);
    return { ok: false, error: `AutoFlow connection failed: ${errorMsg}` };
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    return { ok: false, error: `HTTP ${res.status}: ${text || res.statusText}` };
  }

  const json = await res.json().catch(() => null) as Record<string, unknown> | null;
  if (!json || typeof json !== "object") return { ok: false, error: "Invalid JSON from AutoFlow." };
  
  const success = Number(json.success || 0) === 1;
  const content = (json.content || {}) as Record<string, unknown>;
  if (!success) {
    return { ok: false, error: nonEmpty(json.message) || "AutoFlow returned success=0", raw: json };
  }

  const advisor = nonEmpty(content.service_advisor_name);
  const mileage = toInt(content.mileage);
  const vin = nonEmpty(content.vin);
  const shopUrl = nonEmpty(content.shop_url);
  const customerUrl = nonEmpty(content.customer_url);

  const hunterResults = content.hunter_results as Record<string, unknown>[] | undefined;
  const hunter = Array.isArray(hunterResults)
    ? hunterResults.map((h) => ({
        vin: nonEmpty(h.vin),
        orderNumber: nonEmpty(h.order_number),
        odometer: toInt(h.odometer),
        url: nonEmpty(h.results_url),
        dateTime: nonEmpty(h.date_time),
      }))
    : null;

  const dvis = Array.isArray(content.dvis) ? content.dvis as Record<string, unknown>[] : [];
  
  const primary =
    dvis.find((d) => Array.isArray(d?.dvi_category) && (d.dvi_category as unknown[]).length > 0) ||
    dvis.find((d) => normalizeTime(d?.completed_datetime)) || 
    dvis[0] || null;

  const sheetName = nonEmpty(primary?.dvi_name);
  const completedAt = normalizeTime(primary?.completed_datetime);
  const completedBy = nonEmpty(primary?.completed_by);
  const pdfUrl = nonEmpty(primary?.pdf_url);

  const rawCategories = (primary?.dvi_category || primary?.categories || primary?.dvi_items || []) as Record<string, unknown>[];
  
  const categories = Array.isArray(rawCategories)
    ? rawCategories.map((c) => {
        const dviItems = c?.dvi_items as Record<string, unknown>[] | undefined;
        const items = Array.isArray(dviItems)
          ? dviItems.map((it) => {
              const status = it?.item_status ?? it?.status ?? null;

              let pictures: string[] | null = null;
              const itemPicture = it?.item_picture as unknown[] | undefined;
              if (Array.isArray(itemPicture)) {
                pictures = itemPicture.map((u) => nonEmpty(u)).filter(Boolean) as string[];
              } else if (nonEmpty(it?.image)) {
                pictures = [String(nonEmpty(it.image))];
              }

              const itemVideo = it?.item_video as unknown[] | undefined;
              const videos = Array.isArray(itemVideo)
                ? itemVideo.map((u) => nonEmpty(u)).filter(Boolean) as string[]
                : null;

              const extras: string[] = [];
              const oe = nonEmpty(it?.oe);
              const actual = nonEmpty(it?.actual);
              const tread = nonEmpty(it?.threaddepth);
              const psiBefore = nonEmpty(it?.psi_before);
              const psiAfter = nonEmpty(it?.psi_after);
              if (oe || actual) extras.push(`Size: ${oe || "-" } → ${actual || "-"}`);
              if (tread) extras.push(`Tread: ${tread}/32"`);
              if (psiBefore || psiAfter) extras.push(`PSI: ${psiBefore || "-" } → ${psiAfter || "-"}`);

              const baseNotes = nonEmpty(it?.item_notes) || nonEmpty(it?.notes);
              const combinedNotes = [baseNotes, extras.length ? extras.join(" • ") : null]
                .filter(Boolean)
                .join("\n");

              return {
                itemId: it?.item_id ?? null,
                name: nonEmpty(it?.item_name),
                status,
                notes: combinedNotes || null,
                pictures: pictures && pictures.length ? pictures : null,
                videos: videos && videos.length ? videos : null,
              } as DviItem;
            })
          : null;

        return {
          categoryId: c?.category_id ?? null,
          name: nonEmpty(c?.category_name),
          video: nonEmpty(c?.category_video),
          videoStatus: nonEmpty(c?.category_video_status),
          videoNotes: nonEmpty(c?.category_video_notes),
          items,
        } as DviCategory;
      })
    : null;

  return {
    ok: true,
    invoice: nonEmpty(content.invoice) || inv,
    vin: vin ?? null,
    mileage: mileage ?? null,
    advisor: advisor ?? null,
    technician: completedBy ?? null,
    sheetName: sheetName ?? null,
    timestamp: completedAt ?? null,
    pdfUrl: pdfUrl ?? null,
    shopUrl: shopUrl ?? null,
    customerUrl: customerUrl ?? null,
    hunter,
    categories,
    raw: json,
  };
}

export async function upsertDviSnapshot(
  shopId: number | string,
  roNumber: string | number,
  dvi: DviResult
) {
  const shopIdStr = String(shopId);
  const ro = String(roNumber);

  await sql`
    INSERT INTO dvi_results (shop_id, ro_number, fetched_at, vin, mileage, sheet_name, timestamp, advisor, technician,
      pdf_url, shop_url, customer_url, categories, hunter, ok, error, raw, source)
    VALUES (${shopIdStr}, ${ro}, NOW(), ${dvi.vin || null}, ${dvi.mileage || null}, ${dvi.sheetName || null},
      ${dvi.timestamp || null}, ${dvi.advisor || null}, ${dvi.technician || null}, ${dvi.pdfUrl || null},
      ${dvi.shopUrl || null}, ${dvi.customerUrl || null}, ${JSON.stringify(dvi.categories || null)}::jsonb,
      ${JSON.stringify(dvi.hunter || null)}::jsonb, ${dvi.ok}, ${dvi.error || null},
      ${JSON.stringify(dvi.raw || null)}::jsonb, 'autoflow')
    ON CONFLICT (shop_id, ro_number) DO UPDATE SET
      fetched_at = NOW(),
      vin = ${dvi.vin || null},
      mileage = ${dvi.mileage || null},
      sheet_name = ${dvi.sheetName || null},
      timestamp = ${dvi.timestamp || null},
      advisor = ${dvi.advisor || null},
      technician = ${dvi.technician || null},
      pdf_url = ${dvi.pdfUrl || null},
      shop_url = ${dvi.shopUrl || null},
      customer_url = ${dvi.customerUrl || null},
      categories = ${JSON.stringify(dvi.categories || null)}::jsonb,
      hunter = ${JSON.stringify(dvi.hunter || null)}::jsonb,
      ok = ${dvi.ok},
      error = ${dvi.error || null},
      raw = ${JSON.stringify(dvi.raw || null)}::jsonb
  `;
}

function snapshotToResult(doc: Record<string, unknown>): DviResult {
  if (!doc) return { ok: false, error: "No snapshot" };
  return {
    ok: !!doc.ok,
    invoice: doc.ro_number as string ?? null,
    vin: doc.vin as string ?? null,
    mileage: doc.mileage as number ?? null,
    advisor: doc.advisor as string ?? null,
    technician: doc.technician as string ?? null,
    sheetName: doc.sheet_name as string ?? null,
    timestamp: doc.timestamp as string ?? null,
    pdfUrl: doc.pdf_url as string ?? null,
    shopUrl: doc.shop_url as string ?? null,
    customerUrl: doc.customer_url as string ?? null,
    categories: doc.categories as DviCategory[] ?? null,
    hunter: doc.hunter as DviResult["hunter"] ?? null,
    raw: doc.raw ?? null,
    error: doc.error as string ?? null,
  };
}

export async function fetchDviWithCache(
  shopId: number | string,
  invoice: string | number,
  maxAgeMs = 10 * 60 * 1000,
  doFetch: Fetcher = fetch
): Promise<DviResult> {
  const shopIdStr = String(shopId);
  const ro = String(invoice);

  const result = await sql`
    SELECT * FROM dvi_results WHERE shop_id = ${shopIdStr} AND ro_number = ${ro} LIMIT 1
  `;
  const doc = result[0];

  const now = Date.now();
  const fresh = doc?.fetched_at ? now - new Date(doc.fetched_at as string).getTime() <= maxAgeMs : false;

  if (fresh) return snapshotToResult(doc);

  const live = await fetchDviByInvoice(shopId, invoice, doFetch);
  await upsertDviSnapshot(shopId, invoice, live);
  return live;
}
