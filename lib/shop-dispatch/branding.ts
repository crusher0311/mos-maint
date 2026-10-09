import type { Brand } from "./model";
import { DEFAULT_BRAND } from "./model";

export interface WorkflowBranding {
  brand: Brand;
  inherited: Brand;
  source: "location" | "shop" | "enterprise" | "default";
  palette: "derived" | "fallback";
}
export interface SharedBrand {
  name: string | null;
  logo: string | null;
  colors: Pick<Brand, "primary" | "accent"> | null;
}
/** A manual workflow brand is an intentional whole-object override.
 * Missing shop fields inherit independently; generated colors never enter storage.
 */
export function resolveWorkflowBranding(location: Brand | null, shop: SharedBrand, enterprise: Brand | null): WorkflowBranding {
  const base = enterprise ?? DEFAULT_BRAND;
  const inherited = {
    name: shop.name || base.name,
    logo: shop.logo || base.logo,
    primary: shop.colors?.primary ?? base.primary,
    accent: shop.colors?.accent ?? base.accent,
  };
  return {
    brand: location ?? inherited, inherited,
    source: location ? "location" : shop.name || shop.logo ? "shop" : enterprise ? "enterprise" : "default",
    palette: shop.colors ? "derived" : "fallback",
  };
}

export function paletteFromPixels(pixels: Uint8Array | Uint8ClampedArray): SharedBrand["colors"] {
  const bins = new Map<string, { count: number; rgb: number[] }>();
  for (let i = 0; i + 3 < pixels.length; i += 4) {
    if (pixels[i + 3] < 200) continue;
    const rgb = [pixels[i], pixels[i + 1], pixels[i + 2]];
    if (Math.max(...rgb) - Math.min(...rgb) < 30) continue;
    const key = rgb.map(n => Math.floor(n / 32)).join(",");
    const bin = bins.get(key) ?? { count: 0, rgb: [0, 0, 0] };
    bin.count++;
    rgb.forEach((n, j) => bin.rgb[j] += n);
    bins.set(key, bin);
  }
  const ranked = [...bins.values()].sort((a, b) => b.count - a.count);
  if (!ranked.length) return null;
  // Darken pale marks so accents are visible on the neutral board, then text
  // uses the existing WCAG black/white foreground selection.
  const hex = (bin: typeof ranked[number]) => {
    const rgb = bin.rgb.map(n => n / bin.count);
    const scale = Math.min(1, 170 / Math.max(...rgb));
    return "#" + rgb.map(n => Math.round(n * scale).toString(16).padStart(2, "0")).join("");
  };
  return { primary: hex(ranked[0]), accent: hex(ranked[1] ?? ranked[0]) };
}
