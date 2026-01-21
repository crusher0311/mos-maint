declare global {
  interface Window {
    dymo?: {
      label: {
        framework: {
          init: (callback?: () => void) => void;
          checkEnvironment: () => Promise<{
            isFrameworkInstalled: boolean;
            isBrowserSupported: boolean;
            isWebServicePresent: boolean;
            errorDetails?: string;
          }>;
          getPrinters: () => Promise<DymoPrinter[]>;
          openLabelXml: (xml: string) => DymoLabel;
          renderLabel: (labelXml: string, renderParams: string, printerName: string) => Promise<string>;
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

export type TwinTurboRollSelection = "auto" | "left" | "right";

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

// Use jsDelivr CDN to serve the official DYMO Connect Framework from GitHub
const DYMO_SDK_URL = "https://cdn.jsdelivr.net/gh/dymosoftware/dymo-connect-framework@master/dymo.connect.framework.min.js";

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
    script.onerror = (error) => {
      console.error("Failed to load DYMO SDK from:", DYMO_SDK_URL, error);
      sdkLoadPromise = null; // Reset so we can try again
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
    // Initialize the framework first if init function exists
    if (typeof window.dymo.label.framework.init === 'function') {
      await new Promise<void>((resolve) => {
        window.dymo!.label.framework.init(resolve);
      });
    }
    
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
  return `<?xml version="1.0" encoding="utf-8"?>
<DesktopLabel Version="1">
  <DYMOLabel Version="3">
    <Description>Oil Sticker</Description>
    <Orientation>Portrait</Orientation>
    <LabelName>Address</LabelName>
    <InitialLength>${heightInches}</InitialLength>
    <BorderStyle>SolidLine</BorderStyle>
    <DYMORect>
      <DYMOPoint>
        <X>0.1</X>
        <Y>0.1</Y>
      </DYMOPoint>
      <Size>
        <Width>${widthInches - 0.2}</Width>
        <Height>${heightInches - 0.2}</Height>
      </Size>
    </DYMORect>
    <BorderColor>
      <SolidColorBrush>
        <Color A="0" R="0" G="0" B="0"></Color>
      </SolidColorBrush>
    </BorderColor>
    <BorderThickness>0</BorderThickness>
    <Show_Border>False</Show_Border>
    <DynamicLayoutManager>
      <RotationBehavior>ClearObjects</RotationBehavior>
      <LabelObjects>
        <ObjectInfo>
      <IImageObject>
        <Name>STICKER_IMAGE</Name>
        <Rotation>Rotation0</Rotation>
        <IsMirrored>False</IsMirrored>
        <IsVariable>False</IsVariable>
        <HorizontalAlignment>Center</HorizontalAlignment>
        <VerticalAlignment>Center</VerticalAlignment>
        <ScaleMode>Uniform</ScaleMode>
        <Image>${imageBase64}</Image>
      </IImageObject>
      <Bounds X="0" Y="0" Width="${widthInches}" Height="${heightInches}"></Bounds>
        </ObjectInfo>
      </LabelObjects>
    </DynamicLayoutManager>
    <Blank></Blank>
  </DYMOLabel>
</DesktopLabel>`;
}

export async function printWithDymo(
  imageBase64: string,
  widthInches: number,
  heightInches: number,
  printerName?: string,
  twinTurboRoll?: TwinTurboRollSelection
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

    let printParamsXml = "";
    if (twinTurboRoll && selectedPrinter.isTwinTurbo && window.dymo.label.framework.createLabelWriterPrintParamsXml) {
      const rollMapping: Record<TwinTurboRollSelection, string> = {
        auto: window.dymo.label.framework.TwinTurboRoll?.Auto || "Auto",
        left: window.dymo.label.framework.TwinTurboRoll?.Left || "Left",
        right: window.dymo.label.framework.TwinTurboRoll?.Right || "Right",
      };
      printParamsXml = window.dymo.label.framework.createLabelWriterPrintParamsXml({
        copies: 1,
        twinTurboRoll: rollMapping[twinTurboRoll],
      });
    }

    label.print(selectedPrinter.name, printParamsXml);

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
