import { createCanvas, loadImage, registerFont, type Canvas, type CanvasRenderingContext2D, type Image } from "canvas";
import path from "path";

let fontsRegistered = false;

function ensureFontsRegistered() {
  if (fontsRegistered) return;
  try {
    const fontDir = path.join(process.cwd(), "assets", "fonts");
    registerFont(path.join(fontDir, "Inter-18pt-Regular.ttf"), { family: "Inter", weight: "400", style: "normal" });
    registerFont(path.join(fontDir, "Inter-18pt-Bold.ttf"), { family: "Inter", weight: "700", style: "normal" });
    registerFont(path.join(fontDir, "Inter-18pt-Italic.ttf"), { family: "Inter", weight: "400", style: "italic" });
    registerFont(path.join(fontDir, "Inter-18pt-BoldItalic.ttf"), { family: "Inter", weight: "700", style: "italic" });
    fontsRegistered = true;
    console.log("[Canvas Renderer] Fonts registered");
  } catch (e) {
    console.warn("[Canvas Renderer] Font registration failed, using system fonts:", e);
    fontsRegistered = true;
  }
}

function buildFont(size: number, weight: string = "normal", style: string = "normal", family: string = "Arial"): string {
  const w = weight === "bold" || weight === "700" ? "bold" : "normal";
  const s = style === "italic" ? "italic" : "normal";
  return `${s} ${w} ${size}px ${family}, Arial, Helvetica, sans-serif`;
}

async function loadBase64Image(dataUri: string): Promise<Image> {
  return await loadImage(dataUri);
}

function drawImageContain(ctx: CanvasRenderingContext2D, img: Image, x: number, y: number, w: number, h: number) {
  const scale = Math.min(w / img.width, h / img.height);
  const dw = img.width * scale;
  const dh = img.height * scale;
  const dx = x + (w - dw) / 2;
  const dy = y + (h - dh) / 2;
  ctx.drawImage(img, dx, dy, dw, dh);
}

function drawImageCover(ctx: CanvasRenderingContext2D, img: Image, x: number, y: number, w: number, h: number) {
  const scale = Math.max(w / img.width, h / img.height);
  const dw = img.width * scale;
  const dh = img.height * scale;
  const dx = x + (w - dw) / 2;
  const dy = y + (h - dh) / 2;
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, w, h);
  ctx.clip();
  ctx.drawImage(img, dx, dy, dw, dh);
  ctx.restore();
}

function drawAlignedText(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, width: number, height: number, textAlign: string = "left") {
  let tx: number;
  if (textAlign === "center") {
    ctx.textAlign = "center";
    tx = x + width / 2;
  } else if (textAlign === "right") {
    ctx.textAlign = "right";
    tx = x + width;
  } else {
    ctx.textAlign = "left";
    tx = x;
  }
  ctx.textBaseline = "middle";
  const ty = y + height / 2;
  ctx.fillText(text, tx, ty, width);
}

function autoFitFontSize(ctx: CanvasRenderingContext2D, text: string, maxWidth: number, baseFontSize: number, fontWeight: string, fontStyle: string, family: string, minSize: number = 8): number {
  let size = baseFontSize;
  while (size > minSize) {
    ctx.font = buildFont(size, fontWeight, fontStyle, family);
    const measured = ctx.measureText(text);
    if (measured.width <= maxWidth) break;
    size -= 1;
  }
  return size;
}

export interface StickerRenderConfig {
  logo?: string;
  phone?: string;
  tagline?: string;
  taglineLine2?: string;
  serviceLabel?: string;
  roundMileage?: boolean;
  fontStyles?: {
    phone?: { bold?: boolean; italic?: boolean; size?: number };
    tagline?: { bold?: boolean; italic?: boolean; size?: number };
    taglineLine2?: { bold?: boolean; italic?: boolean; size?: number };
    serviceLabel?: { bold?: boolean; italic?: boolean; size?: number };
    serviceValue?: { bold?: boolean; italic?: boolean; size?: number };
  };
  colors?: {
    primary?: string;
    background?: string;
    phoneColor?: string;
    taglineColor?: string;
    taglineLine2Color?: string;
    serviceLabelColor?: string;
    serviceValueColor?: string;
  };
}

export interface StickerRenderData {
  nextServiceMileage: number;
  nextServiceDate: string;
  useHours?: boolean;
  useKilometers?: boolean;
  qrDataUrl?: string | null;
}

export async function renderStickerStandard(
  config: StickerRenderConfig,
  data: StickerRenderData,
  dimensions: { width: number; height: number },
  scaleFactor: number = 2
): Promise<Buffer> {
  ensureFontsRegistered();

  const w = dimensions.width;
  const h = dimensions.height;
  const canvas = createCanvas(w * scaleFactor, h * scaleFactor);
  const ctx = canvas.getContext("2d");
  ctx.scale(scaleFactor, scaleFactor);

  const bg = config.colors?.background || "#ffffff";
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, w, h);

  const phoneColor = config.colors?.phoneColor || "#000000";
  const taglineColor = config.colors?.taglineColor || "#333333";
  const taglineLine2Color = config.colors?.taglineLine2Color || taglineColor;
  const serviceLabelColor = config.colors?.serviceLabelColor || "#666666";
  const serviceValueColor = config.colors?.serviceValueColor || config.colors?.primary || "#cc0000";
  const distanceUnit = data.useHours ? "hrs" : data.useKilometers ? "km" : "mi";

  const formattedDate = data.nextServiceDate
    ? new Date(data.nextServiceDate).toLocaleDateString("en-US", { month: "numeric", day: "numeric", year: "numeric" })
    : "";

  let mileageValue = data.nextServiceMileage;
  if (mileageValue && config.roundMileage) {
    mileageValue = Math.round(mileageValue / 100) * 100;
  }
  const formattedMileage = mileageValue ? mileageValue.toLocaleString() : "";

  const sf = w / 200;
  const padding = Math.round(10 * sf);
  const logoHeight = Math.round(60 * sf);

  const phoneFontStyle = config.fontStyles?.phone || { bold: true, italic: false, size: 14 };
  const taglineFontStyle = config.fontStyles?.tagline || { bold: false, italic: true, size: 11 };
  const taglineLine2FontStyle = config.fontStyles?.taglineLine2 || { bold: false, italic: true, size: 11 };
  const serviceLabelFontStyle = config.fontStyles?.serviceLabel || { bold: false, italic: false, size: 12 };
  const serviceValueFontStyle = config.fontStyles?.serviceValue || { bold: true, italic: true, size: 14 };

  const phoneSize = Math.round((phoneFontStyle.size || 14) * sf);
  const taglineSize = Math.round((taglineFontStyle.size || 11) * sf);
  const taglineLine2Size = Math.round((taglineLine2FontStyle.size || 11) * sf);
  const qrSize = Math.round(80 * sf);

  const labelSizeRaw = Math.round((serviceLabelFontStyle.size || 12) * sf);
  const valueSizeRaw = Math.round((serviceValueFontStyle.size || 14) * sf);
  const labelSize = Math.min(labelSizeRaw, Math.round(22 * sf));
  const valueSize = Math.min(valueSizeRaw, Math.round(28 * sf));

  let yPos = padding;
  const contentWidth = w - padding * 2;

  if (config.logo) {
    try {
      const logoImg = await loadBase64Image(config.logo);
      const logoW = contentWidth;
      const logoScale = Math.min(logoW / logoImg.width, logoHeight / logoImg.height);
      const dw = logoImg.width * logoScale;
      const dh = logoImg.height * logoScale;
      const dx = padding + (logoW - dw) / 2;
      ctx.drawImage(logoImg, dx, yPos, dw, dh);
      yPos += logoHeight + Math.round(6 * sf);
    } catch (e) {
      console.warn("[Canvas Renderer] Logo load failed:", e);
      yPos += Math.round(6 * sf);
    }
  }

  if (config.phone) {
    ctx.font = buildFont(phoneSize, phoneFontStyle.bold ? "bold" : "normal", phoneFontStyle.italic ? "italic" : "normal");
    ctx.fillStyle = phoneColor;
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    ctx.fillText(config.phone, w / 2, yPos, contentWidth);
    yPos += phoneSize + Math.round(4 * sf);
  }

  if (config.tagline) {
    ctx.font = buildFont(taglineSize, taglineFontStyle.bold ? "bold" : "normal", taglineFontStyle.italic ? "italic" : "normal");
    ctx.fillStyle = taglineColor;
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    ctx.fillText(config.tagline, w / 2, yPos, contentWidth);
    yPos += taglineSize + Math.round(2 * sf);
  }

  if (config.taglineLine2) {
    ctx.font = buildFont(taglineLine2Size, taglineLine2FontStyle.bold ? "bold" : "normal", taglineLine2FontStyle.italic ? "italic" : "normal");
    ctx.fillStyle = taglineLine2Color;
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    ctx.fillText(config.taglineLine2, w / 2, yPos, contentWidth);
    yPos += taglineLine2Size + Math.round(8 * sf);
  }

  const serviceSectionHeight = h - yPos - padding;
  const serviceY = yPos;

  let qrRenderedWidth = 0;
  if (data.qrDataUrl) {
    try {
      const qrImg = await loadBase64Image(data.qrDataUrl);
      const qrDrawSize = Math.min(qrSize, serviceSectionHeight);
      const qrY = serviceY + (serviceSectionHeight - qrDrawSize) / 2;
      ctx.drawImage(qrImg, padding, qrY, qrDrawSize, qrDrawSize);
      qrRenderedWidth = qrDrawSize + Math.round(10 * sf);
    } catch (e) {
      console.warn("[Canvas Renderer] QR load failed:", e);
    }
  }

  const serviceInfoX = padding + qrRenderedWidth;
  const serviceInfoWidth = w - padding - serviceInfoX;
  const serviceInfoCenterX = serviceInfoX + serviceInfoWidth / 2;

  ctx.font = buildFont(labelSize, serviceLabelFontStyle.bold ? "bold" : "normal", serviceLabelFontStyle.italic ? "italic" : "normal");
  ctx.fillStyle = serviceLabelColor;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  const labelText = config.serviceLabel || "Next Svc Due:";
  const labelY = serviceY + serviceSectionHeight / 2 - valueSize;
  ctx.fillText(labelText, serviceInfoCenterX, labelY, serviceInfoWidth);

  ctx.font = buildFont(valueSize, serviceValueFontStyle.bold ? "bold" : "normal", serviceValueFontStyle.italic ? "italic" : "normal");
  ctx.fillStyle = serviceValueColor;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  if (formattedDate) {
    ctx.fillText(formattedDate, serviceInfoCenterX, labelY + labelSize + Math.round(4 * sf), serviceInfoWidth);
  }
  if (formattedMileage) {
    const mileageText = `${formattedMileage} ${distanceUnit}`;
    ctx.fillText(mileageText, serviceInfoCenterX, labelY + labelSize + valueSize + Math.round(8 * sf), serviceInfoWidth);
  }

  return canvas.toBuffer("image/png");
}

export interface StickerDesignerElement {
  type: string;
  x: number;
  y: number;
  width: number;
  height: number;
  fontSize: number;
  fontWeight: string;
  fontStyle: string;
  textAlign: string;
  color: string;
  backgroundColor?: string;
  visible: boolean;
  imageFit?: string;
  content?: string;
}

export interface StickerDesignerLayout {
  elements: StickerDesignerElement[];
  canvasWidth: number;
  canvasHeight: number;
  backgroundColor: string;
}

export interface StickerDesignerData {
  phone?: string;
  tagline?: string;
  taglineLine2?: string;
  serviceLabel?: string;
  formattedDate: string;
  formattedMileage: string;
  distanceUnit: string;
  logoDataUrl?: string | null;
  qrDataUrl?: string | null;
}

export async function renderStickerDesigner(
  layout: StickerDesignerLayout,
  data: StickerDesignerData,
  dimensions: { width: number; height: number },
  scaleFactor: number = 2
): Promise<Buffer> {
  ensureFontsRegistered();

  const w = dimensions.width;
  const h = dimensions.height;
  const canvas = createCanvas(w * scaleFactor, h * scaleFactor);
  const ctx = canvas.getContext("2d");
  ctx.scale(scaleFactor, scaleFactor);

  ctx.fillStyle = layout.backgroundColor || "#ffffff";
  ctx.fillRect(0, 0, w, h);

  const scaleX = w / layout.canvasWidth;
  const scaleY = h / layout.canvasHeight;

  const getContent = (el: StickerDesignerElement): string => {
    switch (el.type) {
      case "phone": return data.phone || "";
      case "tagline": return data.tagline || "";
      case "taglineLine2": return data.taglineLine2 || "";
      case "serviceLabel": return el.content || data.serviceLabel || "Next Oil Service";
      case "serviceDate": return data.formattedDate;
      case "serviceMileage": return data.formattedMileage ? `${data.formattedMileage} ${data.distanceUnit}` : "";
      default: return el.content || "";
    }
  };

  for (const el of layout.elements) {
    if (!el.visible) continue;

    const ex = Math.round(el.x * scaleX);
    const ey = Math.round(el.y * scaleY);
    const ew = Math.round(el.width * scaleX);
    const eh = Math.round(el.height * scaleY);
    const efs = Math.round(el.fontSize * Math.min(scaleX, scaleY));

    if (el.backgroundColor) {
      ctx.fillStyle = el.backgroundColor;
      ctx.fillRect(ex, ey, ew, eh);
    }

    if (el.type === "logo" && data.logoDataUrl) {
      try {
        const img = await loadBase64Image(data.logoDataUrl);
        if (el.imageFit === "cover") {
          drawImageCover(ctx, img, ex, ey, ew, eh);
        } else {
          drawImageContain(ctx, img, ex, ey, ew, eh);
        }
      } catch (e) {
        console.warn("[Canvas Renderer] Designer logo load failed:", e);
      }
      continue;
    }

    if (el.type === "qrCode" && data.qrDataUrl) {
      try {
        const img = await loadBase64Image(data.qrDataUrl);
        drawImageContain(ctx, img, ex, ey, ew, eh);
      } catch (e) {
        console.warn("[Canvas Renderer] Designer QR load failed:", e);
      }
      continue;
    }

    const content = getContent(el);
    if (!content) continue;

    ctx.font = buildFont(efs, el.fontWeight, el.fontStyle);
    ctx.fillStyle = el.color || "#000000";
    drawAlignedText(ctx, content, ex, ey, ew, eh, el.textAlign);
  }

  return canvas.toBuffer("image/png");
}

export interface KeytagRenderData {
  customerName: string;
  vehicleInfo: string;
  vin?: string;
  roNumber: string;
  mileage: string | number;
}

export interface KeytagRenderConfig {
  colors?: {
    text?: string;
    background?: string;
  };
}

export async function renderKeytagLegacy(
  config: KeytagRenderConfig,
  data: KeytagRenderData,
  renderWidth: number,
  renderHeight: number,
  deviceScaleFactor: number = 2
): Promise<Buffer> {
  ensureFontsRegistered();

  const canvas = createCanvas(renderWidth * deviceScaleFactor, renderHeight * deviceScaleFactor);
  const ctx = canvas.getContext("2d");
  ctx.scale(deviceScaleFactor, deviceScaleFactor);

  const textColor = config.colors?.text || "#000000";
  const backgroundColor = config.colors?.background || "#FFFFFF";
  const scaleFactor = renderWidth / 345;

  ctx.fillStyle = backgroundColor;
  ctx.fillRect(0, 0, renderWidth, renderHeight);

  const mileageFormatted = typeof data.mileage === "number" ? data.mileage.toLocaleString() : data.mileage;
  const baseFontSize = Math.round(10 * scaleFactor);
  const nameFontSize = Math.round(16 * scaleFactor);
  const vehicleFontSize = Math.round(10 * scaleFactor);
  const padding = Math.round(12 * scaleFactor);
  const gap = Math.round(14 * scaleFactor);
  const dividerX = Math.round(renderWidth * 0.45);

  ctx.strokeStyle = textColor;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(dividerX, padding);
  ctx.lineTo(dividerX, renderHeight - padding);
  ctx.stroke();

  const leftWidth = dividerX - padding - gap;
  const rightX = dividerX + gap;
  const rightWidth = renderWidth - rightX - padding;
  const centerY = renderHeight / 2;

  ctx.fillStyle = textColor;
  ctx.font = buildFont(nameFontSize, "bold", "normal", "Inter");
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  const nameText = data.customerName.toUpperCase();
  const fittedNameSize = autoFitFontSize(ctx, nameText, leftWidth, nameFontSize, "bold", "normal", "Inter");
  ctx.font = buildFont(fittedNameSize, "bold", "normal", "Inter");
  const nameY = centerY - Math.round(4 * scaleFactor);
  ctx.fillText(nameText, padding, nameY, leftWidth);
  const underlineY = nameY + fittedNameSize / 2 + 2;
  const nameWidth = Math.min(ctx.measureText(nameText).width, leftWidth);
  ctx.beginPath();
  ctx.moveTo(padding, underlineY);
  ctx.lineTo(padding + nameWidth, underlineY);
  ctx.lineWidth = 1;
  ctx.stroke();

  ctx.font = buildFont(vehicleFontSize, "normal", "normal", "Inter");
  const vehicleText = data.vehicleInfo.toUpperCase();
  const fittedVehicleSize = autoFitFontSize(ctx, vehicleText, leftWidth, vehicleFontSize, "normal", "normal", "Inter");
  ctx.font = buildFont(fittedVehicleSize, "normal", "normal", "Inter");
  ctx.fillText(vehicleText, padding, centerY + Math.round(12 * scaleFactor), leftWidth);

  const rows: { label: string; value: string }[] = [];
  if (data.vin) rows.push({ label: "VIN:", value: data.vin });
  rows.push({ label: "Mileage:", value: mileageFormatted });
  rows.push({ label: "RO#:", value: data.roNumber });

  const rowHeight = Math.round(baseFontSize * 1.8);
  const totalRowsHeight = rows.length * rowHeight;
  let rowY = centerY - totalRowsHeight / 2 + rowHeight / 2;

  for (const row of rows) {
    ctx.font = buildFont(baseFontSize, "bold", "normal", "Inter");
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    const labelWidth = ctx.measureText(row.label + " ").width;
    ctx.fillText(row.label, rightX, rowY);

    ctx.font = buildFont(baseFontSize, "normal", "normal", "Inter");
    const fittedSize = autoFitFontSize(ctx, row.value, rightWidth - labelWidth, baseFontSize, "normal", "normal", "Inter");
    ctx.font = buildFont(fittedSize, "normal", "normal", "Inter");
    ctx.fillText(row.value, rightX + labelWidth, rowY, rightWidth - labelWidth);

    rowY += rowHeight;
  }

  return canvas.toBuffer("image/png");
}

export interface KeytagDesignerElement {
  type: string;
  label: string;
  x: number;
  y: number;
  width: number;
  height: number;
  fontSize: number;
  fontWeight: string;
  fontStyle: string;
  textAlign: string;
  visible: boolean;
  showLabel?: boolean;
  labelFontWeight?: string;
  labelFontStyle?: string;
  valueFontWeight?: string;
  valueFontStyle?: string;
  vinHighlightLast8?: boolean;
  vinLast8FontWeight?: string;
  vinLast8FontStyle?: string;
}

export interface KeytagDesignerLayout {
  elements: KeytagDesignerElement[];
  canvasWidth: number;
  canvasHeight: number;
  backgroundColor: string;
  textColor: string;
}

export async function renderKeytagDesigner(
  layout: KeytagDesignerLayout,
  data: KeytagRenderData,
  renderWidth: number,
  renderHeight: number,
  deviceScaleFactor: number = 2
): Promise<Buffer> {
  ensureFontsRegistered();

  const canvas = createCanvas(renderWidth * deviceScaleFactor, renderHeight * deviceScaleFactor);
  const ctx = canvas.getContext("2d");
  ctx.scale(deviceScaleFactor, deviceScaleFactor);

  ctx.fillStyle = layout.backgroundColor || "#FFFFFF";
  ctx.fillRect(0, 0, renderWidth, renderHeight);

  const scaleFactor = renderWidth / layout.canvasWidth;
  const textColor = layout.textColor || "#000000";

  const dataMap: Record<string, string> = {
    customerName: data.customerName?.toUpperCase() || "",
    vehicleInfo: data.vehicleInfo?.toUpperCase() || "",
    vin: data.vin || "",
    roNumber: data.roNumber || "",
    mileage: typeof data.mileage === "number" ? data.mileage.toLocaleString() : (data.mileage || ""),
  };

  for (const el of layout.elements) {
    if (!el.visible) continue;

    const ex = el.x * scaleFactor;
    const ey = el.y * scaleFactor;
    const ew = el.width * scaleFactor;
    const eh = el.height * scaleFactor;
    const baseFontSize = el.fontSize * scaleFactor;

    const value = dataMap[el.type] || el.label;
    const labelWeight = el.labelFontWeight || el.fontWeight || "normal";
    const labelStyle = el.labelFontStyle || el.fontStyle || "normal";
    const valueWeight = el.valueFontWeight || "normal";
    const valueStyle = el.valueFontStyle || "normal";

    ctx.fillStyle = textColor;

    if (el.showLabel) {
      const labelText = `${el.label}: `;
      const fullText = `${el.label}: ${value}`;
      const fittedSize = autoFitFontSize(ctx, fullText, ew - 4, baseFontSize, labelWeight, labelStyle, "Inter");

      ctx.font = buildFont(fittedSize, labelWeight, labelStyle, "Inter");
      ctx.textBaseline = "middle";
      const labelW = ctx.measureText(labelText).width;

      let startX: number;
      if (el.textAlign === "center") {
        const totalW = ctx.measureText(fullText).width;
        startX = ex + (ew - totalW) / 2;
      } else if (el.textAlign === "right") {
        const totalW = ctx.measureText(fullText).width;
        startX = ex + ew - totalW;
      } else {
        startX = ex;
      }
      const midY = ey + eh / 2;

      ctx.font = buildFont(fittedSize, labelWeight, labelStyle, "Inter");
      ctx.textAlign = "left";
      ctx.fillText(labelText, startX, midY);

      if (el.type === "vin" && el.vinHighlightLast8 && value.length >= 8) {
        const first = value.slice(0, -8);
        const last8 = value.slice(-8);
        ctx.font = buildFont(fittedSize, valueWeight, valueStyle, "Inter");
        const firstW = ctx.measureText(first).width;
        ctx.fillText(first, startX + labelW, midY);
        const last8Weight = el.vinLast8FontWeight || "bold";
        const last8Style = el.vinLast8FontStyle || "normal";
        ctx.font = buildFont(fittedSize, last8Weight, last8Style, "Inter");
        ctx.fillText(last8, startX + labelW + firstW, midY);
      } else {
        ctx.font = buildFont(fittedSize, valueWeight, valueStyle, "Inter");
        ctx.fillText(value, startX + labelW, midY);
      }
    } else {
      const fittedSize = autoFitFontSize(ctx, value, ew - 4, baseFontSize, el.fontWeight, el.fontStyle, "Inter");
      ctx.font = buildFont(fittedSize, el.fontWeight, el.fontStyle, "Inter");
      drawAlignedText(ctx, value, ex, ey, ew, eh, el.textAlign);
    }
  }

  return canvas.toBuffer("image/png");
}
