import { validStickerColor } from "./sticker-colors";

export type StickerElementType = 
  | 'logo'
  | 'qrCode'
  | 'phone'
  | 'tagline'
  | 'taglineLine2'
  | 'serviceLabel'
  | 'serviceDate'
  | 'serviceMileage'
  | 'oilViscosity'
  | 'text';

export interface StickerElement {
  id: string;
  type: StickerElementType;
  label: string;
  x: number;
  y: number;
  width: number;
  height: number;
  fontSize: number;
  fontWeight: 'normal' | 'bold';
  fontStyle: 'normal' | 'italic';
  textAlign: 'left' | 'center' | 'right';
  color: string;
  backgroundColor?: string;
  underline?: boolean;
  borderColor?: string;
  borderWidth?: number;
  visible: boolean;
  showLabel?: boolean;
  imageFit?: 'contain' | 'cover';
  content?: string;
}

export interface StickerLayout {
  elements: StickerElement[];
  canvasWidth: number;
  canvasHeight: number;
  gridSize: number;
  showGrid: boolean;
  backgroundColor: string;
  version: number;
}

export interface StickerSizeConfig {
  value: string;
  label: string;
  widthInches: number;
  heightInches: number;
  canvasWidth: number;
  canvasHeight: number;
  renderWidth: number;
  renderHeight: number;
}

export const STICKER_SIZES: StickerSizeConfig[] = [
  {
    value: '1.5x2.25',
    label: '1.5" x 2.25" (Mono)',
    widthInches: 1.5,
    heightInches: 2.25,
    canvasWidth: 150,
    canvasHeight: 225,
    renderWidth: 450,
    renderHeight: 675,
  },
  {
    value: '2x2',
    label: '2" x 2"',
    widthInches: 2,
    heightInches: 2,
    canvasWidth: 200,
    canvasHeight: 200,
    renderWidth: 600,
    renderHeight: 600,
  },
  {
    value: '2x2.5',
    label: '2" x 2.5"',
    widthInches: 2,
    heightInches: 2.5,
    canvasWidth: 200,
    canvasHeight: 250,
    renderWidth: 600,
    renderHeight: 750,
  },
  {
    value: '2x3',
    label: '2" x 3"',
    widthInches: 2,
    heightInches: 3,
    canvasWidth: 200,
    canvasHeight: 300,
    renderWidth: 600,
    renderHeight: 900,
  },
  {
    value: '2x3.5',
    label: '2" x 3.5"',
    widthInches: 2,
    heightInches: 3.5,
    canvasWidth: 200,
    canvasHeight: 350,
    renderWidth: 600,
    renderHeight: 1050,
  },
];

export const DEFAULT_STICKER_SIZE = '2x2';

export function getStickerSize(sizeValue: string): StickerSizeConfig {
  return STICKER_SIZES.find(s => s.value === sizeValue) || STICKER_SIZES[2];
}

export function createDefaultElements(size: StickerSizeConfig): StickerElement[] {
  const { canvasWidth, canvasHeight } = size;
  
  // For 2x2 size, use the optimized layout with QR on left
  if (size.value === '2x2') {
    return create2x2DefaultElements();
  }
  
  // For other sizes, use centered layout
  const centerX = canvasWidth / 2;
  
  return [
    {
      id: 'logo',
      type: 'logo',
      label: 'Logo',
      x: centerX - 40,
      y: 8,
      width: 80,
      height: 35,
      fontSize: 12,
      fontWeight: 'normal',
      fontStyle: 'normal',
      textAlign: 'center',
      color: '#000000',
      visible: true,
      imageFit: 'contain',
    },
    {
      id: 'phone',
      type: 'phone',
      label: 'Phone',
      x: centerX - 60,
      y: 45,
      width: 120,
      height: 18,
      fontSize: 14,
      fontWeight: 'bold',
      fontStyle: 'normal',
      textAlign: 'center',
      color: '#000000',
      visible: true,
    },
    {
      id: 'tagline',
      type: 'tagline',
      label: 'Tagline',
      x: centerX - 70,
      y: 65,
      width: 140,
      height: 16,
      fontSize: 11,
      fontWeight: 'normal',
      fontStyle: 'italic',
      textAlign: 'center',
      color: '#000000',
      visible: true,
    },
    {
      id: 'taglineLine2',
      type: 'taglineLine2',
      label: 'Tagline Line 2',
      x: centerX - 70,
      y: 82,
      width: 140,
      height: 16,
      fontSize: 11,
      fontWeight: 'normal',
      fontStyle: 'italic',
      textAlign: 'center',
      color: '#000000',
      visible: false,
    },
    {
      id: 'serviceLabel',
      type: 'serviceLabel',
      label: 'Service Label',
      x: centerX - 60,
      y: 100,
      width: 120,
      height: 18,
      fontSize: 12,
      fontWeight: 'normal',
      fontStyle: 'normal',
      textAlign: 'center',
      color: '#000000',
      visible: true,
    },
    {
      id: 'serviceDate',
      type: 'serviceDate',
      label: 'Service Date',
      x: centerX - 50,
      y: 120,
      width: 100,
      height: 22,
      fontSize: 14,
      fontWeight: 'bold',
      fontStyle: 'normal',
      textAlign: 'center',
      color: '#cc0000',
      visible: true,
    },
    {
      id: 'serviceMileage',
      type: 'serviceMileage',
      label: 'Service Mileage',
      x: centerX - 50,
      y: 144,
      width: 100,
      height: 22,
      fontSize: 14,
      fontWeight: 'bold',
      fontStyle: 'normal',
      textAlign: 'center',
      color: '#cc0000',
      visible: true,
    },
    {
      id: 'qrCode',
      type: 'qrCode',
      label: 'QR Code',
      x: centerX - 40,
      y: canvasHeight - 90,
      width: 80,
      height: 80,
      fontSize: 12,
      fontWeight: 'normal',
      fontStyle: 'normal',
      textAlign: 'center',
      color: '#000000',
      visible: true,
    },
  ];
}

// 2x2 default template: Logo/Phone/Tagline top, QR left, Service info right
function create2x2DefaultElements(): StickerElement[] {
  return [
    {
      id: 'logo',
      type: 'logo',
      label: 'Logo',
      x: 5,
      y: 5,
      width: 55,
      height: 55,
      fontSize: 12,
      fontWeight: 'normal',
      fontStyle: 'normal',
      textAlign: 'center',
      color: '#000000',
      visible: true,
      imageFit: 'contain',
    },
    {
      id: 'phone',
      type: 'phone',
      label: 'Phone',
      x: 65,
      y: 35,
      width: 130,
      height: 18,
      fontSize: 14,
      fontWeight: 'bold',
      fontStyle: 'normal',
      textAlign: 'left',
      color: '#000000',
      visible: true,
    },
    {
      id: 'tagline',
      type: 'tagline',
      label: 'Tagline',
      x: 65,
      y: 53,
      width: 130,
      height: 16,
      fontSize: 11,
      fontWeight: 'normal',
      fontStyle: 'italic',
      textAlign: 'left',
      color: '#000000',
      visible: true,
    },
    {
      id: 'taglineLine2',
      type: 'taglineLine2',
      label: 'Tagline Line 2',
      x: 65,
      y: 68,
      width: 130,
      height: 16,
      fontSize: 11,
      fontWeight: 'normal',
      fontStyle: 'italic',
      textAlign: 'left',
      color: '#000000',
      visible: false,
    },
    {
      id: 'qrCode',
      type: 'qrCode',
      label: 'QR Code',
      x: 5,
      y: 115,
      width: 80,
      height: 80,
      fontSize: 12,
      fontWeight: 'normal',
      fontStyle: 'normal',
      textAlign: 'center',
      color: '#000000',
      visible: true,
    },
    {
      id: 'serviceLabel',
      type: 'serviceLabel',
      label: 'Service Label',
      x: 90,
      y: 115,
      width: 105,
      height: 18,
      fontSize: 12,
      fontWeight: 'bold',
      fontStyle: 'normal',
      textAlign: 'left',
      color: '#000000',
      visible: true,
    },
    {
      id: 'serviceDate',
      type: 'serviceDate',
      label: 'Service Date',
      x: 90,
      y: 138,
      width: 105,
      height: 24,
      fontSize: 16,
      fontWeight: 'bold',
      fontStyle: 'normal',
      textAlign: 'left',
      color: '#cc0000',
      visible: true,
    },
    {
      id: 'serviceMileage',
      type: 'serviceMileage',
      label: 'Service Mileage',
      x: 90,
      y: 165,
      width: 105,
      height: 24,
      fontSize: 16,
      fontWeight: 'bold',
      fontStyle: 'normal',
      textAlign: 'left',
      color: '#cc0000',
      visible: true,
    },
  ];
}

export function createDefaultLayout(sizeValue: string = DEFAULT_STICKER_SIZE): StickerLayout {
  const size = getStickerSize(sizeValue);
  return {
    elements: createDefaultElements(size),
    canvasWidth: size.canvasWidth,
    canvasHeight: size.canvasHeight,
    gridSize: 5,
    showGrid: true,
    backgroundColor: '#FFFFFF',
    version: 1,
  };
}

export function scaleLayoutToSize(layout: StickerLayout, newSizeValue: string): StickerLayout {
  const newSize = getStickerSize(newSizeValue);
  const scaleX = newSize.canvasWidth / layout.canvasWidth;
  const scaleY = newSize.canvasHeight / layout.canvasHeight;
  // Use uniform scale for fontSize to maintain proportions
  const scale = Math.min(scaleX, scaleY);
  
  return {
    ...layout,
    canvasWidth: newSize.canvasWidth,
    canvasHeight: newSize.canvasHeight,
    elements: layout.elements.map(el => ({
      ...el,
      x: Math.round(el.x * scaleX),
      y: Math.round(el.y * scaleY),
      width: Math.round(el.width * scaleX),
      height: Math.round(el.height * scaleY),
      fontSize: Math.round(el.fontSize * scale),
      ...(el.borderWidth === undefined ? {} : { borderWidth: Math.min(MAX_STICKER_BORDER_WIDTH, el.borderWidth * scale) }),
    })),
  };
}

// Single source of truth for the Service Label fallback. Used by BOTH the
// designer preview and the node-canvas printer so they can never drift.
// The main Service Label is authoritative, including for legacy layouts.
export const SERVICE_LABEL_FALLBACK = 'Next Service Due';
export const MAX_STICKER_ELEMENTS = 32;
export const MAX_CUSTOM_TEXT_ELEMENTS = 12;
export const MAX_STICKER_TEXT_LENGTH = 200;
export const MAX_STICKER_BORDER_WIDTH = 4;

// Validate without normalizing saved layout data.
export function validStickerLayout(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const l = value as StickerLayout;
  const number = (v: unknown, min: number, max: number) =>
    typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max;
  const color = validStickerColor;
  const text = (v: unknown, max: number) => typeof v === 'string' && v.length <= max && !/[\r\n\u2028\u2029]/.test(v);
  if (!number(l.canvasWidth, 1, 1000) || !number(l.canvasHeight, 1, 1000) ||
      !number(l.gridSize, 1, 100) || typeof l.showGrid !== 'boolean' || !color(l.backgroundColor) ||
      (l.version !== undefined && !number(l.version, 1, 100)) ||
      !Array.isArray(l.elements) || l.elements.length > MAX_STICKER_ELEMENTS) return false;
  const ids = new Set<string>();
  let custom = 0;
  return l.elements.every(e => {
    if (!e || !text(e.id, 100) || !e.id || ids.has(e.id)) return false;
    ids.add(e.id);
    if (e.type === 'text' && ++custom > MAX_CUSTOM_TEXT_ELEMENTS) return false;
    return ['logo','qrCode','phone','tagline','taglineLine2','serviceLabel','serviceDate','serviceMileage','oilViscosity','text'].includes(e.type) &&
      text(e.label, 200) && number(e.x, -1000, 1000) && number(e.y, -1000, 1000) &&
      number(e.width, 1, 1000) && number(e.height, 1, 1000) && number(e.fontSize, 1, 200) &&
      ['normal','bold'].includes(e.fontWeight) && ['normal','italic'].includes(e.fontStyle) &&
      ['left','center','right'].includes(e.textAlign) && color(e.color) && typeof e.visible === 'boolean' &&
      (e.content === undefined || text(e.content, MAX_STICKER_TEXT_LENGTH)) &&
      (e.backgroundColor === undefined || color(e.backgroundColor)) &&
      (e.underline === undefined || typeof e.underline === 'boolean') &&
      (e.borderColor === undefined || color(e.borderColor)) &&
      (e.borderWidth === undefined || number(e.borderWidth, 0, MAX_STICKER_BORDER_WIDTH));
  });
}

export const STICKER_SAMPLE_DATA: Record<string, string> = {
  logo: '/api/sticker/logo/sample',
  phone: '(555) 123-4567',
  tagline: 'Your Trusted Auto Care',
  taglineLine2: 'Since 1985',
  serviceLabel: SERVICE_LABEL_FALLBACK,
  serviceDate: 'Apr 15, 2026',
  serviceMileage: '165,000 mi',
  oilViscosity: '5W-30',
  qrCode: 'qr-placeholder',
};

// Effective content values for a sticker, with date/mileage already formatted
// the way they will be rendered.
export interface StickerContentValues {
  oilViscosity?: string;
  phone?: string;
  tagline?: string;
  taglineLine2?: string;
  serviceLabel?: string;
  serviceDate?: string;
  serviceMileage?: string;
}

// Shared resolution rule for what text an element renders. This is the single
// source of truth used by the designer preview (StickerDesignerCanvas) and the
// node-canvas printer (renderStickerDesigner) so the preview is always WYSIWYG.
// Service labels ignore saved element content; all other text rules are unchanged.
export function resolveStickerElementContent(
  el: { type: string; content?: string },
  data: StickerContentValues
): string {
  switch (el.type) {
    case 'oilViscosity':
      return data.oilViscosity ? `Oil: ${data.oilViscosity}` : '';
    case 'phone':
      return data.phone || '';
    case 'tagline':
      return data.tagline || '';
    case 'taglineLine2':
      return data.taglineLine2 || '';
    case 'serviceLabel':
      return data.serviceLabel?.trim() ? data.serviceLabel : SERVICE_LABEL_FALLBACK;
    case 'serviceDate':
      return data.serviceDate || '';
    case 'serviceMileage':
      return data.serviceMileage || '';
    default:
      return el.content || '';
  }
}
