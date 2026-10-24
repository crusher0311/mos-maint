/** Versioned capture semantics. Existing immutable sheets retain their rules. */
export type CaptureKind = "tire-v1" | "battery-v1";
type Values = Record<string, string | number>;
export function captureDefinitionErrors(kind: CaptureKind | undefined, fields: {id: string; type: string; options?: string[]; unit?: string}[]): string[] {
  if (!kind) return [];
  const expected: Record<string, string> = kind === "tire-v1"
    ? {actualSize: "text", oeSize: "text", availability: "select", reason: "text", unit: "select", inner: "number", center: "number", outer: "number", beforePsi: "number", afterPsi: "number"}
    : {rated: "number", measured: "number", ratedStandard: "select", measuredStandard: "select", outcome: "select", reason: "text", voltage: "number", terminals: "text"};
  const choices: Record<string, string[]> = kind === "tire-v1"
    ? {availability: ["measured", "unable-to-measure"], unit: ["32nds", "mm"]}
    : {ratedStandard: ["CCA", "CA", "EN", "DIN"], measuredStandard: ["CCA", "CA", "EN", "DIN"], outcome: ["not-tested", "pass", "fail", "unable-to-test"]};
  const errors: string[] = [];
  for (const [id, type] of Object.entries(expected)) {
    const field = fields.find(f => f.id === id);
    if (!field || field.type !== type || choices[id] && JSON.stringify([...(field.options ?? [])].sort()) !== JSON.stringify([...choices[id]].sort()))
      errors.push(`Preserve ${kind} field ${id} and its measurement definition`);
  }
  if (fields.length !== Object.keys(expected).length) errors.push("Specialized capture requires its exact versioned fields; add other checks as separate items");
  const units: Record<string, string | undefined> = kind === "tire-v1" ? {beforePsi: "PSI", afterPsi: "PSI"} : {voltage: "V"};
  for (const field of fields) if ((field.unit || undefined) !== units[field.id])
    errors.push(`Preserve ${field.id} units; variable standards and tread units are recorded per finding`);
  return errors;
}
const present = (v: unknown) => v !== undefined && v !== "";
const numeric = (v: unknown, min: number, max: number) =>
  typeof v === "number" && Number.isFinite(v) && v >= min && v <= max;
export function captureErrors(kind: CaptureKind | undefined, values: Values, complete: boolean): string[] {
  if (!kind) return [];
  const errors: string[] = [];
  const number = (id: string, min: number, max: number, required: boolean) => {
    if ((present(values[id]) || complete && required) && !numeric(values[id], min, max))
      errors.push(`${id}: enter ${min}–${max}`);
  };
  if (kind === "tire-v1") {
    if (complete && !String(values.actualSize ?? "").trim()) errors.push("Actual tire size");
    if (complete && !["measured", "unable-to-measure"].includes(String(values.availability))) errors.push("Measurement availability");
    const unavailable = values.availability === "unable-to-measure";
    if (unavailable && complete && !String(values.reason ?? "").trim()) errors.push("Explain unavailable measurements");
    if (complete && !unavailable && !["32nds", "mm"].includes(String(values.unit))) errors.push("Explicit tread unit");
    for (const id of ["inner", "center", "outer"]) {
      if (present(values[id]) && !["32nds", "mm"].includes(String(values.unit))) errors.push(`${id}: select tread unit first`);
      number(id, 0, values.unit === "mm" ? 25 : 32, !unavailable);
    }
    number("beforePsi", 1, 120, !unavailable);
    number("afterPsi", 1, 120, false);
  } else {
    const tested = values.outcome === "pass" || values.outcome === "fail";
    if (complete && !tested && values.outcome !== "unable-to-test") errors.push("Battery manual test outcome (not tested is incomplete)");
    if (complete && values.outcome === "unable-to-test" && !String(values.reason ?? "").trim()) errors.push("Explain why battery could not be tested");
    number("rated", 1, 3000, tested);
    number("measured", 1, 3000, tested);
    number("voltage", 0, 60, false);
    if (complete && tested && (!["CCA", "CA", "EN", "DIN"].includes(String(values.ratedStandard)) ||
      values.ratedStandard !== values.measuredStandard)) errors.push("Rated and measured battery standards must match");
  }
  return errors;
}
