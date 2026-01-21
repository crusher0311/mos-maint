declare global {
  interface Window {
    dymo?: {
      label: {
        framework: {
          checkEnvironment: () => Promise<{
            isFrameworkInstalled: boolean;
            isBrowserSupported: boolean;
            isWebServicePresent: boolean;
            errorDetails?: string;
          }>;
          getPrinters: () => Promise<DymoPrinter[]>;
          openLabelXml: (xml: string) => DymoLabel;
          renderLabel: (labelXml: string, renderParams: string, printerName: string) => Promise<string>;
        };
      };
    };
  }
}

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

const DYMO_SDK_URL = "https://labelwriter.com/software/dls/sdk/js/dymo.connect.framework.js";

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

    const script = document.createElement("script");
    script.src = DYMO_SDK_URL;
    script.async = true;
    script.onload = () => {
      sdkLoaded = true;
      resolve(true);
    };
    script.onerror = () => {
      console.error("Failed to load DYMO SDK");
      resolve(false);
    };
    document.head.appendChild(script);
  });

  return sdkLoadPromise;
}

export async function checkDymoEnvironment(): Promise<DymoEnvironment | null> {
  const loaded = await loadDymoSdk();
  if (!loaded || !window.dymo) {
    return null;
  }

  try {
    const env = await window.dymo.label.framework.checkEnvironment();
    return env;
  } catch (error) {
    console.error("Error checking DYMO environment:", error);
    return null;
  }
}

export async function getDymoPrinters(): Promise<DymoPrinter[]> {
  const loaded = await loadDymoSdk();
  if (!loaded || !window.dymo) {
    return [];
  }

  try {
    const printers = await window.dymo.label.framework.getPrinters();
    return printers.filter((p) => p.isConnected);
  } catch (error) {
    console.error("Error getting DYMO printers:", error);
    return [];
  }
}

export function createLabelXml(
  imageBase64: string,
  widthInches: number,
  heightInches: number
): string {
  const widthTwips = Math.round(widthInches * 1440);
  const heightTwips = Math.round(heightInches * 1440);

  return `<?xml version="1.0" encoding="utf-8"?>
<DieCutLabel Version="8.0" Units="twips" MediaType="Default">
  <PaperOrientation>Portrait</PaperOrientation>
  <Id>CustomLabel</Id>
  <IsOutlined>false</IsOutlined>
  <CustomPaper>
    <Size Width="${widthTwips}" Height="${heightTwips}"/>
  </CustomPaper>
  <DrawCommands>
    <RoundRectangle X="0" Y="0" Width="${widthTwips}" Height="${heightTwips}" Rx="0" Ry="0"/>
  </DrawCommands>
  <ObjectInfo>
    <ImageObject>
      <Name>STICKER_IMAGE</Name>
      <ForeColor Alpha="255" Red="0" Green="0" Blue="0"/>
      <BackColor Alpha="0" Red="255" Green="255" Blue="255"/>
      <LinkedObjectName></LinkedObjectName>
      <Rotation>Rotation0</Rotation>
      <IsMirrored>False</IsMirrored>
      <IsVariable>False</IsVariable>
      <Image>${imageBase64}</Image>
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

export async function printWithDymo(
  imageBase64: string,
  widthInches: number,
  heightInches: number,
  printerName?: string
): Promise<{ success: boolean; error?: string }> {
  const loaded = await loadDymoSdk();
  if (!loaded || !window.dymo) {
    return { success: false, error: "DYMO SDK not loaded" };
  }

  try {
    const printers = await getDymoPrinters();
    if (printers.length === 0) {
      return { success: false, error: "No DYMO printers connected" };
    }

    const selectedPrinter = printerName
      ? printers.find((p) => p.name === printerName)
      : printers[0];

    if (!selectedPrinter) {
      return { success: false, error: `Printer "${printerName}" not found` };
    }

    const imageData = imageBase64.replace(/^data:image\/\w+;base64,/, "");
    const labelXml = createLabelXml(imageData, widthInches, heightInches);

    const label = window.dymo.label.framework.openLabelXml(labelXml);

    if (!label.isValidLabel()) {
      return { success: false, error: "Invalid label format" };
    }

    label.print(selectedPrinter.name);

    return { success: true };
  } catch (error) {
    console.error("Error printing with DYMO:", error);
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

export async function previewLabelWithDymo(
  imageBase64: string,
  widthInches: number,
  heightInches: number,
  printerName?: string
): Promise<string | null> {
  const loaded = await loadDymoSdk();
  if (!loaded || !window.dymo) {
    return null;
  }

  try {
    const printers = await getDymoPrinters();
    const selectedPrinter = printerName
      ? printers.find((p) => p.name === printerName)
      : printers[0];

    if (!selectedPrinter) {
      return null;
    }

    const imageData = imageBase64.replace(/^data:image\/\w+;base64,/, "");
    const labelXml = createLabelXml(imageData, widthInches, heightInches);

    const preview = await window.dymo.label.framework.renderLabel(
      labelXml,
      "",
      selectedPrinter.name
    );

    return `data:image/png;base64,${preview}`;
  } catch (error) {
    console.error("Error previewing label with DYMO:", error);
    return null;
  }
}

export const STICKER_SIZE_DIMENSIONS: Record<
  string,
  { widthInches: number; heightInches: number }
> = {
  "1.5x2.25": { widthInches: 1.5, heightInches: 2.25 },
  "2x2": { widthInches: 2, heightInches: 2 },
  "2x2.5": { widthInches: 2, heightInches: 2.5 },
  "2x3": { widthInches: 2, heightInches: 3 },
  "2x3.5": { widthInches: 2, heightInches: 3.5 },
};

export const KEYTAG_SIZE_DIMENSIONS: Record<
  string,
  { widthInches: number; heightInches: number }
> = {
  dymo30252: { widthInches: 3.5, heightInches: 1.125 },
};
