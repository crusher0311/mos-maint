/**
 * Pure AutoFlow workflow classification helpers.
 *
 * This module intentionally has no database or server imports.  The extension
 * and dashboard can therefore share the exact same normalization rules
 * without pulling a Mongo/Next dependency into a client bundle.
 */

export const DEFAULT_AUTOFLOW_ACTIVE_STATUSES = [
  "CHECKED IN",
  "IN PROGRESS",
  "EST",
  "RACK ATTACK",
  "Build Estimate (Workflow) and Presentation (Advisor)",
  "Authorized ready for work",
] as const;

export const DEFAULT_AUTOFLOW_CLOSED_STATUSES = ["Close"] as const;

// Short aliases keep the client-facing contract easy to discover while the
// prefixed names remain unambiguous beside other workflow settings.
export const DEFAULT_ACTIVE_STATUSES = DEFAULT_AUTOFLOW_ACTIVE_STATUSES;
export const DEFAULT_CLOSED_STATUSES = DEFAULT_AUTOFLOW_CLOSED_STATUSES;

export type AutoflowWorkflowBucket = "active" | "closed" | "excluded";

export interface AutoflowWorkflowMapping {
  active: string[];
  closed: string[];
  excluded: string[];
}

export type WorkflowMapping = AutoflowWorkflowMapping;

export type AutoflowWorkflowClassification =
  | "active"
  | "closed"
  | "excluded"
  | "unknown";

export const DEFAULT_AUTOFLOW_WORKFLOW_MAPPING: AutoflowWorkflowMapping = {
  active: [...DEFAULT_AUTOFLOW_ACTIVE_STATUSES],
  closed: [...DEFAULT_AUTOFLOW_CLOSED_STATUSES],
  excluded: [],
};

export const AUTOFLOW_WORKFLOW_MAPPING_MAX_LABELS = 300;
export const AUTOFLOW_WORKFLOW_LABEL_MAX_LENGTH = 200;

/**
 * Normalize only differences that are harmless for a status identity:
 * surrounding/internal whitespace and letter case. Punctuation and all other
 * characters remain significant.
 */
export function normalizeAutoflowWorkflowStatus(value: unknown): string {
  return typeof value === "string"
    ? value.trim().replace(/\s+/g, " ").toLocaleLowerCase()
    : "";
}

export const normalizeAutoflowStatusKey = normalizeAutoflowWorkflowStatus;

function cleanLabels(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  if (value.length > AUTOFLOW_WORKFLOW_MAPPING_MAX_LABELS) return null;

  const labels: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== "string") return null;
    const label = item.trim().replace(/\s+/g, " ");
    if (
      !label ||
      label.length > AUTOFLOW_WORKFLOW_LABEL_MAX_LENGTH ||
      !normalizeAutoflowWorkflowStatus(label)
    ) {
      return null;
    }
    const key = normalizeAutoflowWorkflowStatus(label);
    if (!seen.has(key)) {
      seen.add(key);
      labels.push(label);
    }
  }
  return labels;
}

/**
 * Validate and canonicalize an admin-supplied mapping. Labels can only belong
 * to one bucket; this prevents an ambiguous status from being both closed and
 * active (or from being hidden by an exclusion).
 */
export function validateAutoflowWorkflowMapping(
  value: unknown,
): AutoflowWorkflowMapping {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("mapping must be an object");
  }
  const input = value as Record<string, unknown>;
  const active = cleanLabels(input.active);
  const closed = cleanLabels(input.closed);
  const excluded = cleanLabels(input.excluded);
  if (!active || !closed || !excluded) {
    throw new Error(
      `mapping labels must be non-empty strings (maximum ${AUTOFLOW_WORKFLOW_LABEL_MAX_LENGTH} characters)`,
    );
  }
  if (active.length + closed.length + excluded.length > AUTOFLOW_WORKFLOW_MAPPING_MAX_LABELS) {
    throw new Error(
      `mapping contains more than ${AUTOFLOW_WORKFLOW_MAPPING_MAX_LABELS} labels`,
    );
  }

  const owners = new Map<string, AutoflowWorkflowBucket>();
  for (const [bucket, labels] of [
    ["active", active],
    ["closed", closed],
    ["excluded", excluded],
  ] as const) {
    for (const label of labels) {
      const key = normalizeAutoflowWorkflowStatus(label);
      const previous = owners.get(key);
      if (previous) {
        throw new Error(`status "${label}" appears in multiple mapping buckets`);
      }
      owners.set(key, bucket);
    }
  }

  return { active, closed, excluded };
}

export function defaultAutoflowWorkflowMapping(): AutoflowWorkflowMapping {
  return {
    active: [...DEFAULT_AUTOFLOW_WORKFLOW_MAPPING.active],
    closed: [...DEFAULT_AUTOFLOW_WORKFLOW_MAPPING.closed],
    excluded: [],
  };
}

/**
 * Classify an event status. Unknown labels deliberately remain unknown so
 * callers can fail closed and surface them for an administrator to review.
 */
export function classifyAutoflowWorkflowStatus(
  value: unknown,
  mapping: AutoflowWorkflowMapping | null | undefined,
): AutoflowWorkflowClassification {
  const key = normalizeAutoflowWorkflowStatus(value);
  if (!key) return "unknown";

  const effective = mapping
    ? validateAutoflowWorkflowMapping(mapping)
    : defaultAutoflowWorkflowMapping();
  const labels: Record<AutoflowWorkflowBucket, string[]> = {
    active: effective.active,
    closed: effective.closed,
    excluded: effective.excluded,
  };
  for (const bucket of ["active", "closed", "excluded"] as const) {
    if (
      labels[bucket].some(
        (label) => normalizeAutoflowWorkflowStatus(label) === key,
      )
    ) {
      return bucket;
    }
  }
  return "unknown";
}

export const classifyAutoflowStatus = classifyAutoflowWorkflowStatus;
