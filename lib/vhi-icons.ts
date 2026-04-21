/**
 * Inline SVG icons for VHI item status, exposed to API partners so they can
 * render the same visual language as our UI without shipping our CSS.
 *
 * Each SVG is self-contained, 16x16, currentColor-friendly where possible,
 * but ships explicit fill colors so it works in <img src="data:..."> contexts.
 */

import type { ProgressStatus } from "@/lib/vhi-progress";

export type IconStatus = ProgressStatus | "deferred";

const ICON_SVGS: Record<IconStatus, string> = {
  overdue: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="16" height="16" role="img" aria-label="Overdue"><circle cx="8" cy="8" r="7" fill="#dc2626"/><rect x="7" y="3.5" width="2" height="6" rx="1" fill="#fff"/><rect x="7" y="10.5" width="2" height="2" rx="1" fill="#fff"/></svg>`,
  soon: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="16" height="16" role="img" aria-label="Due soon"><circle cx="8" cy="8" r="7" fill="#f59e0b"/><path d="M8 4v4l2.5 2.5" stroke="#fff" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" fill="none"/></svg>`,
  ok: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="16" height="16" role="img" aria-label="OK"><circle cx="8" cy="8" r="7" fill="#10b981"/><path d="M4.5 8.5l2.2 2.2L11.5 6" stroke="#fff" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" fill="none"/></svg>`,
  deferred: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="16" height="16" role="img" aria-label="Deferred"><circle cx="8" cy="8" r="7" fill="#3b82f6"/><circle cx="5" cy="8" r="1" fill="#fff"/><circle cx="8" cy="8" r="1" fill="#fff"/><circle cx="11" cy="8" r="1" fill="#fff"/></svg>`,
};

export function getStatusIconSvg(status: IconStatus | null | undefined): string | null {
  if (!status) return null;
  return ICON_SVGS[status] ?? null;
}

/**
 * Top-level icon set partners can fetch once and reuse, instead of getting a
 * duplicate SVG string on every item. Returned as a plain object so it
 * serializes cleanly into JSON responses.
 */
export function getStatusIconSet(): Record<IconStatus, string> {
  return { ...ICON_SVGS };
}
