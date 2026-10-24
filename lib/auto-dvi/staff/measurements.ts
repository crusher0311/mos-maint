import type {StaffItem, Finding} from "./model";
/** Shared projection of recorded units. Never converts or supplies a reading. */
export function inspectionMeasurements(item: StaffItem, finding: Finding) {
  const measurements = item.fields.filter(f => finding.values[f.id] !== undefined && finding.values[f.id] !== "")
    .map(f => {
      let unit = f.unit ?? null;
      if (item.capture === "tire-v1" && ["inner", "center", "outer"].includes(f.id))
        unit = finding.values.unit === "32nds" ? "/32 in" : finding.values.unit === "mm" ? "mm" : null;
      if (item.capture === "battery-v1" && ["rated", "measured"].includes(f.id))
        unit = String(finding.values[f.id === "rated" ? "ratedStandard" : "measuredStandard"] ?? "") || null;
      return {label: f.label, value: finding.values[f.id], unit};
    });
  if (item.capture === "battery-v1" && !["pass", "fail"].includes(String(finding.values.outcome)))
    measurements.push({label: "Battery test completeness", value: "Not a completed battery test", unit: null});
  if (item.capture === "tire-v1" && finding.values.afterPsi === undefined)
    measurements.push({label: "After pressure", value: "Not recorded; no adjustment claimed", unit: null});
  return measurements;
}
