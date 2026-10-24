"use client";
import type { FindingInput, StaffItem } from "@/lib/auto-dvi/staff/model";
import ui from "./StaffInspectionPanel.module.css";

export function captureKind(item: StaffItem) {
  return (item as StaffItem & { capture?: "tire-v1" | "battery-v1" }).capture;
}

export function StaffCaptureEditor({ item, id, value, onChange }: {
  item: StaffItem; id: string; value: FindingInput; onChange: (value: FindingInput) => void;
}) {
  const kind = captureKind(item);
  const values = value.values;
  const text = (key: string) => String(values[key] ?? "");
  function change(key: string, entry: string, numeric = false) {
    const next = { ...values, [key]: entry === "" ? "" : numeric ? Number(entry) : entry };
    if (kind === "tire-v1" && key === "unit" && entry !== text("unit")) {
      next.inner = ""; next.center = ""; next.outer = "";
    }
    onChange({ ...value, values: next });
  }
  function input(key: string, label: string, numeric = false, hint?: string) {
    return <label htmlFor={`${id}-${key}`}>{label}<input id={`${id}-${key}`} type={numeric ? "number" : "text"} inputMode={numeric ? "decimal" : undefined}
      min={numeric ? 0 : undefined} max={numeric ? 100000 : undefined} step={numeric ? "any" : undefined} maxLength={150}
      value={text(key)} onChange={event => change(key, event.target.value, numeric)} aria-describedby={hint ? `${id}-${key}-hint` : undefined} />
      {hint && <small id={`${id}-${key}-hint`}>{hint}</small>}</label>;
  }
  function select(key: string, label: string, choices: readonly (readonly [string, string])[]) {
    return <label htmlFor={`${id}-${key}`}>{label}<select id={`${id}-${key}`} value={text(key)} onChange={event => change(key, event.target.value)}>
      <option value="">Not entered</option>{choices.map(([key, label]) => <option key={key} value={key}>{label}</option>)}
    </select></label>;
  }
  const standards = [["CCA", "CCA"], ["CA", "CA"], ["EN", "EN"], ["DIN", "DIN"]] as const;
  const mismatch = !!text("ratedStandard") && !!text("measuredStandard") && text("ratedStandard") !== text("measuredStandard");
  return <div className={ui.capture}>
    <h5>{kind === "tire-v1" ? `Tire measurements${item.position ? ` · ${item.position.toUpperCase()}` : ""}` : "Manual battery test"}</h5>
    {kind === "tire-v1" ? <>
      <p>Record this tire only. Each position is independent; nothing is copied to another tire.</p>
      <div className={ui.documentation}>
        {input("actualSize", "Actual tire size")}{input("oeSize", "OE tire size")}
        {select("availability", "Measurement availability", [["measured", "Measured"], ["unable-to-measure", "Unable to measure"]])}
        {select("unit", "Tread depth unit", [["32nds", "32nds of an inch"], ["mm", "Millimeters (mm)"]])}
      </div>
      <p id={`${id}-unit-help`}>Changing the unit clears all three tread depths in this draft. No conversion is applied.</p>
      <div className={ui.tread} aria-describedby={`${id}-unit-help`}>
        {input("inner", `Inner tread${text("unit") ? ` (${text("unit")})` : ""}`, true)}
        {input("center", `Center tread${text("unit") ? ` (${text("unit")})` : ""}`, true)}
        {input("outer", `Outer tread${text("unit") ? ` (${text("unit")})` : ""}`, true)}
      </div>
      <div className={ui.documentation}>{input("beforePsi", "Before pressure (PSI)", true)}{input("afterPsi", "After pressure (PSI) · optional", true, "Independent of before pressure. Enter only if measured; leaving this blank does not imply an adjustment.")}</div>
      {text("availability") === "unable-to-measure" && <div className={ui.documentation}>{input("reason", "Reason unable to measure · required")}</div>}
    </> : <>
      <p>Enter the label and tester readings in their original standards. Select the outcome manually; no pass/fail result is inferred.</p>
      <div className={ui.documentation}>
        {input("rated", "Rated battery value", true)}{select("ratedStandard", "Rated standard", standards)}
        {input("measured", "Measured battery value", true)}{select("measuredStandard", "Measured standard", standards)}
      </div>
      {mismatch && <p role="status" className={ui.missing}>Standards differ: {text("ratedStandard")} rated / {text("measuredStandard")} measured. These readings are not directly comparable. No conversion or outcome is inferred.</p>}
      <div className={ui.documentation}>
        {select("outcome", "Manual test outcome", [["not-tested", "Not tested"], ["pass", "Pass"], ["fail", "Fail"], ["unable-to-test", "Unable to test"]])}
        {input("voltage", "Measured voltage (V)", true)}{input("terminals", "Terminal condition")}
        {text("outcome") === "unable-to-test" && input("reason", "Reason unable to test · required")}
      </div>
    </>}
  </div>;
}
