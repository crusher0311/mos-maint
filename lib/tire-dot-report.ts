import type { TireDotDefinition, TireDotResult, TireDotDetail, TireDotInvoice } from "./tire-dot-report-contract";
import { TIRE_DOT_LIMITS } from "./tire-dot-report-contract";

type Raw = Record<string, any>;
const text = (v: unknown): string | null => typeof v === "string" && v.trim() ? v : typeof v === "number" && Number.isFinite(v) ? String(v) : null;
const number = (v: unknown): number | null => (typeof v === "number" || typeof v === "string" && v.trim() !== "") && Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) : null;
const removed = (v: Raw) => Boolean(v.deletedDate || v.deletedAt || v.deleted === true || v.isDeleted === true || v.archived === true || v.isArchived === true || v.archivedDate);
const object = (v: unknown): v is Raw => Boolean(v && typeof v === "object" && !Array.isArray(v));

export function validateTireDefinition(input: any): TireDotDefinition {
  const date = (v: unknown) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) && Number.isFinite(Date.parse(v)) && new Date(v).toISOString().slice(0, 10) === v;
  if (!date(input?.dateRange?.start) || !date(input?.dateRange?.end)) throw new Error("Choose valid start and end dates");
  const { start, end } = input.dateRange;
  if (start > end || (Date.parse(end) - Date.parse(start)) / 86_400_000 >= 366) throw new Error("Choose an inclusive date range of at most 366 days");
  if (!Array.isArray(input.locationIds) || !input.locationIds.length || input.locationIds.length > 500 ||
      input.locationIds.some((id: unknown) => !Number.isSafeInteger(id) || Number(id) <= 0)) throw new Error("Select authorized Tekmetric locations");
  return { kind: "tekmetric-tire-dot", version: 1, dateRange: { start, end }, locationIds: [...new Set<number>(input.locationIds)].sort((a,b) => a-b) };
}

export function emptyTireResult(definition: TireDotDefinition, locations: TireDotResult["locations"]): TireDotResult {
  return {
    generatedAt: "", dateRange: definition.dateRange, shopIds: definition.locationIds, locations,
    details: [], invoices: [], counts: { invoices: 0, partLines: 0, tireQuantity: 0, dotEntries: 0 },
    coverage: { status: "stored-evidence-only", scanned: 0, missingRaw: 0, missingPostedDate: 0,
      reasons: ["Retained Tekmetric work-order snapshots only; upstream import completeness and current provider state are not verified. Extraction is not a point-in-time provider snapshot."] },
    limited: false,
  };
}
export function tireCoverageGap(result: TireDotResult, reason: string) {
  result.coverage.status = "incomplete";
  if (!result.coverage.reasons.includes(reason)) result.coverage.reasons.push(reason);
}

/** Explicit part type/category, tire size, or tire wording in PART evidence.
 * Never use job names, labor, inspections, or the word DOT as tire evidence.
 * A nonempty dotNumbers array is explicit tire-registration evidence unless the
 * part describes a known non-tire product/service. No brand-only inference. */
export function tireSaleCandidate(part: Raw): boolean {
  const label = [part.name, part.description, part.partType, part.type, part.category?.name, part.category, part.tireSize].filter(v => typeof v === "string").join(" ");
  if (/\b(brake\s*fluid|rotation|rotate|mount(?:ing)?|balanc(?:e|ing)|labor|disposal|repair|sealant|valve|sensor|tpms|warranty)\b/i.test(label)) return false;
  return /\btires?\b/i.test(label) || /\b(?:P|LT)?\d{3}\/\d{2}(?:ZR|R)\d{2}\b/i.test(label)
    || Number(part.width)>=125 && Number(part.width)<=455 && Number(part.ratio)>=20 && Number(part.ratio)<=95 && Number(part.diameter)>=10 && Number(part.diameter)<=30
    || Array.isArray(part.dotNumbers) && part.dotNumbers.some((v: unknown) => typeof v === "string" && v.trim() !== "");
}

/** Mutates bounded accumulator; one invoice is admitted atomically, never half
 * an invoice. Duplicate source identities are not silently double-counted. */
export function extractTireInvoice(result: TireDotResult, shopId: number, source: unknown) {
  result.coverage.scanned++;
  const doc = object(source) ? source : {};
  const raw = object(doc.data) ? doc.data : null;
  if (!raw || !Object.keys(raw).length) {
    result.coverage.missingRaw++; tireCoverageGap(result, "Some retained records lack raw payloads; tire population is unknown."); return;
  }
  if (removed(doc) || removed(raw)) return;
  const retainedStatuses = [doc.status, doc.repairOrderStatus].map(s => String(s?.name ?? s ?? "").toLowerCase().replace(/[_-]/g, " "));
  if (retainedStatuses.some(s => ["void", "voided", "deleted", "archived", "cancelled", "canceled", "estimate", "open", "work in progress", "in progress", "saved for later"].includes(s))) return;
  const status = String(raw.repairOrderStatus?.name ?? raw.repairOrderStatus ?? "").toLowerCase();
  if (["void", "deleted", "archived", "estimate", "open", "work in progress", "in progress"].includes(status)) return;
  const postedInput = typeof raw.postedDate === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(raw.postedDate)
    ? raw.postedDate + "Z" : raw.postedDate;
  if (typeof postedInput !== "string" || !postedInput || !Number.isFinite(Date.parse(postedInput))) {
    result.coverage.missingPostedDate++; tireCoverageGap(result, "Records without a valid Tekmetric posted date cannot be assigned to this period."); return;
  }
  const postedDate = new Date(postedInput).toISOString();
  const day = postedDate.slice(0, 10);
  if (day < result.dateRange.start || day > result.dateRange.end) return;
  // A postedDate is finalization evidence; contradictory explicit status vetoes it.
  const postedReceivable = status === "accounts receivable" && raw.repairOrderStatus?.code === "ACCRECV" && raw.repairOrderStatus?.postedOrAccrecv === true;
  if (status && !postedReceivable && !["posted", "invoiced", "closed", "complete", "completed"].includes(status)) {
    tireCoverageGap(result, "Some posted records have unrecognized invoice status."); return;
  }
  const id = text(raw.id);
  if (!id || text(doc.workOrderId) && text(doc.workOrderId) !== id) {
    tireCoverageGap(result, "Some raw invoices have missing or conflicting provider identity."); return;
  }
  if (!Array.isArray(raw.jobs)) {
    result.coverage.missingRaw++; tireCoverageGap(result, "Some posted invoices lack a raw jobs collection."); return;
  }
  const key = `${shopId}:${id}`;
  // Conflicting/duplicate retained copies are excluded rather than choosing a
  // financially convenient version. Unique work_order identity is a setup prerequisite.
  if (result.invoices.some(row => row.key === key)) {
    tireCoverageGap(result, "Duplicate retained provider invoice identities encountered; reconcile source coverage before use."); return;
  }
  const mileage = number(raw.milesIn) ?? number(raw.mileageIn) ?? number(raw.milesOut) ?? number(raw.mileageOut);
  const v = object(raw.vehicle) ? raw.vehicle : {};
  const common = {
    key, shopId, location: result.locations.find(l => l.shopId === shopId)?.name || `Shop ${shopId}`,
    providerRoId: id, invoiceNumber: text(raw.repairOrderNumber),
    postedDate, vin: text(v.vin ?? raw.vin ?? doc.vin),
    vehicle: [v.year ?? raw.vehicleYear ?? doc.vehicleYear, v.make ?? raw.vehicleMake ?? doc.vehicleMake, v.model ?? raw.vehicleModel ?? doc.vehicleModel].map(text).filter(Boolean).join(" ") || null,
    mileage,
  };
  const details: TireDotDetail[] = [];
  const invoice: TireDotInvoice = { ...common, partLines: 0, tireQuantity: 0, dotEntries: 0, exceptions: [] };
  for (const [ji, job] of raw.jobs.entries()) {
    if (!object(job) || removed(job)) continue;
    const state = String(job.status ?? job.jobStatus ?? job.authorizationStatus ?? "").toLowerCase();
    // Provider null means unknown, not approved or declined. Keep candidate
    // invoices visible as exceptions without manufacturing sold-tire totals.
    if (job.authorized === null && !/declined|deferred/.test(state) &&
        Array.isArray(job.parts) && job.parts.some((part: any) =>
          object(part) && !removed(part) && tireSaleCandidate(part))) {
      const reason = "Tire job authorization is unknown; its parts are excluded from sold-tire totals";
      if (!invoice.exceptions.includes(reason)) invoice.exceptions.push(reason);
      tireCoverageGap(result, reason);
    }
    if (job.authorized !== true || /declined|deferred|pending|open/.test(state)) continue;
    if (!Array.isArray(job.parts)) {
      tireCoverageGap(result, "Some authorized jobs lack a raw parts collection."); continue;
    }
    for (const [pi, part] of job.parts.entries()) {
      if (!object(part) || removed(part) || part.authorized === false ||
          /declined|deferred|pending|open/i.test(String(part.status ?? part.authorizationStatus ?? "")) ||
          !tireSaleCandidate(part)) continue;
      const quantity = number(part.quantity);
      if (quantity === null) { tireCoverageGap(result, "Some candidate tire lines lack a valid quantity."); continue; }
      if (quantity <= 0) continue;
      const exceptions: string[] = [];
      if (part._mosDotInherited === true) {
        exceptions.push("DOT retained from an earlier payload; current capture omitted this field");
        tireCoverageGap(result,"Some DOT entries are retained earlier evidence, not reconfirmed by the latest payload.");
      }
      if (mileage === null) exceptions.push("Missing invoice mileage");
      if (!common.invoiceNumber) exceptions.push("Missing invoice number");
      if (!common.vin) exceptions.push("Missing VIN");
      const dots = Array.isArray(part.dotNumbers) ? part.dotNumbers : [];
      const valid = dots.filter((d: unknown) => typeof d === "string" && d.trim() !== "");
      if (!valid.length) exceptions.push("Missing DOT");
      if (!Object.hasOwn(part,"dotNumbers")) {
        exceptions.push("DOT field absent from captured payload");
        tireCoverageGap(result,"Some tire parts omit the DOT field; this does not establish that Tekmetric has no recorded DOTs.");
      }
      if (valid.length !== quantity) exceptions.push("DOT entry count differs from part quantity");
      if (dots.some((d: unknown) => typeof d !== "string" || !d.trim())) exceptions.push("Invalid or blank DOT entry");
      const jobId = text(job.id) ?? `position-${ji}`;
      const partId = text(part.id) ?? `position-${pi}`;
      const base = { ...common, jobId, partId, description: text(part.name ?? part.description), brand: text(part.brand?.name ?? part.brand), quantity, exceptions };
      // Array position, not value, is identity: repeated DOTs are distinct entries.
      if (!valid.length) details.push({ ...base, key: `${key}:${ji}:${pi}:missing`, dot: null, entryIndex: null });
      else dots.forEach((dot: unknown, ei: number) => {
        if (typeof dot === "string" && dot.trim()) details.push({ ...base, key: `${key}:${ji}:${pi}:${ei}`, dot, entryIndex: ei });
      });
      invoice.partLines++; invoice.tireQuantity += quantity; invoice.dotEntries += valid.length;
      invoice.exceptions = [...new Set([...invoice.exceptions, ...exceptions])];
    }
  }
  if (!invoice.partLines && !invoice.exceptions.length) return;
  if (result.details.length + details.length > TIRE_DOT_LIMITS.rows ||
      Buffer.byteLength(JSON.stringify([result, details, invoice])) > TIRE_DOT_LIMITS.bytes) {
    result.limited = true; tireCoverageGap(result, "Result safety limit reached; counts are partial. Select fewer locations or shorter dates."); return;
  }
  result.details.push(...details); result.invoices.push(invoice);
  result.counts.invoices++; result.counts.partLines += invoice.partLines;
  result.counts.tireQuantity += invoice.tireQuantity; result.counts.dotEntries += invoice.dotEntries;
}

/** Apostrophe is intentional spreadsheet text protection, not an Excel formula.
 * Import identifier columns as Text to preserve zeroes in all spreadsheet tools. */
export function tireCsv(result: TireDotResult, view: "details" | "invoices") {
  const cell = (v: unknown, textual = false) => {
    let value = v == null ? "Missing" : String(v);
    if (textual || /^[\s\u0000-\u001f]*[=+\-@]/.test(value) || /[\t\r\n]/.test(value)) value = "'" + value;
    return `"${value.replace(/"/g, '""')}"`;
  };
  const fields = ["Location", "Shop ID", "Provider RO ID", "Invoice number", "Posted date UTC", "VIN", "Vehicle", "Invoice mileage",
    ...(view === "details" ? ["Job ID", "Part ID", "Entry index", "Description", "Brand", "Part quantity (repeated per DOT)", "DOT"] : ["Part lines", "Tire quantity", "DOT entries"]),
    "Exceptions", `Start UTC inclusive: ${result.dateRange.start}`, `End UTC inclusive: ${result.dateRange.end}`,
    `Executed shop IDs: ${result.shopIds.join(";")}`, `Generated UTC: ${result.generatedAt}`,
    `Coverage: ${result.coverage.status}`, `Limited: ${result.limited}`, `Coverage notes: ${result.coverage.reasons.join("; ")}`];
  const rows = view === "details" ? result.details : result.invoices;
  return "\uFEFF" + fields.map(v => cell(v)).join(",") + "\r\n" + rows.map(row => {
    const d = row as TireDotDetail; const i = row as TireDotInvoice;
    return [cell(row.location),cell(row.shopId),cell(row.providerRoId,true),cell(row.invoiceNumber,row.invoiceNumber !== null),cell(row.postedDate),cell(row.vin,true),cell(row.vehicle),cell(row.mileage),
      ...(view === "details" ? [cell(d.jobId,true),cell(d.partId,true),cell(d.entryIndex),cell(d.description),cell(d.brand),cell(d.quantity),cell(d.dot,d.dot !== null)] : [cell(i.partLines),cell(i.tireQuantity),cell(i.dotEntries)]),
      cell(row.exceptions.join("; ") || "None recorded"),cell(result.dateRange.start),cell(result.dateRange.end),cell(result.shopIds.join(";")),cell(result.generatedAt),
      cell(result.coverage.status),cell(result.limited),cell(result.coverage.reasons.join("; "))].join(",");
  }).join("\r\n") + "\r\n";
}
