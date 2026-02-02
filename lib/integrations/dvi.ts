// lib/integrations/dvi.ts
import { getDb } from "@/lib/mongo";

/** Heuristic base64 decoder: if it looks like base64, decode; else return as-is */
function maybeDecodeBase64(s?: string | null): string {
  if (!s) return "";
  const looksB64 = /^[A-Za-z0-9+/]+={0,2}$/.test(s) && s.length % 4 === 0;
  if (!looksB64) return s;
  try {
    const buf = Buffer.from(s, "base64");
    const txt = buf.toString("utf8");
    if (Buffer.from(txt, "utf8").toString("base64") === s) return txt;
    return s;
  } catch {
    return s;
  }
}

async function getShopAutoflowCreds(shopId: number): Promise<{
  apiBase: string;
  apiKeyRaw: string;
  apiPasswordRaw: string;
}> {
  const db = await getDb();
  const shop = await db.collection("shops").findOne(
    { shopId },
    { projection: { "credentials.autoflow": 1 } }
  );

  const af = (shop as any)?.credentials?.autoflow || {};
  const apiKeyRaw = maybeDecodeBase64(af.apiKey);
  const apiPasswordRaw = maybeDecodeBase64(af.apiPassword);
  const apiBaseDecoded = maybeDecodeBase64(af.apiBase);
  const apiBase = (apiBaseDecoded || "").replace(/\/+$/, "");

  if (!apiKeyRaw || !apiPasswordRaw || !apiBase) {
    throw new Error("Missing AutoFlow credentials for this shop.");
  }
  return { apiBase, apiKeyRaw, apiPasswordRaw };
}

/**
 * Try to normalize a single inspection/check/finding item from various possible shapes.
 * We keep it flexible because different AutoFlow tenants/versions may differ.
 */
function normalizeLineItem(x: any): {
  section?: string | null;
  title?: string | null;
  status?: string | null;
  severity?: string | number | null;
  recommendation?: string | null;
  notes?: string | null;
  estParts?: number | null;
  estLaborHours?: number | null;
  estTotal?: number | null;
  photos?: any[] | null;
  raw?: any;
} {
  const section =
    x?.section ??
    x?.group ??
    x?.category ??
    x?.heading ??
    null;

  const title =
    x?.title ??
    x?.name ??
    x?.line_item ??
    x?.inspection_item ??
    x?.item ??
    null;

  const status =
    x?.status ??
    x?.result ??
    x?.condition ??
    null;

  const severity =
    x?.severity ??
    x?.priority ??
    x?.level ??
    null;

  const recommendation =
    x?.recommendation ??
    x?.recommendations ??
    x?.action ??
    x?.advice ??
    null;

  const notes =
    x?.notes ??
    x?.note ??
    x?.comment ??
    x?.comments ??
    null;

  const estParts =
    x?.estimate?.parts != null
      ? Number(x.estimate.parts)
      : x?.parts_total != null
      ? Number(x.parts_total)
      : null;

  const estLaborHours =
    x?.estimate?.labor_hours != null
      ? Number(x.estimate.labor_hours)
      : x?.labor_hours != null
      ? Number(x.labor_hours)
      : null;

  const estTotal =
    x?.estimate?.total != null
      ? Number(x.estimate.total)
      : x?.total != null
      ? Number(x.total)
      : null;

  const photos =
    Array.isArray(x?.photos) ? x.photos :
    Array.isArray(x?.images) ? x.images :
    null;

  return {
    section: section ?? null,
    title: title ?? null,
    status: status ?? null,
    severity: severity ?? null,
    recommendation: recommendation ?? null,
    notes: notes ?? null,
    estParts: Number.isFinite(estParts as number) ? (estParts as number) : null,
    estLaborHours: Number.isFinite(estLaborHours as number) ? (estLaborHours as number) : null,
    estTotal: Number.isFinite(estTotal as number) ? (estTotal as number) : null,
    photos: photos ?? null,
    raw: x,
  };
}

/**
 * From a single DVI "content" entry, try to extract an array of line items from common paths.
 */
function extractLineItems(c: any): ReturnType<typeof normalizeLineItem>[] {
  const buckets: any[][] = [];

  // Try a bunch of plausible paths:
  if (Array.isArray(c?.inspection?.items)) buckets.push(c.inspection.items);
  if (Array.isArray(c?.inspection?.findings)) buckets.push(c.inspection.findings);
  if (Array.isArray(c?.items)) buckets.push(c.items);
  if (Array.isArray(c?.checks)) buckets.push(c.checks);
  if (Array.isArray(c?.dvi?.items)) buckets.push(c.dvi.items);
  if (Array.isArray(c?.sheet?.items)) buckets.push(c.sheet.items);
  if (Array.isArray(c?.sheet?.inspections)) buckets.push(c.sheet.inspections);
  if (Array.isArray(c?.results)) buckets.push(c.results);
  if (Array.isArray(c?.lines)) buckets.push(c.lines);

  const out: ReturnType<typeof normalizeLineItem>[] = [];
  for (const arr of buckets) {
    for (const x of arr) {
      out.push(normalizeLineItem(x));
    }
  }
  // De-dup by JSON string to avoid repeats if the same array was found in two places
  const seen = new Set<string>();
  return out.filter((li) => {
    const key = JSON.stringify([li.section, li.title, li.status, li.severity, li.recommendation, li.notes]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Calls AutoFlow DVI API: GET /dvi/{RoNumber}
 * Stores a DVI document per response entry with detailed `lines` array.
 */
export async function importDVI(args: { shopId: number; roNumber: string | number }) {
  const { shopId } = args;
  const ro = String(args.roNumber);

  const { apiBase, apiKeyRaw, apiPasswordRaw } = await getShopAutoflowCreds(shopId);
  const basic = Buffer.from(`${apiKeyRaw}:${apiPasswordRaw}`, "utf8").toString("base64");
  const url = `${apiBase}/dvi/${encodeURIComponent(ro)}`;

  const res = await fetch(url, {
    method: "GET",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      authorization: `Basic ${basic}`,
    },
    cache: "no-store",
  });

  const json = (await res.json().catch(() => ({}))) as any;
  const db = await getDb();
  const now = new Date();

  if (!res.ok) {
    const message = json?.message || json?.error || `AutoFlow DVI HTTP ${res.status}`;
    await db.collection("dvi").insertOne({
      shopId,
      roNumber: ro,
      ok: false,
      error: message,
      status: res.status,
      raw: json ?? null,
      fetchedAt: now,
    });
    throw new Error(message);
  }

  const content = Array.isArray(json?.content) ? json.content : [];
  if (!content.length) {
    await db.collection("dvi").insertOne({
      shopId,
      roNumber: ro,
      ok: true,
      empty: true,
      raw: json ?? null,
      fetchedAt: now,
    });
    return { insertedCount: 0, rows: [] };
  }

  // Build one DVI doc per content entry, now including detailed "lines"
  const rows = content.map((c: any) => {
    const vin = c?.vin ? String(c.vin).toUpperCase() : null;
    const milesNum =
      c?.mileage != null ? Number(String(c.mileage).replace(/[^\d.-]/g, "")) : null;

    const lines = extractLineItems(c);

    return {
      shopId,
      roNumber: ro,
      vin,
      mileage: Number.isFinite(milesNum) ? milesNum : null,
      customer: {
        id: c?.customer_id ?? c?.customer_remote_id ?? null,
        first: c?.customer_firstname ?? null,
        last: c?.customer_lastname ?? null,
      },
      vehicle: {
        year: c?.year ?? null,
        make: c?.make ?? null,
        model: c?.model ?? null,
        license: c?.license ?? null,
        vin,
      },
      sheetId: c?.sheet_id ?? null,
      notes: c?.additional_notes ?? null,
      lines, // <â€” detailed inspection items
      raw: c,
      fetchedAt: now,
      ok: true,
      source: "autoflow",
    };
  });

  const result = await db.collection("dvi").insertMany(rows);

  // Best-effort enrichment from the first row
  const first = rows[0];
  if (first) {
    if (first.vin) {
      await db.collection("vehicles").updateOne(
        { shopId, vin: first.vin },
        {
          $set: {
            year: first.vehicle.year ?? null,
            make: first.vehicle.make ?? null,
            model: first.vehicle.model ?? null,
            license: first.vehicle.license ?? null,
            updatedAt: now,
          },
          $setOnInsert: { shopId, vin: first.vin, createdAt: now },
        },
        { upsert: true }
      );
      await db.collection("tickets").updateOne(
        { shopId, roNumber: ro },
        {
          $set: {
            vin: first.vin,
            mileage: first.mileage ?? null,
            updatedAt: now,
            source: "autoflow-dvi",
          },
          $setOnInsert: { shopId, roNumber: ro, createdAt: now },
        },
        { upsert: true }
      );
      await db.collection("customers").updateMany(
        { shopId, lastRo: ro },
        {
          $set: {
            lastVin: first.vin,
            lastMileage: Number.isFinite(first.mileage) ? first.mileage : undefined,
            updatedAt: now,
          },
        }
      );
    }
  }

  return { insertedCount: result.insertedCount, rows };
}

