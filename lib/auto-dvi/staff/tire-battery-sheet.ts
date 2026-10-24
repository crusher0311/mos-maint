import { sheetSchema } from "./model";

/** Candidate only: publication/provisioning requires existing manager approval.
 * No sample measurements, demo prices, or fictional safety policy are imported. */
export const TIRE_BATTERY_SHEET = sheetSchema.parse({
  id: "tire-battery", version: 1, name: "Tire & Battery",
  items: [
    ...(["lf", "rf", "lr", "rr"] as const).map((position, index) => ({
      id: `tire.${position}`, name: `${["Left front", "Right front", "Left rear", "Right rear"][index]} tire`,
      procedure: "manual-tire-documentation-v1", position, capture: "tire-v1",
      fields: [
        {id: "actualSize", label: "Actual tire size", type: "text"},
        {id: "oeSize", label: "OE / placard reference (optional)", type: "text"},
        {id: "availability", label: "Measurement availability", type: "select", options: ["measured", "unable-to-measure"]},
        {id: "reason", label: "Unavailable measurement reason", type: "text"},
        {id: "unit", label: "Tread unit", type: "select", options: ["32nds", "mm"]},
        ...["inner", "center", "outer"].map(id => ({id, label: `${id} tread`, type: "number"})),
        {id: "beforePsi", label: "Before pressure", type: "number", unit: "PSI"},
        {id: "afterPsi", label: "After pressure (optional)", type: "number", unit: "PSI"},
      ],
      required: true, requiredFields: ["actualSize", "availability"], notesRequired: true,
      photoRequired: false, recommendationRequired: false,
    })),
    {id: "battery", name: "Battery test documentation", procedure: "manual-battery-documentation-v1", capture: "battery-v1",
      fields: [
        {id: "rated", label: "Installed battery rated cranking value", type: "number"},
        {id: "measured", label: "Measured cranking value", type: "number"},
        ...["ratedStandard", "measuredStandard"].map(id => ({id, label: id === "ratedStandard" ? "Rated standard" : "Measured standard",
          type: "select", options: ["CCA", "CA", "EN", "DIN"]})),
        {id: "outcome", label: "Technician-entered test outcome", type: "select", options: ["not-tested", "pass", "fail", "unable-to-test"]},
        {id: "reason", label: "Unable-to-test explanation", type: "text"},
        {id: "voltage", label: "Voltage (optional)", type: "number", unit: "V"},
        {id: "terminals", label: "Terminal condition (optional)", type: "text"},
      ],
      required: true, requiredFields: ["outcome"], notesRequired: true, photoRequired: false, recommendationRequired: false,
    },
  ],
});
