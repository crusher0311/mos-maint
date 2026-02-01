import sql from "@/lib/db/postgres";
import type { AutoflowConfig, DviResult } from "./types";

type Fetcher = typeof fetch;

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

export async function resolveAutoflowConfig(shopId: number | string): Promise<AutoflowConfig> {
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
  
  let res: Response;
  try {
    res = await doFetch(url, {
      headers: {
        Authorization: basicAuthHeader(String(cfg.apiKey), String(cfg.apiPassword)),
        accept: "application/json",
      },
      cache: "no-store",
    });
  } catch (err: unknown) {
    const error = err as { message?: string };
    console.error(`[AutoFlow] Network error fetching DVI for invoice ${inv}:`, error?.message || err);
    return { ok: false, error: `AutoFlow connection failed: ${error?.message || 'Network error'}` };
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
                itemId: (it?.item_id ?? null) as string | number | null,
                name: nonEmpty(it?.item_name),
                status: status as string | number | null,
                notes: combinedNotes || null,
                pictures: pictures && pictures.length ? pictures : null,
                videos: videos && videos.length ? videos : null,
              };
            })
          : null;

        return {
          categoryId: (c?.category_id ?? null) as string | number | null,
          name: nonEmpty(c?.category_name),
          video: nonEmpty(c?.category_video),
          videoStatus: nonEmpty(c?.category_video_status),
          videoNotes: nonEmpty(c?.category_video_notes),
          items,
        };
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

export async function testConnection(shopId: number | string): Promise<{ ok: boolean; error?: string }> {
  const config = await resolveAutoflowConfig(shopId);
  if (!config.configured) {
    return { ok: false, error: 'AutoFlow credentials not configured' };
  }
  return { ok: true };
}
