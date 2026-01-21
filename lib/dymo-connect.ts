/**
 * DYMO Connect REST API client
 * 
 * Communicates with DYMO Connect's local web service at http://127.0.0.1:41951
 * Requires DYMO Connect software installed on the user's machine.
 */

const DYMO_API_BASE = 'http://127.0.0.1:41951/DYMO/DLS/Printing';

export type TwinTurboRoll = 'Auto' | 'Left' | 'Right';

export interface DymoPrinter {
  name: string;
  modelName: string;
  isConnected: boolean;
  isLocal: boolean;
  isTwinTurbo: boolean;
}

export async function isDymoConnectRunning(): Promise<boolean> {
  try {
    const response = await fetch(`${DYMO_API_BASE}/StatusConnected`, {
      method: 'GET',
      mode: 'cors',
    });
    const text = await response.text();
    return text.toLowerCase() === 'true';
  } catch (e) {
    return false;
  }
}

export async function getDymoPrinters(): Promise<DymoPrinter[]> {
  try {
    const response = await fetch(`${DYMO_API_BASE}/GetPrinters`, {
      method: 'GET',
      mode: 'cors',
    });
    const xml = await response.text();
    return parsePrintersXml(xml);
  } catch (e) {
    console.error('Failed to get DYMO printers:', e);
    return [];
  }
}

function parsePrintersXml(xml: string): DymoPrinter[] {
  const printers: DymoPrinter[] = [];
  const parser = new DOMParser();
  const doc = parser.parseFromString(xml, 'text/xml');
  const printerNodes = doc.querySelectorAll('LabelWriterPrinter');
  
  printerNodes.forEach((node) => {
    const name = node.querySelector('Name')?.textContent || '';
    const modelName = node.querySelector('ModelName')?.textContent || '';
    const isConnected = node.querySelector('IsConnected')?.textContent?.toLowerCase() === 'true';
    const isLocal = node.querySelector('IsLocal')?.textContent?.toLowerCase() === 'true';
    const isTwinTurbo = modelName.toLowerCase().includes('twin turbo');
    
    if (name) {
      printers.push({ name, modelName, isConnected, isLocal, isTwinTurbo });
    }
  });
  
  return printers;
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

function createPrintParamsXml(twinTurboRoll?: TwinTurboRoll): string {
  if (!twinTurboRoll || twinTurboRoll === 'Auto') {
    return '';
  }
  
  return `<?xml version="1.0" encoding="utf-8"?>
<LabelWriterPrintParams>
  <Copies>1</Copies>
  <PrintQuality>BarcodeAndGraphics</PrintQuality>
  <TwinTurboRoll>${twinTurboRoll}</TwinTurboRoll>
</LabelWriterPrintParams>`;
}

export async function printWithDymoConnect(
  imageBase64: string,
  widthInches: number,
  heightInches: number,
  printerName: string,
  twinTurboRoll?: TwinTurboRoll
): Promise<{ success: boolean; error?: string }> {
  try {
    const isConnected = await isDymoConnectRunning();
    if (!isConnected) {
      return { success: false, error: 'DYMO Connect is not running' };
    }

    const labelXml = createLabelXml(imageBase64, widthInches, heightInches);
    const printParamsXml = createPrintParamsXml(twinTurboRoll);

    const formData = new FormData();
    formData.append('printerName', printerName);
    formData.append('labelXml', labelXml);
    formData.append('labelSetXml', '');
    if (printParamsXml) {
      formData.append('printParamsXml', printParamsXml);
    }

    const response = await fetch(`${DYMO_API_BASE}/PrintLabel`, {
      method: 'POST',
      body: formData,
      mode: 'cors',
    });

    if (!response.ok) {
      const errorText = await response.text();
      return { success: false, error: `Print failed: ${errorText}` };
    }

    return { success: true };
  } catch (e) {
    console.error('DYMO Connect print error:', e);
    return { 
      success: false, 
      error: e instanceof Error ? e.message : 'Unknown error' 
    };
  }
}

export async function renderLabelPreview(
  imageBase64: string,
  widthInches: number,
  heightInches: number,
  printerName: string
): Promise<string | null> {
  try {
    const labelXml = createLabelXml(imageBase64, widthInches, heightInches);

    const formData = new FormData();
    formData.append('printerName', printerName);
    formData.append('labelXml', labelXml);
    formData.append('renderParamsXml', '');

    const response = await fetch(`${DYMO_API_BASE}/RenderLabel`, {
      method: 'POST',
      body: formData,
      mode: 'cors',
    });

    if (!response.ok) {
      return null;
    }

    const previewBase64 = await response.text();
    return `data:image/png;base64,${previewBase64}`;
  } catch (e) {
    console.error('DYMO Connect render error:', e);
    return null;
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
