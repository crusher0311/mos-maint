import { getDb } from "@/lib/mongo";
import type { AutoflowConfig, DviResult } from "./types";

type Fetcher = typeof fetch;

function toInt(val: any): number | null {
  if (val === null || val === undefined) return null;
  const n = Number(String(val).replace(/[^\d.-]/g, ""));
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

function nonEmpty(s: any): string | null {
  const t = s == null ? "" : String(s).trim();
  return t ? t : null;
}

function normalizeTime(s: any): string | null {
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

export async function resolveAutoflowConfig(shopId: number): Promise<AutoflowConfig> {
  const db = await getDb();
  const shop = await db.collection("shops").findOne(
    { shopId },
    {
      projection: {
        autoflow: 1,
        autoflowDomain: 1,
        autoflowApiKey: 1,
        autoflowApiPassword: 1,
      },
    }
  );

  const domainRaw =
    shop?.autoflowDomain ??
    shop?.autoflow?.domain ??
    shop?.autoflow?.subdomain ??
    process.env.AUTOFLOW_DOMAIN ??
    process.env.AUTOFLOW_SUBDOMAIN ??
    "";

  const apiKey =
    shop?.autoflowApiKey ??
    shop?.autoflow?.apiKey ??
    process.env.AUTOFLOW_API_KEY ??
    "";

  const apiPassword =
    shop?.autoflowApiPassword ??
    shop?.autoflow?.apiPassword ??
    process.env.AUTOFLOW_API_PASSWORD ??
    "";

  const domain = normalizeAutoflowDomain(domainRaw);
  const base = domain ? `https://${domain}` : "";
  const configured = Boolean(domain && apiKey && apiPassword);
  const subdomain = domain ? domain.split(".")[0] : "";

  return {
    base,
    domain,
    subdomain,
    apiKey: apiKey || null,
    apiPassword: apiPassword || null,
    configured,
  };
}

export async function fetchDviByInvoice(
  shopId: number,
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
  } catch (err: any) {
    console.error(`[AutoFlow] Network error fetching DVI for invoice ${inv}:`, err?.message || err);
    return { ok: false, error: `AutoFlow connection failed: ${err?.message || 'Network error'}` };
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    return { ok: false, error: `HTTP ${res.status}: ${text || res.statusText}` };
  }

  const json = await res.json().catch(() => null);
  if (!json || typeof json !== "object") return { ok: false, error: "Invalid JSON from AutoFlow." };
  const success = Number(json.success || 0) === 1;
  const content = json.content || {};
  if (!success) {
    return { ok: false, error: nonEmpty(json.message) || "AutoFlow returned success=0", raw: json };
  }

  const advisor = nonEmpty(content.service_advisor_name);
  const mileage = toInt(content.mileage);
  const vin = nonEmpty(content.vin);
  const shopUrl = nonEmpty(content.shop_url);
  const customerUrl = nonEmpty(content.customer_url);

  const hunter = Array.isArray(content.hunter_results)
    ? content.hunter_results.map((h: any) => ({
        vin: nonEmpty(h.vin),
        orderNumber: nonEmpty(h.order_number),
        odometer: toInt(h.odometer),
        url: nonEmpty(h.results_url),
        dateTime: nonEmpty(h.date_time),
      }))
    : null;

  const dvis = Array.isArray(content.dvis) ? content.dvis : [];
  const primary =
    dvis.find((d: any) => Array.isArray(d?.dvi_category) && d.dvi_category.length > 0) ||
    dvis.find((d: any) => normalizeTime(d?.completed_datetime)) || 
    dvis[0] || null;

  const sheetName = nonEmpty(primary?.dvi_name);
  const completedAt = normalizeTime(primary?.completed_datetime);
  const completedBy = nonEmpty(primary?.completed_by);
  const pdfUrl = nonEmpty(primary?.pdf_url);

  const rawCategories = primary?.dvi_category || primary?.categories || primary?.dvi_items || [];
  
  const categories = Array.isArray(rawCategories)
    ? rawCategories.map((c: any) => {
        const items = Array.isArray(c?.dvi_items)
          ? c.dvi_items.map((it: any) => {
              const status = it?.item_status ?? it?.status ?? null;

              let pictures: string[] | null = null;
              if (Array.isArray(it?.item_picture)) {
                pictures = it.item_picture.map((u: any) => nonEmpty(u)).filter(Boolean) as string[];
              } else if (nonEmpty(it?.image)) {
                pictures = [String(nonEmpty(it.image))];
              }

              const videos = Array.isArray(it?.item_video)
                ? it.item_video.map((u: any) => nonEmpty(u)).filter(Boolean) as string[]
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
              };
            })
          : null;

        return {
          categoryId: c?.category_id ?? null,
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

export async function testConnection(shopId: number): Promise<{ ok: boolean; error?: string }> {
  const config = await resolveAutoflowConfig(shopId);
  if (!config.configured) {
    return { ok: false, error: 'AutoFlow credentials not configured' };
  }
  return { ok: true };
}
