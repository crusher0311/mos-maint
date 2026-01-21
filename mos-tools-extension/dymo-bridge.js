/**
 * DYMO Connect Bridge for MOS Tools Extension
 * 
 * Communicates with DYMO Connect's local REST API at http://127.0.0.1:41951
 * The Chrome extension has permission to bypass CORS restrictions.
 */

const DYMO_API_BASE = 'http://127.0.0.1:41951/DYMO/DLS/Printing';

export async function isDymoConnectRunning() {
  try {
    const response = await fetch(`${DYMO_API_BASE}/StatusConnected`, {
      method: 'GET',
    });
    const text = await response.text();
    return text.toLowerCase() === 'true';
  } catch (e) {
    console.log('[DYMO Bridge] DYMO Connect not running:', e.message);
    return false;
  }
}

export async function getDymoPrinters() {
  try {
    const response = await fetch(`${DYMO_API_BASE}/GetPrinters`, {
      method: 'GET',
    });
    const xml = await response.text();
    return parsePrintersXml(xml);
  } catch (e) {
    console.error('[DYMO Bridge] Failed to get printers:', e);
    return [];
  }
}

function parsePrintersXml(xml) {
  const printers = [];
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

function createLabelXml(imageBase64, widthInches, heightInches) {
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

function createPrintParamsXml(twinTurboRoll) {
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

export async function printLabel(imageBase64, widthInches, heightInches, printerName, twinTurboRoll) {
  try {
    const isConnected = await isDymoConnectRunning();
    if (!isConnected) {
      return { success: false, error: 'DYMO Connect is not running. Please start DYMO Connect software.' };
    }

    const printers = await getDymoPrinters();
    if (printers.length === 0) {
      return { success: false, error: 'No DYMO printers found' };
    }

    const selectedPrinter = printers.find(p => p.name === printerName) || printers[0];
    const labelXml = createLabelXml(imageBase64, widthInches, heightInches);
    const printParamsXml = createPrintParamsXml(twinTurboRoll);

    const formData = new URLSearchParams();
    formData.append('printerName', selectedPrinter.name);
    formData.append('labelXml', labelXml);
    formData.append('labelSetXml', '');
    if (printParamsXml) {
      formData.append('printParamsXml', printParamsXml);
    }

    const response = await fetch(`${DYMO_API_BASE}/PrintLabel`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: formData.toString(),
    });

    if (!response.ok) {
      const errorText = await response.text();
      return { success: false, error: `Print failed: ${errorText}` };
    }

    console.log('[DYMO Bridge] Print successful to:', selectedPrinter.name);
    return { success: true, printerName: selectedPrinter.name };
  } catch (e) {
    console.error('[DYMO Bridge] Print error:', e);
    return { success: false, error: e.message || 'Unknown error' };
  }
}

export const STICKER_SIZES = {
  '1.5x2.25': { widthInches: 1.5, heightInches: 2.25 },
  '2x2': { widthInches: 2, heightInches: 2 },
  '2x2.5': { widthInches: 2, heightInches: 2.5 },
  '2x3': { widthInches: 2, heightInches: 3 },
  '2x3.5': { widthInches: 2, heightInches: 3.5 },
};

export const KEYTAG_SIZES = {
  'dymo30252': { widthInches: 3.5, heightInches: 1.125 },
};
