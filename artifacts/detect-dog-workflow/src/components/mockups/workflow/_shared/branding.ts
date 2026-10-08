import type { CSSProperties } from 'react';

export const BRANDING_VERSION = 1;
export const BRANDING_STORAGE_KEY = 'detect-dog:branding:v1';
export const MAX_LOGO_BYTES = 256 * 1024;
export const LOCATION_IDS = ['ytd', 'example'] as const;
export type LocationId = typeof LOCATION_IDS[number];
export type BrandStyle = { primary: string; accent: string; logo: string | null };
export type LocationBrand = BrandStyle & { name: string; inherit: boolean };
export type BrandingConfig = {
  version: typeof BRANDING_VERSION;
  enterprise: BrandStyle & { name: string };
  locations: Record<LocationId, LocationBrand>;
  activeLocation: LocationId;
  typography: 'sans' | 'serif';
  density: 'comfortable' | 'compact';
};
export const LOCATION_LABELS: Record<LocationId, string> = {
  ytd: 'YTD location (not onboarded)',
  example: 'Example second location (fictional)',
};

export function createDefaultBranding(): BrandingConfig {
  const style: BrandStyle = { primary: '#285746', accent: '#d66a35', logo: null };
  return {
    version: BRANDING_VERSION,
    enterprise: { ...style, name: 'Burnett' },
    locations: {
      ytd: { ...style, name: 'YTD location (not onboarded)', inherit: true },
      example: { ...style, name: 'Example second location', inherit: true },
    },
    activeLocation: 'ytd', typography: 'sans', density: 'comfortable',
  };
}

export function isHexColor(value: unknown): value is string {
  return typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value);
}

/** Only embedded raster payloads are accepted. No URLs, SVG, or external resources. */
export function validateLogoDataUrl(value: unknown): boolean {
  if (value === null) return true;
  if (typeof value !== 'string') return false;
  const match = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
  if (!match || match[2].length % 4 !== 0) return false;
  const payload = match[2];
  const bytes = payload.length * 3 / 4 - (payload.endsWith('==') ? 2 : payload.endsWith('=') ? 1 : 0);
  if (bytes > MAX_LOGO_BYTES || bytes < 12) return false;
  try {
    const head = atob(payload.slice(0, 32));
    return match[1] === 'png' ? head.startsWith('\x89PNG\r\n\x1a\n') :
      match[1] === 'jpeg' ? head.startsWith('\xff\xd8\xff') :
        head.startsWith('RIFF') && head.slice(8, 12) === 'WEBP';
  } catch { return false; }
}

function validStyle(value: unknown): value is BrandStyle {
  if (!value || typeof value !== 'object') return false;
  const style = value as BrandStyle;
  return isHexColor(style.primary) && isHexColor(style.accent) && validateLogoDataUrl(style.logo);
}
function validName(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 60;
}
export function validateBranding(value: unknown): value is BrandingConfig {
  if (!value || typeof value !== 'object') return false;
  const config = value as BrandingConfig;
  if (config.version !== BRANDING_VERSION || !validStyle(config.enterprise) || !validName(config.enterprise.name)) return false;
  if (!LOCATION_IDS.includes(config.activeLocation) || !['sans', 'serif'].includes(config.typography) || !['comfortable', 'compact'].includes(config.density)) return false;
  return LOCATION_IDS.every(id => config.locations && validStyle(config.locations[id]) &&
    validName(config.locations[id].name) && typeof config.locations[id].inherit === 'boolean');
}

export function parseStoredBranding(raw: string | null): BrandingConfig {
  if (raw === null) return createDefaultBranding();
  let value: unknown;
  try { value = JSON.parse(raw); }
  catch { throw new Error('Saved branding could not be read. Proposed defaults are shown; reset branding to replace the invalid saved configuration.'); }
  if (!validateBranding(value)) throw new Error('Saved branding is invalid or from an unsupported version. Proposed defaults are shown; reset branding to replace it.');
  // Rebuild the allowed shape, so unrelated fields can never be persisted.
  const style = (v: BrandStyle): BrandStyle => ({ primary: v.primary, accent: v.accent, logo: v.logo });
  return {
    version: BRANDING_VERSION,
    enterprise: { ...style(value.enterprise), name: value.enterprise.name.trim() },
    locations: {
      ytd: { ...style(value.locations.ytd), name: value.locations.ytd.name.trim(), inherit: value.locations.ytd.inherit },
      example: { ...style(value.locations.example), name: value.locations.example.name.trim(), inherit: value.locations.example.inherit },
    },
    activeLocation: value.activeLocation, typography: value.typography, density: value.density,
  };
}

export function resolveBranding(config: BrandingConfig, id: LocationId = config.activeLocation) {
  const location = config.locations[id];
  const style = location.inherit ? config.enterprise : location;
  return { ...style, enterpriseName: config.enterprise.name, locationName: location.name, inherited: location.inherit };
}

/** WCAG luminance chooses the higher-contrast of black and white (>= 4.5:1). */
export function contrastForeground(hex: string): '#000000' | '#ffffff' {
  if (!isHexColor(hex)) return '#000000';
  const [r, g, b] = [1, 3, 5].map(i => {
    const channel = parseInt(hex.slice(i, i + 2), 16) / 255;
    return channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4;
  });
  const luminance = .2126 * r + .7152 * g + .0722 * b;
  return (luminance + .05) / .05 >= 1.05 / (luminance + .05) ? '#000000' : '#ffffff';
}

export function mixWithNeutral(hex: string, amount: number, neutral = '#fafbf5'): string {
  const ratio = Math.max(0, Math.min(1, amount));
  return '#' + [1, 3, 5].map(i => Math.round(parseInt(hex.slice(i, i + 2), 16) * ratio +
    parseInt(neutral.slice(i, i + 2), 16) * (1 - ratio)).toString(16).padStart(2, '0')).join('');
}

export function brandingTheme(config: BrandingConfig): CSSProperties {
  const brand = resolveBranding(config);
  return {
    '--forest': brand.primary, '--accent': brand.accent,
    '--primary-foreground': contrastForeground(brand.primary),
    '--accent-foreground': contrastForeground(brand.accent),
    '--paper': mixWithNeutral(brand.primary, .055),
    '--surface': '#fafbf5', '--mint': mixWithNeutral(brand.primary, .11),
    '--line': mixWithNeutral(brand.primary, .22),
    '--quiet': '#4f6158',
    fontFamily: config.typography === 'serif' ? 'Georgia, "Times New Roman", serif' : '"Aptos", "Segoe UI", system-ui, sans-serif',
  } as CSSProperties;
}

export function decodeRasterLogo(data: string): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!validateLogoDataUrl(data)) { reject(new Error('Choose a valid PNG, JPEG, or WebP image, at most 256 KB.')); return; }
    const image = new Image();
    image.onload = () => image.naturalWidth > 0 && image.naturalHeight > 0 ? resolve() : reject(new Error('The logo could not be decoded.'));
    image.onerror = () => reject(new Error('The logo could not be decoded. Choose another raster image.'));
    image.src = data;
  });
}

export async function readRasterLogo(file: File): Promise<string> {
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type) || file.size > MAX_LOGO_BYTES || !file.size) {
    throw new Error('Choose PNG, JPEG, or WebP only, at most 256 KB. SVG and URLs are not supported.');
  }
  const data = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => typeof reader.result === 'string' ? resolve(reader.result) : reject(new Error('Could not read this file.'));
    reader.onerror = () => reject(new Error('Could not read this file. Please try another image.'));
    reader.readAsDataURL(file);
  });
  await decodeRasterLogo(data);
  return data;
}
