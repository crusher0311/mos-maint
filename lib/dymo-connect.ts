/**
 * DYMO Connect SDK client
 * 
 * Uses DYMO's official JavaScript framework which handles CORS internally.
 * Requires DYMO Connect software installed on the user's machine.
 */

declare global {
  interface Window {
    dymo?: {
      label: {
        framework: {
          init: (callback?: () => void) => void;
          checkEnvironment: () => {
            isFrameworkInstalled: boolean;
            isBrowserSupported: boolean;
            isWebServicePresent: boolean;
            errorDetails?: string;
          };
          getPrinters: () => DymoPrinter[];
          openLabelXml: (xml: string) => DymoLabel;
          renderLabel: (labelXml: string, renderParams: string, printerName: string) => string;
          createLabelWriterPrintParamsXml: (params: {
            copies?: number;
            jobTitle?: string;
            twinTurboRoll?: string;
          }) => string;
          TwinTurboRoll: {
            Left: string;
            Right: string;
            Auto: string;
          };
        };
      };
    };
  }
}

export type TwinTurboRoll = 'Auto' | 'Left' | 'Right';

export interface DymoPrinter {
  name: string;
  modelName: string;
  isConnected: boolean;
  isLocal: boolean;
  isTwinTurbo: boolean;
}

export interface DymoLabel {
  print: (printerName: string, printParams?: string, labelSetXml?: string) => void;
  setObjectText: (objectName: string, text: string) => void;
  isValidLabel: () => boolean;
}

export interface DymoEnvironment {
  isFrameworkInstalled: boolean;
  isBrowserSupported: boolean;
  isWebServicePresent: boolean;
  errorDetails?: string;
}

const DYMO_SDK_URL = 'https://labelwriter.com/software/dls/sdk/js/DYMO.Label.Framework.3.0.js';

let sdkLoaded = false;
let sdkLoadPromise: Promise<boolean> | null = null;

export async function loadDymoSdk(): Promise<boolean> {
  if (sdkLoaded && window.dymo) {
    return true;
  }

  if (sdkLoadPromise) {
    return sdkLoadPromise;
  }

  sdkLoadPromise = new Promise((resolve) => {
    if (window.dymo) {
      sdkLoaded = true;
      resolve(true);
      return;
    }

    const script = document.createElement('script');
    script.src = DYMO_SDK_URL;
    script.async = true;
    script.onload = () => {
      sdkLoaded = true;
      if (window.dymo?.label?.framework?.init) {
        window.dymo.label.framework.init(() => {
          resolve(true);
        });
      } else {
        resolve(true);
      }
    };
    script.onerror = (error) => {
      console.error('Failed to load DYMO SDK:', error);
      sdkLoadPromise = null;
      resolve(false);
    };
    document.head.appendChild(script);
  });

  return sdkLoadPromise;
}

export async function isDymoConnectRunning(): Promise<boolean> {
  const loaded = await loadDymoSdk();
  if (!loaded || !window.dymo) {
    return false;
  }

  try {
    const env = window.dymo.label.framework.checkEnvironment();
    return env.isWebServicePresent;
  } catch (e) {
    console.error('Error checking DYMO environment:', e);
    return false;
  }
}

export async function getDymoPrinters(): Promise<DymoPrinter[]> {
  const loaded = await loadDymoSdk();
  if (!loaded || !window.dymo) {
    return [];
  }

  try {
    const printers = window.dymo.label.framework.getPrinters();
    return printers.filter((p) => p.isConnected).map((p) => ({
      ...p,
      isTwinTurbo: p.modelName?.toLowerCase().includes('twin turbo') || p.name?.toLowerCase().includes('twin turbo'),
    }));
  } catch (e) {
    console.error('Error getting DYMO printers:', e);
    return [];
  }
}

function createLabelXml(
  imageBase64: string,
  widthInches: number,
  heightInches: number
): string {
  const widthTwips = Math.round(widthInches * 1440);
  const heightTwips = Math.round(heightInches * 1440);
  
  const imageData = imageBase64.replace(/^data:image\/\w+;base64,/, '');
  
  return `<?xml version="1.0" encoding="utf-8"?>
<DieCutLabel Version="8.0" Units="twips">
  <PaperOrientation>Portrait</PaperOrientation>
  <Id>Custom</Id>
  <PaperName>Custom ${widthInches}x${heightInches}</PaperName>
  <DrawCommands>
    <RoundRectangle X="0" Y="0" Width="${widthTwips}" Height="${heightTwips}" Rx="0" Ry="0"/>
  </DrawCommands>
  <ObjectInfo>
    <ImageObject>
      <Name>StickerImage</Name>
      <ForeColor Alpha="255" Red="0" Green="0" Blue="0"/>
      <BackColor Alpha="0" Red="255" Green="255" Blue="255"/>
      <LinkedObjectName></LinkedObjectName>
      <Rotation>Rotation0</Rotation>
      <IsMirrored>False</IsMirrored>
      <IsVariable>False</IsVariable>
      <Image>${imageData}</Image>
      <ScaleMode>Uniform</ScaleMode>
      <BorderWidth>0</BorderWidth>
      <BorderColor Alpha="255" Red="0" Green="0" Blue="0"/>
      <HorizontalAlignment>Center</HorizontalAlignment>
      <VerticalAlignment>Center</VerticalAlignment>
    </ImageObject>
    <Bounds X="0" Y="0" Width="${widthTwips}" Height="${heightTwips}"/>
  </ObjectInfo>
</DieCutLabel>`;
}

export async function printWithDymoConnect(
  imageBase64: string,
  widthInches: number,
  heightInches: number,
  printerName: string,
  twinTurboRoll?: TwinTurboRoll
): Promise<{ success: boolean; error?: string }> {
  const loaded = await loadDymoSdk();
  if (!loaded || !window.dymo) {
    return { success: false, error: 'DYMO SDK not loaded' };
  }

  try {
    const printers = await getDymoPrinters();
    if (printers.length === 0) {
      return { success: false, error: 'No DYMO printers connected' };
    }

    const selectedPrinter = printers.find((p) => p.name === printerName) || printers[0];

    const labelXml = createLabelXml(imageBase64, widthInches, heightInches);
    const label = window.dymo.label.framework.openLabelXml(labelXml);

    if (!label.isValidLabel()) {
      return { success: false, error: 'Invalid label format' };
    }

    let printParamsXml = '';
    if (twinTurboRoll && twinTurboRoll !== 'Auto' && selectedPrinter.isTwinTurbo) {
      const rollValue = twinTurboRoll === 'Left' 
        ? window.dymo.label.framework.TwinTurboRoll.Left 
        : window.dymo.label.framework.TwinTurboRoll.Right;
      
      printParamsXml = window.dymo.label.framework.createLabelWriterPrintParamsXml({
        copies: 1,
        twinTurboRoll: rollValue,
      });
    }

    label.print(selectedPrinter.name, printParamsXml);
    return { success: true };
  } catch (e) {
    console.error('DYMO print error:', e);
    return { 
      success: false, 
      error: e instanceof Error ? e.message : 'Unknown error' 
    };
  }
}

export const STICKER_SIZE_DIMENSIONS: Record<
  string,
  { widthInches: number; heightInches: number }
> = {
  '1.5x2.25': { widthInches: 1.5, heightInches: 2.25 },
  '2x2': { widthInches: 2, heightInches: 2 },
  '2x2.5': { widthInches: 2, heightInches: 2.5 },
  '2x3': { widthInches: 2, heightInches: 3 },
  '2x3.5': { widthInches: 2, heightInches: 3.5 },
};

export const KEYTAG_SIZE_DIMENSIONS: Record<
  string,
  { widthInches: number; heightInches: number }
> = {
  dymo30252: { widthInches: 3.5, heightInches: 1.125 },
};
