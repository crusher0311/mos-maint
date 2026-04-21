export interface PaperSizePreset {
  id: string;
  label: string;
  brand: string;
  widthIn: number;
  heightIn: number;
  defaultDpi: number;
}

export const PAPER_SIZE_PRESETS: PaperSizePreset[] = [
  { id: "dymo_30252",     label: "Dymo 30252 — Address (1.125\" × 3.5\")",      brand: "Dymo",    widthIn: 3.5,   heightIn: 1.125, defaultDpi: 300 },
  { id: "dymo_30334",     label: "Dymo 30334 — Multipurpose (1.25\" × 2.25\")", brand: "Dymo",    widthIn: 2.25,  heightIn: 1.25,  defaultDpi: 300 },
  { id: "dymo_30336",     label: "Dymo 30336 — Small (1\" × 2.125\")",          brand: "Dymo",    widthIn: 2.125, heightIn: 1.0,   defaultDpi: 300 },
  { id: "dymo_30323",     label: "Dymo 30323 — Shipping (2.125\" × 4\")",       brand: "Dymo",    widthIn: 4.0,   heightIn: 2.125, defaultDpi: 300 },
  { id: "avery_5160",     label: "Avery 5160 — Address (1\" × 2.625\")",        brand: "Avery",   widthIn: 2.625, heightIn: 1.0,   defaultDpi: 300 },
  { id: "avery_5163",     label: "Avery 5163 — Shipping (2\" × 4\")",           brand: "Avery",   widthIn: 4.0,   heightIn: 2.0,   defaultDpi: 300 },
  { id: "brother_dk1201", label: "Brother DK-1201 — Address (1.1\" × 3.5\")",   brand: "Brother", widthIn: 3.5,   heightIn: 1.1,   defaultDpi: 300 },
  { id: "brother_dk1202", label: "Brother DK-1202 — Shipping (2.4\" × 3.9\")",  brand: "Brother", widthIn: 3.9,   heightIn: 2.4,   defaultDpi: 300 },
  { id: "brother_dk1208", label: "Brother DK-1208 — Lg Address (1.5\" × 3.5\")",brand: "Brother", widthIn: 3.5,   heightIn: 1.5,   defaultDpi: 300 },
  { id: "brother_dk1209", label: "Brother DK-1209 — Sm Address (1.1\" × 2.4\")",brand: "Brother", widthIn: 2.4,   heightIn: 1.1,   defaultDpi: 300 },
  { id: "brother_dk2205", label: "Brother DK-2205 — Continuous (2.4\" wide)",   brand: "Brother", widthIn: 3.5,   heightIn: 2.4,   defaultDpi: 300 },
  { id: "brother_dk2210", label: "Brother DK-2210 — Continuous (1.1\" wide)",   brand: "Brother", widthIn: 3.5,   heightIn: 1.1,   defaultDpi: 300 },
  { id: "zebra_4x6",      label: "Zebra 4×6 Thermal",                            brand: "Zebra",   widthIn: 4.0,   heightIn: 6.0,   defaultDpi: 203 },
  { id: "generic_2x4",    label: "Generic 2\" × 4\"",                            brand: "Generic", widthIn: 4.0,   heightIn: 2.0,   defaultDpi: 300 },
];

export const DEFAULT_PAPER_SIZE_ID = "dymo_30252";

export interface PaperSizeConfig {
  presetId: string;
  custom?: {
    width: number;
    height: number;
    units: "in" | "mm";
    dpi: number;
  };
}

export interface ResolvedPaperSize {
  id: string;
  label: string;
  isCustom: boolean;
  widthIn: number;
  heightIn: number;
  dpi: number;
  designWidth: number;
  designHeight: number;
  renderWidth: number;
  renderHeight: number;
}

export const DESIGN_UNITS_PER_INCH = 100;
const COMMON_DPI_OPTIONS = [203, 300, 600] as const;
export const SUPPORTED_DPI_OPTIONS: readonly number[] = COMMON_DPI_OPTIONS;
export const SUPPORTED_UNIT_OPTIONS = ["in", "mm"] as const;

const MIN_DIM_IN = 0.25;
const MAX_DIM_IN = 12;

function mmToIn(mm: number): number {
  return mm / 25.4;
}

function clampIn(v: number): number {
  if (!Number.isFinite(v) || v <= 0) return MIN_DIM_IN;
  return Math.min(MAX_DIM_IN, Math.max(MIN_DIM_IN, v));
}

function buildResolved(
  id: string,
  label: string,
  isCustom: boolean,
  widthIn: number,
  heightIn: number,
  dpi: number
): ResolvedPaperSize {
  const w = clampIn(widthIn);
  const h = clampIn(heightIn);
  const d = dpi && dpi > 0 ? dpi : 300;
  return {
    id,
    label,
    isCustom,
    widthIn: w,
    heightIn: h,
    dpi: d,
    designWidth: Math.round(w * DESIGN_UNITS_PER_INCH),
    designHeight: Math.round(h * DESIGN_UNITS_PER_INCH),
    renderWidth: Math.round(w * d),
    renderHeight: Math.round(h * d),
  };
}

export function getPresetById(id: string): PaperSizePreset | undefined {
  return PAPER_SIZE_PRESETS.find((p) => p.id === id);
}

export function resolvePaperSize(config?: PaperSizeConfig | null): ResolvedPaperSize {
  if (!config || !config.presetId) {
    const def = getPresetById(DEFAULT_PAPER_SIZE_ID)!;
    return buildResolved(def.id, def.label, false, def.widthIn, def.heightIn, def.defaultDpi);
  }

  if (config.presetId === "custom") {
    const c = config.custom;
    if (!c) {
      const def = getPresetById(DEFAULT_PAPER_SIZE_ID)!;
      return buildResolved(def.id, def.label, false, def.widthIn, def.heightIn, def.defaultDpi);
    }
    const widthIn = c.units === "mm" ? mmToIn(c.width) : c.width;
    const heightIn = c.units === "mm" ? mmToIn(c.height) : c.height;
    return buildResolved("custom", "Custom", true, widthIn, heightIn, c.dpi || 300);
  }

  const preset = getPresetById(config.presetId);
  if (!preset) {
    const def = getPresetById(DEFAULT_PAPER_SIZE_ID)!;
    return buildResolved(def.id, def.label, false, def.widthIn, def.heightIn, def.defaultDpi);
  }
  return buildResolved(preset.id, preset.label, false, preset.widthIn, preset.heightIn, preset.defaultDpi);
}

export interface RescalableElement {
  x: number;
  y: number;
  width: number;
  height: number;
  fontSize: number;
}

export function rescaleElements<T extends RescalableElement>(
  elements: T[],
  oldWidth: number,
  oldHeight: number,
  newWidth: number,
  newHeight: number
): T[] {
  if (!oldWidth || !oldHeight) return elements;
  const sx = newWidth / oldWidth;
  const sy = newHeight / oldHeight;
  const fontScale = Math.min(sx, sy);
  return elements.map((el) => ({
    ...el,
    x: Math.max(0, el.x * sx),
    y: Math.max(0, el.y * sy),
    width: Math.max(10, el.width * sx),
    height: Math.max(8, el.height * sy),
    fontSize: Math.max(6, Math.round(el.fontSize * fontScale)),
  }));
}
