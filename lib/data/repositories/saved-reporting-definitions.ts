import type { Document } from "mongodb";
import { findCustomReport } from "@/lib/data/repositories/custom-reports";
import { REPORT_METRIC_VALUE_KEYS, type ReportMetric } from "@/lib/report-definition-contract";

export type SavedReportingDefinition = {
  reportId: string;
  version: number;
  name: string;
  createdBy?: string;
  scope?: { kind: "shop" | "enterprise" | "platform"; shopId?: number; enterpriseId?: string };
  selectedFields?: unknown[];
  layout?: unknown;
  definition: Record<string, unknown>;
  raw: Document;
};

const versionNumber = (value: unknown) => {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
};

/**
 * Reads both the versioned shape and the original single-definition shape.
 * This intentionally keeps export/delivery decoupled from the report compiler.
 */
export async function findSavedReportingDefinition(
  reportId: string,
  requestedVersion?: number,
): Promise<SavedReportingDefinition | null> {
  const doc = await findCustomReport(reportId);
  if (!doc) return null;

  const versions = Array.isArray(doc.versions) ? doc.versions : [];
  const currentVersion = versionNumber(doc.currentVersion) ?? 1;
  const wanted = requestedVersion ?? currentVersion;
  const version = versions.find((entry: any) => versionNumber(entry?.version) === wanted);
  if (versions.length > 0 && !version) return null;
  if (versions.length === 0 && wanted !== currentVersion) return null;

  const definition: any = version?.definition;
  if (!definition) return null;
  return {
    reportId: String(doc._id),
    version: wanted,
    name: String(doc.name),
    createdBy: doc.ownerEmail,
    scope: doc.scope,
    selectedFields: [
      "dimension", "key", "label", "shopId",
      ...(Array.isArray(definition.metrics)
        ? definition.metrics.flatMap((metric: ReportMetric) => REPORT_METRIC_VALUE_KEYS[metric] || [])
        : []),
    ],
    layout: {
      dimension: Array.isArray(definition.dimensions) ? definition.dimensions[0] : undefined,
      filters: definition.filters,
      ...(definition.presentation && typeof definition.presentation === "object" ? definition.presentation : {}),
      orderBy: definition.presentation?.orderBy && REPORT_METRIC_VALUE_KEYS[definition.presentation.orderBy as ReportMetric]
        ? REPORT_METRIC_VALUE_KEYS[definition.presentation.orderBy as ReportMetric][0]
        : definition.presentation?.orderBy,
    },
    definition,
    raw: doc,
  };
}