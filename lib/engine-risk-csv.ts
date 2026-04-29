/**
 * Task #177: CSV import/export helpers for engine risk overrides.
 *
 * Pure functions so the API route and its smoke test exercise the
 * exact same parsing, validation, and diff logic. The route layer is
 * just a thin wrapper that talks to Mongo and the auth gate.
 *
 * Wire format ("the same shape as the API"): one row per override,
 * columns flatten the nested `match` block onto the top level so
 * spreadsheets stay legible. `_id` is the stable key — when present
 * we treat the row as targeting an existing override; when blank we
 * treat the row as a new override. Existing overrides whose `_id` is
 * not referenced by any CSV row are slated for removal so admins can
 * round-trip the file as the source of truth.
 */

import { parse as csvParse } from "csv-parse/sync";
import type { EngineRiskAction, EngineRiskOverride } from "./engine-risk";

export const ENGINE_RISK_OVERRIDE_CSV_COLUMNS = [
  "_id",
  "label",
  "action",
  "reason",
  "make",
  "model",
  "yearMin",
  "yearMax",
  "engineNamePattern",
  "engineSize",
  "induction",
  "aspiration",
  "cylindersMax",
] as const;

export type EngineRiskOverrideCsvColumn =
  (typeof ENGINE_RISK_OVERRIDE_CSV_COLUMNS)[number];

type MatchField = keyof EngineRiskOverride["match"];

const NUMERIC_MATCH_FIELDS: ReadonlyArray<MatchField> = [
  "yearMin",
  "yearMax",
  "engineSize",
  "cylindersMax",
];

const STRING_MATCH_FIELDS: ReadonlyArray<MatchField> = [
  "make",
  "model",
  "engineNamePattern",
  "induction",
  "aspiration",
];

function setStringMatch(
  match: EngineRiskOverride["match"],
  field: MatchField,
  value: string | null,
): void {
  switch (field) {
    case "make":
      match.make = value;
      break;
    case "model":
      match.model = value;
      break;
    case "engineNamePattern":
      match.engineNamePattern = value;
      break;
    case "induction":
      match.induction = value;
      break;
    case "aspiration":
      match.aspiration = value;
      break;
  }
}

function setNumericMatch(
  match: EngineRiskOverride["match"],
  field: MatchField,
  value: number | null,
): void {
  switch (field) {
    case "yearMin":
      match.yearMin = value;
      break;
    case "yearMax":
      match.yearMax = value;
      break;
    case "engineSize":
      match.engineSize = value;
      break;
    case "cylindersMax":
      match.cylindersMax = value;
      break;
  }
}

function getMatch(
  match: EngineRiskOverride["match"],
  field: MatchField,
): string | number | null | undefined {
  return match[field];
}

export interface ParsedOverrideRow {
  /** 1-indexed row number within the data portion of the CSV (header excluded). */
  rowNumber: number;
  raw: Record<string, string>;
  /** Populated when the row passes validation. */
  override?: EngineRiskOverride;
  errors: string[];
}

export type DiffStatus =
  | "add"
  | "update"
  | "remove"
  | "unchanged"
  | "error";

export interface OverrideChange {
  field: string;
  from: unknown;
  to: unknown;
}

export interface OverrideDiffEntry {
  status: DiffStatus;
  /** Set when the entry came from a CSV row. */
  rowNumber?: number;
  /** Set when the entry corresponds to an existing override. */
  _id?: string;
  /** Display label — pulled from CSV row, falling back to current. */
  label: string;
  current?: EngineRiskOverride;
  next?: EngineRiskOverride;
  changes?: OverrideChange[];
  errors?: string[];
}

export interface OverrideDiffSummary {
  total: number;
  add: number;
  update: number;
  remove: number;
  unchanged: number;
  errors: number;
}

export interface OverrideDiff {
  entries: OverrideDiffEntry[];
  summary: OverrideDiffSummary;
}

/**
 * Task #188: guardrail thresholds for destructive CSV imports. An admin
 * who uploads a partial spreadsheet by mistake would otherwise see the
 * Apply button enabled even when the diff is going to wipe out most of
 * the existing overrides. We treat an import as "destructive" when it
 * removes more than a small absolute floor *and* at least a configured
 * fraction of the existing overrides. Both conditions must hold so a
 * tiny dataset (e.g. 3 overrides total) doesn't trip the guardrail
 * every time a single row is dropped.
 */
export const DEFAULT_DESTRUCTIVE_REMOVE_FRACTION = 0.25;
export const DEFAULT_DESTRUCTIVE_REMOVE_FLOOR = 5;

export interface DestructiveImportEvaluation {
  destructive: boolean;
  removed: number;
  currentTotal: number;
  fractionRemoved: number;
  fractionThreshold: number;
  floor: number;
  reason?: string;
}

export interface DestructiveImportOptions {
  fractionThreshold?: number;
  floor?: number;
}

export function evaluateDestructiveImport(
  diff: OverrideDiff,
  currentTotal: number,
  options: DestructiveImportOptions = {},
): DestructiveImportEvaluation {
  const fractionThreshold =
    typeof options.fractionThreshold === "number" &&
    Number.isFinite(options.fractionThreshold) &&
    options.fractionThreshold > 0 &&
    options.fractionThreshold <= 1
      ? options.fractionThreshold
      : DEFAULT_DESTRUCTIVE_REMOVE_FRACTION;
  const floor =
    typeof options.floor === "number" &&
    Number.isFinite(options.floor) &&
    options.floor >= 0
      ? Math.floor(options.floor)
      : DEFAULT_DESTRUCTIVE_REMOVE_FLOOR;
  const removed = diff.summary.remove;
  const fractionRemoved = currentTotal > 0 ? removed / currentTotal : 0;
  const overFloor = removed > floor;
  const overFraction = fractionRemoved >= fractionThreshold;
  const destructive = overFloor && overFraction;
  const result: DestructiveImportEvaluation = {
    destructive,
    removed,
    currentTotal,
    fractionRemoved,
    fractionThreshold,
    floor,
  };
  if (destructive) {
    const pct = Math.round(fractionRemoved * 100);
    const thresholdPct = Math.round(fractionThreshold * 100);
    result.reason =
      `This import would delete ${removed} of ${currentTotal} existing override(s) ` +
      `(${pct}%, which is at or above the ${thresholdPct}% destructive-import threshold ` +
      `with a floor of ${floor} row(s)). ` +
      `Re-submit with confirmDestructive: true if this is intentional.`;
  }
  return result;
}

function csvCellEscape(value: unknown): string {
  if (value === null || value === undefined) return "";
  const s = typeof value === "string" ? value : String(value);
  if (/[",\n\r]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

export function serializeOverridesToCsv(
  overrides: EngineRiskOverride[],
): string {
  const lines: string[] = [];
  lines.push(ENGINE_RISK_OVERRIDE_CSV_COLUMNS.join(","));
  for (const o of overrides) {
    const m = o.match || {};
    const row: Record<EngineRiskOverrideCsvColumn, unknown> = {
      _id: o._id ? String(o._id) : "",
      label: o.label ?? "",
      action: o.action ?? "flag",
      reason: o.reason ?? "",
      make: m.make ?? "",
      model: m.model ?? "",
      yearMin: m.yearMin ?? "",
      yearMax: m.yearMax ?? "",
      engineNamePattern: m.engineNamePattern ?? "",
      engineSize: m.engineSize ?? "",
      induction: m.induction ?? "",
      aspiration: m.aspiration ?? "",
      cylindersMax: m.cylindersMax ?? "",
    };
    lines.push(
      ENGINE_RISK_OVERRIDE_CSV_COLUMNS.map((c) => csvCellEscape(row[c])).join(
        ",",
      ),
    );
  }
  return lines.join("\n") + "\n";
}

function parseNumberCell(
  raw: string,
): { ok: true; value: number | null } | { ok: false; error: string } {
  const trimmed = (raw ?? "").trim();
  if (trimmed === "") return { ok: true, value: null };
  const n = Number(trimmed);
  if (!Number.isFinite(n)) {
    return { ok: false, error: `not a number: "${raw}"` };
  }
  return { ok: true, value: n };
}

function isLikelyObjectIdHex(s: string): boolean {
  return /^[0-9a-fA-F]{24}$/.test(s);
}

/**
 * Thrown by {@link parseOverridesCsv} when the CSV header does not look
 * like an engine-risk-override export. We fail fast (rather than letting
 * the whole file parse as "zero data rows", which the diff would then
 * present as "remove every override") so an admin who uploads the wrong
 * file gets a useful error.
 */
export class InvalidOverrideCsvError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidOverrideCsvError";
  }
}

const REQUIRED_HEADER_FIELDS: ReadonlyArray<EngineRiskOverrideCsvColumn> = [
  "label",
  "action",
  "reason",
];

export function parseOverridesCsv(csv: string): ParsedOverrideRow[] {
  const trimmed = csv.replace(/^\uFEFF/, "");
  let records: Array<Record<string, string>>;
  let headerColumns: string[] = [];
  try {
    records = csvParse(trimmed, {
      columns: (header: string[]) => {
        headerColumns = header.map((h) => h.trim());
        return headerColumns;
      },
      skip_empty_lines: true,
      trim: true,
      relax_column_count: true,
    }) as Array<Record<string, string>>;
  } catch (err: any) {
    throw new InvalidOverrideCsvError(
      `Could not parse CSV: ${err?.message ?? String(err)}`,
    );
  }

  if (headerColumns.length === 0) {
    throw new InvalidOverrideCsvError(
      "CSV is empty — expected a header row with the engine-risk-override columns",
    );
  }
  const missing = REQUIRED_HEADER_FIELDS.filter(
    (f) => !headerColumns.includes(f),
  );
  if (missing.length > 0) {
    throw new InvalidOverrideCsvError(
      `CSV header is missing required column(s): ${missing.join(", ")}. ` +
        `Expected at least: ${REQUIRED_HEADER_FIELDS.join(", ")}. ` +
        `Tip: Export CSV first to get the canonical column layout.`,
    );
  }

  const out: ParsedOverrideRow[] = [];
  records.forEach((raw, idx) => {
    const errors: string[] = [];
    const rowNumber = idx + 1;

    const label = (raw.label ?? "").trim();
    const reason = (raw.reason ?? "").trim();
    const actionRaw = (raw.action ?? "").trim().toLowerCase();
    const idRaw = (raw._id ?? "").trim();

    if (!label) errors.push("label is required");
    if (!reason) errors.push("reason is required");
    let action: EngineRiskAction = "flag";
    if (actionRaw === "" || actionRaw === "flag") {
      action = "flag";
    } else if (actionRaw === "clear") {
      action = "clear";
    } else {
      errors.push(`action must be "flag" or "clear" (got "${raw.action}")`);
    }

    let _id: string | undefined;
    if (idRaw) {
      if (!isLikelyObjectIdHex(idRaw)) {
        errors.push(`_id must be a 24-char hex ObjectId (got "${idRaw}")`);
      } else {
        _id = idRaw;
      }
    }

    const match: EngineRiskOverride["match"] = {
      make: null,
      model: null,
      yearMin: null,
      yearMax: null,
      engineNamePattern: null,
      engineSize: null,
      induction: null,
      aspiration: null,
      cylindersMax: null,
    };

    for (const f of STRING_MATCH_FIELDS) {
      const v = (raw[f] ?? "").trim();
      setStringMatch(match, f, v === "" ? null : v);
    }
    for (const f of NUMERIC_MATCH_FIELDS) {
      const parsed = parseNumberCell(raw[f] ?? "");
      if (!parsed.ok) {
        errors.push(`${f}: ${parsed.error}`);
      } else {
        setNumericMatch(match, f, parsed.value);
      }
    }

    const override: EngineRiskOverride | undefined =
      errors.length === 0
        ? {
            ...(_id ? { _id } : {}),
            label,
            reason,
            action,
            match,
          }
        : undefined;

    out.push({ rowNumber, raw, override, errors });
  });
  return out;
}

/** Canonicalise an override so we can compare existing vs. desired with deep equality. */
function canonicaliseForCompare(o: EngineRiskOverride): {
  label: string;
  reason: string;
  action: EngineRiskAction;
  match: EngineRiskOverride["match"];
} {
  const m = o.match || ({} as EngineRiskOverride["match"]);
  return {
    label: (o.label ?? "").trim(),
    reason: (o.reason ?? "").trim(),
    action: o.action === "clear" ? "clear" : "flag",
    match: {
      make: m.make ?? null,
      model: m.model ?? null,
      yearMin: m.yearMin ?? null,
      yearMax: m.yearMax ?? null,
      engineNamePattern: m.engineNamePattern ?? null,
      engineSize: m.engineSize ?? null,
      induction: m.induction ?? null,
      aspiration: m.aspiration ?? null,
      cylindersMax: m.cylindersMax ?? null,
    },
  };
}

function fieldChanges(
  current: EngineRiskOverride,
  next: EngineRiskOverride,
): OverrideChange[] {
  const c = canonicaliseForCompare(current);
  const n = canonicaliseForCompare(next);
  const out: OverrideChange[] = [];
  if (c.label !== n.label) out.push({ field: "label", from: c.label, to: n.label });
  if (c.reason !== n.reason) out.push({ field: "reason", from: c.reason, to: n.reason });
  if (c.action !== n.action) out.push({ field: "action", from: c.action, to: n.action });
  for (const f of [...STRING_MATCH_FIELDS, ...NUMERIC_MATCH_FIELDS]) {
    const cv = getMatch(c.match, f);
    const nv = getMatch(n.match, f);
    if (cv !== nv) out.push({ field: `match.${f}`, from: cv, to: nv });
  }
  return out;
}

export function computeOverrideDiff(
  parsed: ParsedOverrideRow[],
  current: EngineRiskOverride[],
): OverrideDiff {
  const currentById = new Map<string, EngineRiskOverride>();
  for (const c of current) {
    if (c._id) currentById.set(String(c._id), c);
  }

  // Pre-scan for duplicate _id references in the CSV. Two rows that
  // target the same existing override would otherwise apply in
  // sequence and silently let "the last one wins". Surface that as a
  // per-row validation error instead.
  const idCounts = new Map<string, number>();
  for (const row of parsed) {
    const idStr = row.override?._id ? String(row.override._id) : "";
    if (idStr) idCounts.set(idStr, (idCounts.get(idStr) ?? 0) + 1);
  }
  const duplicateIds = new Set<string>();
  for (const [idStr, n] of idCounts.entries()) {
    if (n > 1) duplicateIds.add(idStr);
  }

  const referencedIds = new Set<string>();
  const entries: OverrideDiffEntry[] = [];

  for (const row of parsed) {
    const idStr = row.override?._id ? String(row.override._id) : "";
    if (idStr && duplicateIds.has(idStr)) {
      entries.push({
        status: "error",
        rowNumber: row.rowNumber,
        _id: idStr,
        label: row.override?.label || (row.raw.label ?? "").trim() || `row ${row.rowNumber}`,
        errors: [
          ...row.errors,
          `_id ${idStr} appears in multiple rows; each override must be referenced at most once`,
        ],
      });
      continue;
    }

    if (row.errors.length > 0 || !row.override) {
      entries.push({
        status: "error",
        rowNumber: row.rowNumber,
        label: (row.raw.label ?? "").trim() || `row ${row.rowNumber}`,
        errors: row.errors,
      });
      continue;
    }
    const next = row.override;
    if (idStr && currentById.has(idStr)) {
      referencedIds.add(idStr);
      const cur = currentById.get(idStr)!;
      const changes = fieldChanges(cur, next);
      if (changes.length === 0) {
        entries.push({
          status: "unchanged",
          rowNumber: row.rowNumber,
          _id: idStr,
          label: next.label,
          current: cur,
          next,
        });
      } else {
        entries.push({
          status: "update",
          rowNumber: row.rowNumber,
          _id: idStr,
          label: next.label,
          current: cur,
          next,
          changes,
        });
      }
    } else {
      entries.push({
        status: "add",
        rowNumber: row.rowNumber,
        _id: idStr || undefined,
        label: next.label,
        next,
      });
    }
  }

  for (const [idStr, cur] of currentById.entries()) {
    if (!referencedIds.has(idStr)) {
      entries.push({
        status: "remove",
        _id: idStr,
        label: cur.label,
        current: cur,
      });
    }
  }

  const summary: OverrideDiffSummary = {
    total: entries.length,
    add: 0,
    update: 0,
    remove: 0,
    unchanged: 0,
    errors: 0,
  };
  for (const e of entries) {
    if (e.status === "add") summary.add++;
    else if (e.status === "update") summary.update++;
    else if (e.status === "remove") summary.remove++;
    else if (e.status === "unchanged") summary.unchanged++;
    else if (e.status === "error") summary.errors++;
  }
  return { entries, summary };
}

