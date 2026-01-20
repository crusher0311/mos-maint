export interface DesignerElement {
  id: string;
  type: 'customerName' | 'vehicleInfo' | 'vin' | 'roNumber' | 'mileage' | 'text';
  label: string;
  x: number;
  y: number;
  width: number;
  height: number;
  fontSize: number;
  fontWeight: 'normal' | 'bold';
  fontStyle: 'normal' | 'italic';
  textAlign: 'left' | 'center' | 'right';
  showLabel: boolean;
  visible: boolean;
  labelFontWeight?: 'normal' | 'bold';
  labelFontStyle?: 'normal' | 'italic';
  valueFontWeight?: 'normal' | 'bold';
  valueFontStyle?: 'normal' | 'italic';
}

export interface DesignerLayout {
  elements: DesignerElement[];
  canvasWidth: number;
  canvasHeight: number;
  gridSize: number;
  showGrid: boolean;
  backgroundColor: string;
  textColor: string;
}

export const DYMO_30252 = {
  width: 350,
  height: 112.5,
  actualWidth: 3.5,
  actualHeight: 1.125,
  dpi: 300,
  renderWidth: 1050,
  renderHeight: 338,
};

export const DEFAULT_ELEMENTS: DesignerElement[] = [
  {
    id: 'customerName',
    type: 'customerName',
    label: 'Customer',
    x: 10,
    y: 20,
    width: 150,
    height: 35,
    fontSize: 18,
    fontWeight: 'bold',
    fontStyle: 'normal',
    textAlign: 'left',
    showLabel: false,
    visible: true,
  },
  {
    id: 'vehicleInfo',
    type: 'vehicleInfo',
    label: 'Vehicle',
    x: 10,
    y: 55,
    width: 150,
    height: 30,
    fontSize: 14,
    fontWeight: 'normal',
    fontStyle: 'normal',
    textAlign: 'left',
    showLabel: false,
    visible: true,
  },
  {
    id: 'vin',
    type: 'vin',
    label: 'VIN',
    x: 180,
    y: 15,
    width: 160,
    height: 25,
    fontSize: 12,
    fontWeight: 'normal',
    fontStyle: 'normal',
    textAlign: 'left',
    showLabel: true,
    visible: true,
  },
  {
    id: 'mileage',
    type: 'mileage',
    label: 'Mileage',
    x: 180,
    y: 42,
    width: 160,
    height: 25,
    fontSize: 12,
    fontWeight: 'bold',
    fontStyle: 'normal',
    textAlign: 'left',
    showLabel: true,
    visible: true,
  },
  {
    id: 'roNumber',
    type: 'roNumber',
    label: 'RO#',
    x: 180,
    y: 69,
    width: 160,
    height: 25,
    fontSize: 12,
    fontWeight: 'bold',
    fontStyle: 'normal',
    textAlign: 'left',
    showLabel: true,
    visible: true,
  },
];

export const DEFAULT_LAYOUT: DesignerLayout = {
  elements: DEFAULT_ELEMENTS,
  canvasWidth: DYMO_30252.width,
  canvasHeight: DYMO_30252.height,
  gridSize: 10,
  showGrid: true,
  backgroundColor: '#FFFFFF',
  textColor: '#000000',
};

export const SAMPLE_DATA: Record<string, string> = {
  customerName: 'JOHN SMITH',
  vehicleInfo: '2018 TOYOTA CAMRY',
  vin: '4T1BF1FK8JU123456',
  roNumber: '456789',
  mileage: '124,382',
};
