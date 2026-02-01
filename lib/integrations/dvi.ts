import sql from "@/lib/db/postgres";

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

async function getShopAutoflowCreds(shopId: number | string): Promise<{
  apiBase: string;
  apiKeyRaw: string;
  apiPasswordRaw: string;
}> {
  const shopIdStr = String(shopId);
  const result = await sql`
    SELECT settings FROM shops WHERE shop_id = ${shopIdStr} LIMIT 1
  `;

  const shop = result[0];
  const settings = shop?.settings as Record<string, unknown> | undefined;
  const credentials = settings?.credentials as Record<string, unknown> | undefined;
  const af = credentials?.autoflow as Record<string, unknown> || {};
  
  const apiKeyRaw = maybeDecodeBase64(af.apiKey as string);
  const apiPasswordRaw = maybeDecodeBase64(af.apiPassword as string);
  const apiBaseDecoded = maybeDecodeBase64(af.apiBase as string);
  const apiBase = (apiBaseDecoded || "").replace(/\/+$/, "");

  if (!apiKeyRaw || !apiPasswordRaw || !apiBase) {
    throw new Error("Missing AutoFlow credentials for this shop.");
  }
  return { apiBase, apiKeyRaw, apiPasswordRaw };
}

function normalizeLineItem(x: Record<string, unknown>): {
  section?: string | null;
  title?: string | null;
  status?: string | null;
  severity?: string | number | null;
  recommendation?: string | null;
  notes?: string | null;
  estParts?: number | null;
  estLaborHours?: number | null;
  estTotal?: number | null;
  photos?: unknown[] | null;
  raw?: unknown;
} {
  const section = x?.section ?? x?.group ?? x?.category ?? x?.heading ?? null;
  const title = x?.title ?? x?.name ?? x?.line_item ?? x?.inspection_item ?? x?.item ?? null;
  const status = x?.status ?? x?.result ?? x?.condition ?? null;
  const severity = x?.severity ?? x?.priority ?? x?.level ?? null;
  const recommendation = x?.recommendation ?? x?.recommendations ?? x?.action ?? x?.advice ?? null;
  const notes = x?.notes ?? x?.note ?? x?.comment ?? x?.comments ?? null;

  const estimate = x?.estimate as Record<string, unknown> | undefined;
  const estParts = estimate?.parts != null ? Number(estimate.parts) : (x?.parts_total != null ? Number(x.parts_total) : null);
  const estLaborHours = estimate?.labor_hours != null ? Number(estimate.labor_hours) : (x?.labor_hours != null ? Number(x.labor_hours) : null);
  const estTotal = estimate?.total != null ? Number(estimate.total) : (x?.total != null ? Number(x.total) : null);
  const photos = Array.isArray(x?.photos) ? x.photos : (Array.isArray(x?.images) ? x.images : null);

  return {
    section: section as string | null,
    title: title as string | null,
    status: status as string | null,
    severity: severity as string | number | null,
    recommendation: recommendation as string | null,
    notes: notes as string | null,
    estParts: Number.isFinite(estParts as number) ? (estParts as number) : null,
    estLaborHours: Number.isFinite(estLaborHours as number) ? (estLaborHours as number) : null,
    estTotal: Number.isFinite(estTotal as number) ? (estTotal as number) : null,
    photos: photos as unknown[] | null,
    raw: x,
  };
}

function extractLineItems(c: Record<string, unknown>): ReturnType<typeof normalizeLineItem>[] {
  const buckets: unknown[][] = [];
  const inspection = c?.inspection as Record<string, unknown> | undefined;
  const dvi = c?.dvi as Record<string, unknown> | undefined;
  const sheet = c?.sheet as Record<string, unknown> | undefined;

  if (Array.isArray(inspection?.items)) buckets.push(inspection.items);
  if (Array.isArray(inspection?.findings)) buckets.push(inspection.findings);
  if (Array.isArray(c?.items)) buckets.push(c.items as unknown[]);
  if (Array.isArray(c?.checks)) buckets.push(c.checks as unknown[]);
  if (Array.isArray(dvi?.items)) buckets.push(dvi.items);
  if (Array.isArray(sheet?.items)) buckets.push(sheet.items);
  if (Array.isArray(sheet?.inspections)) buckets.push(sheet.inspections);
  if (Array.isArray(c?.results)) buckets.push(c.results as unknown[]);
  if (Array.isArray(c?.lines)) buckets.push(c.lines as unknown[]);

  const out: ReturnType<typeof normalizeLineItem>[] = [];
  for (const arr of buckets) {
    for (const x of arr) {
      out.push(normalizeLineItem(x as Record<string, unknown>));
    }
  }

  const seen = new Set<string>();
  return out.filter((li) => {
    const key = JSON.stringify([li.section, li.title, li.status, li.severity, li.recommendation, li.notes]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export async function importDVI(args: { shopId: number | string; roNumber: string | number }) {
  const shopIdStr = String(args.shopId);
  const ro = String(args.roNumber);

  const { apiBase, apiKeyRaw, apiPasswordRaw } = await getShopAutoflowCreds(args.shopId);
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

  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;

  if (!res.ok) {
    const message = (json?.message || json?.error || `AutoFlow DVI HTTP ${res.status}`) as string;
    await sql`
      INSERT INTO dvi (shop_id, ro_number, ok, error, status, raw, fetched_at)
      VALUES (${shopIdStr}, ${ro}, false, ${message}, ${res.status}, ${JSON.stringify(json)}::jsonb, NOW())
    `;
    throw new Error(message);
  }

  const content = Array.isArray(json?.content) ? json.content as Record<string, unknown>[] : [];
  if (!content.length) {
    await sql`
      INSERT INTO dvi (shop_id, ro_number, ok, empty, raw, fetched_at)
      VALUES (${shopIdStr}, ${ro}, true, true, ${JSON.stringify(json)}::jsonb, NOW())
    `;
    return { insertedCount: 0, rows: [] };
  }

  const rows = content.map((c) => {
    const vin = c?.vin ? String(c.vin).toUpperCase() : null;
    const milesNum = c?.mileage != null ? Number(String(c.mileage).replace(/[^\d.-]/g, "")) : null;
    const lines = extractLineItems(c);

    return {
      shopId: shopIdStr,
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
      lines,
      raw: c,
    };
  });

  for (const row of rows) {
    await sql`
      INSERT INTO dvi (shop_id, ro_number, vin, mileage, customer, vehicle, sheet_id, notes, lines, raw, fetched_at, ok, source)
      VALUES (${row.shopId}, ${row.roNumber}, ${row.vin}, ${row.mileage}, ${JSON.stringify(row.customer)}::jsonb,
        ${JSON.stringify(row.vehicle)}::jsonb, ${row.sheetId as string | null}, ${row.notes as string | null},
        ${JSON.stringify(row.lines)}::jsonb, ${JSON.stringify(row.raw)}::jsonb, NOW(), true, 'autoflow')
    `;
  }

  const first = rows[0];
  if (first && first.vin) {
    await sql`
      INSERT INTO vehicles (shop_id, vin, year, make, model, license_plate, source)
      VALUES (${shopIdStr}, ${first.vin}, ${first.vehicle.year as number | null}, ${first.vehicle.make as string | null}, 
        ${first.vehicle.model as string | null}, ${first.vehicle.license as string | null}, 'autoflow-dvi')
      ON CONFLICT (shop_id, vin) DO UPDATE SET
        year = COALESCE(${first.vehicle.year as number | null}, vehicles.year),
        make = COALESCE(${first.vehicle.make as string | null}, vehicles.make),
        model = COALESCE(${first.vehicle.model as string | null}, vehicles.model),
        license_plate = COALESCE(${first.vehicle.license as string | null}, vehicles.license_plate),
        updated_at = NOW()
    `;

    await sql`
      UPDATE customers SET last_vin = ${first.vin}, last_mileage = ${first.mileage}, updated_at = NOW()
      WHERE shop_id = ${shopIdStr} AND last_ro = ${ro}
    `;
  }

  return { insertedCount: rows.length, rows };
}
