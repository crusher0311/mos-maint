import type { DesignerLayout } from "./keytag-designer-types";

export const KEYTAG_LABEL_MAX = 32;
export const KEYTAG_VALUE_MAX = 64;
type TextElement = {
  label: string; showLabel?: boolean; width: number; height: number; fontSize: number;
  fontWeight: string; fontStyle: string; labelFontWeight?: string; labelFontStyle?: string;
  valueFontWeight?: string; valueFontStyle?: string;
};
export function keytagExtraTextRuns(element: TextElement, value: string) {
  return element.showLabel && element.label ? [
    { text: `${element.label}: `, weight: element.labelFontWeight || element.fontWeight, style: element.labelFontStyle || element.fontStyle },
    { text: value, weight: element.valueFontWeight || "normal", style: element.valueFontStyle || "normal" },
  ] : [{ text: value, weight: element.fontWeight, style: element.fontStyle }];
}
export function fitKeytagExtraFontSize(
  element: TextElement, value: string,
  measure: (text: string, size: number, weight: string, style: string) => number,
) {
  const size = Math.max(0.1, Math.min(element.fontSize, element.height / 1.2));
  const width = keytagExtraTextRuns(element, value).reduce((total, run) =>
    total + measure(run.text, size, run.weight, run.style), 0);
  return Math.min(size, size * Math.max(0.1, element.width - 4) / Math.max(width, 0.1));
}
type Field = { id?: string; type: string; label: string; visible?: boolean };
type Layout = { elements: Field[] } | null | undefined;

export function isKeytagExtra(field: { type: string }): boolean {
  return ["vehicleColor", "licensePlate", "custom"].includes(field.type);
}

export function keytagFieldBinding(field: { type: string; id?: string }): string {
  return field.type === "custom" ? field.id || "" : field.type;
}

export function enabledKeytagExtras(layout: Layout) {
  return (layout?.elements || []).filter(el => el.visible && isKeytagExtra(el));
}

/** Only project this shop's enabled definitions. Never merge arbitrary payload keys. */
export function normalizeKeytagExtraValues(layout: Layout, raw: unknown): Record<string, string> {
  const result: Record<string, string> = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return result;
  for (const field of enabledKeytagExtras(layout)) {
    const key = keytagFieldBinding(field);
    if (!key || !Object.prototype.hasOwnProperty.call(raw, key)) continue;
    const value = (raw as Record<string, unknown>)[key];
    if (typeof value === "string") {
      result[key] = value.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, KEYTAG_VALUE_MAX);
    }
  }
  return result;
}

export function keytagSampleExtras(layout: Layout): Record<string, string> {
  return Object.fromEntries(enabledKeytagExtras(layout).map(field => [
    keytagFieldBinding(field),
    field.type === "vehicleColor" ? "Silver" : field.type === "licensePlate" ? "ABC 1234" : "Bay 4",
  ]));
}

/** Validate the new definitions without rewriting legacy text or geometry. */
export function keytagExtraLayoutError(layout: unknown): string | null {
  if (layout == null) return null;
  if (typeof layout !== "object" || !Array.isArray((layout as DesignerLayout).elements)) {
    return "Invalid keytag layout";
  }
  const elements = (layout as DesignerLayout).elements;
  const bindings = new Set<string>();
  let customCount = 0;
  for (const field of elements) {
    if (!field || typeof field !== "object") return "Invalid keytag element";
    if (!isKeytagExtra(field)) continue;
    if (typeof field.label !== "string" || field.label.length > KEYTAG_LABEL_MAX ||
        /[\u0000-\u001f\u007f]/.test(field.label)) return "Extra field labels must be at most 32 characters on one line";
    if (typeof field.id !== "string" || !/^[a-zA-Z0-9_-]{1,80}$/.test(field.id) ||
        elements.filter(el => el?.id === field.id).length !== 1) return "Extra fields require unique stable IDs";
    if (field.type === "custom") {
      customCount++;
      if (!/^custom_[a-zA-Z0-9_-]+$/.test(field.id)) return "Invalid custom field binding";
    }
    const binding = keytagFieldBinding(field);
    if (bindings.has(binding)) return "Duplicate extra field binding";
    bindings.add(binding);
    if (typeof field.visible !== "boolean" || typeof field.showLabel !== "boolean" ||
        ![field.x, field.y, field.width, field.height, field.fontSize].every(Number.isFinite) ||
        field.width <= 0 || field.height <= 0 || field.fontSize <= 0) return "Invalid extra field placement";
  }
  return customCount > 3 ? "At most three custom fields are supported" : null;
}
