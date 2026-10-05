import {
  classifyAutoflowWorkflowStatus,
  type AutoflowWorkflowMapping,
} from "@/lib/autoflow-workflow";

export interface AutoflowStatusEvent {
  status: unknown;
  occurredAt: Date | string | number;
}

function timestamp(value: Date | string | number): number {
  const parsed = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Apply the dashboard's ordered active/closed/excluded rules to one VIN's
 * event history. Unknown statuses are deliberately ignored; an exclusion (or
 * close) suppresses an older active event until a later active event arrives.
 *
 * The Mongo dashboard aggregation mirrors these same three watermarks. This
 * pure version is used by offline regression tests and by non-Mongo tooling.
 */
export function isAutoflowHistoryActive(
  events: AutoflowStatusEvent[],
  mapping?: AutoflowWorkflowMapping | null,
): boolean {
  let activeAt = -Infinity;
  let closedAt = -Infinity;
  let excludedAt = -Infinity;

  for (const event of events) {
    const at = timestamp(event.occurredAt);
    switch (classifyAutoflowWorkflowStatus(event.status, mapping)) {
      case "active":
        activeAt = Math.max(activeAt, at);
        break;
      case "closed":
        closedAt = Math.max(closedAt, at);
        break;
      case "excluded":
        excludedAt = Math.max(excludedAt, at);
        break;
    }
  }
  return activeAt > closedAt && activeAt > excludedAt;
}