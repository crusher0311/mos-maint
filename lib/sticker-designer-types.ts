export type StickerElementType = 
  | 'logo'
  | 'qrCode'
  | 'phone'
  | 'tagline'
  | 'taglineLine2'
  | 'serviceLabel'
  | 'serviceDate'
  | 'serviceMileage'
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
      content: 'Next Service Due',
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
      content: 'Next Service Due',
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
    })),
  };
}

export const STICKER_SAMPLE_DATA: Record<string, string> = {
  logo: '/api/sticker/logo/sample',
  phone: '(555) 123-4567',
  tagline: 'Your Trusted Auto Care',
  taglineLine2: 'Since 1985',
  serviceLabel: 'Next Oil Service',
  serviceDate: 'Apr 15, 2026',
  serviceMileage: '165,000 mi',
  qrCode: 'qr-placeholder',
};
