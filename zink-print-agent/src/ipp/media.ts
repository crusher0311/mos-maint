import { Tag, type Attributes, type Value, type Values } from "./codec";

/** Dimensions are integer hundredths of a millimetre, as required by IPP. */
export interface Stock { width: number; height: number }
export interface MediaSelection { attributes: Attributes; stock: Stock }
export function validateStock(stock: Stock): void {
  if (!stock || ![stock.width, stock.height].every(n => Number.isInteger(n) && n >= 100 && n <= 50000))
    throw new Error("Invalid physical stock dimensions");
}
function collection(value: Value | undefined): Values | undefined {
  return value && typeof value === "object" && !("range" in value) ? value as Values : undefined;
}
function fits(value: Value | undefined, expected: number): boolean {
  if (typeof value === "number") return value === expected;
  if (value && typeof value === "object" && "range" in value && Array.isArray(value.range)) {
    const [min, max] = value.range;
    return typeof min === "number" && typeof max === "number" && min <= expected && expected <= max;
  }
  return false;
}

/** No rotation, guessed margins, fitting to larger sheets, or fallback to media defaults. */
export function selectMedia(attrs: Values, loaded: Stock, requested: Stock): MediaSelection {
  validateStock(loaded); validateStock(requested);
  if (loaded.width !== requested.width || loaded.height !== requested.height)
    throw new Error("Rendered size does not match enrolled loaded stock");
  if (!attrs["document-format-supported"]?.includes("image/png"))
    throw new Error("Printer does not advertise PNG support");
  if (!attrs["print-scaling-supported"]?.includes("none"))
    throw new Error("Printer does not advertise no-scaling support");
  if (!attrs["operations-supported"]?.includes(2))
    throw new Error("Printer does not advertise Print-Job support");
  const candidates = attrs["media-col-database"] ?? [];
  for (const value of candidates) {
    const entry = collection(value), size = collection(entry?.["media-size"]?.[0]);
    if (!entry || !size || !fits(size["x-dimension"]?.[0], requested.width) ||
        !fits(size["y-dimension"]?.[0], requested.height)) continue;
    // Existing PNG renderers use the whole canvas. Unknown/nonzero printable
    // margins cannot be silently cropped or scaled away.
    const sides = ["top", "bottom", "left", "right"];
    if (!sides.every(side => entry[`media-${side}-margin`]?.[0] === 0)) continue;
    const media: Attributes = {
      "media-size": { tag: Tag.collection, value: {
        "x-dimension": { tag: Tag.integer, value: requested.width },
        "y-dimension": { tag: Tag.integer, value: requested.height },
      } },
    };
    for (const side of sides) media[`media-${side}-margin`] = { tag: Tag.integer, value: 0 };
    for (const key of ["media-source", "media-type"]) {
      const v = entry[key]?.[0];
      if (typeof v === "string") media[key] = { tag: Tag.keyword, value: v };
    }
    return { stock: requested, attributes: {
      "media-col": { tag: Tag.collection, value: media },
      "print-scaling": { tag: Tag.keyword, value: "none" },
      copies: { tag: Tag.integer, value: 1 },
    } };
  }
  throw new Error("No exact borderless media capability matches the enrolled stock");
}
