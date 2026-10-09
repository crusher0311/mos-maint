/** Provider employee objects are identities, never strings to coerce. */
export function protractorTechnician(value: unknown, fallbackName?: unknown): {
  technicianId?: string; technicianName?: string;
} {
  const text = (v: unknown): string | undefined =>
    typeof v === "string" && v.trim() && v.trim() !== "[object Object]"
      ? v.trim() : undefined;
  const person = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
  const name = person?.Name;
  const structured = name && typeof name === "object" && !Array.isArray(name)
    ? name as Record<string, unknown> : undefined;
  const joined = structured
    ? [text(structured.FirstName), text(structured.LastName)].filter(Boolean).join(" ")
    : undefined;
  return {
    technicianId: text(person?.ID),
    technicianName: text(name) ?? text(joined) ?? text(value) ?? text(fallbackName),
  };
}
