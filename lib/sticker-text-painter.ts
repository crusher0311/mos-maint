// Structural canvas subset works in browser Canvas2D and node-canvas.
interface TextContext {
  font: string; fillStyle: any; strokeStyle: any; lineWidth: number;
  textAlign: any; textBaseline: any;
  measureText(text: string): { width: number };
  fillText(text: string, x: number, y: number, maxWidth?: number): void;
  fillRect(x: number, y: number, w: number, h: number): void;
  strokeRect(x: number, y: number, w: number, h: number): void;
  save(): void; restore(): void; beginPath(): void;
  rect(x: number, y: number, w: number, h: number): void; clip(): void;
}
export interface StickerTextStyle {
  width: number; height: number; fontSize: number; fontWeight: string;
  fontStyle: string; textAlign: string; color: string;
  backgroundColor?: string; underline?: boolean; borderColor?: string; borderWidth?: number;
}
// Preserve the printer's longstanding single-line horizontal compression on overflow.
// Both previews and exports use exactly the same geometry, with decorations inside bounds.
export function paintStickerText(ctx: TextContext, text: string, el: StickerTextStyle) {
  const { width: w, height: h, fontSize: fs } = el;
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, w, h);
  ctx.clip();
  try {
  if (el.backgroundColor) {
    ctx.fillStyle = el.backgroundColor.trim().toLowerCase();
    ctx.fillRect(0, 0, w, h);
  }
  const border = el.borderColor ? Math.min(el.borderWidth || 0, w / 2, h / 2) : 0;
  if (border) {
    ctx.strokeStyle = el.borderColor!.trim().toLowerCase();
    ctx.lineWidth = border;
    ctx.strokeRect(border / 2, border / 2, w - border, h - border);
  }
  const available = Math.max(0, w - border * 2);
  if (!text || !available) return;
  ctx.font = `${el.fontStyle === 'italic' ? 'italic' : 'normal'} ${el.fontWeight === 'bold' ? 'bold' : 'normal'} ${fs}px Arial, Helvetica, sans-serif`;
  ctx.fillStyle = el.color?.trim().toLowerCase() || '#000000';
  ctx.textAlign = el.textAlign;
  ctx.textBaseline = 'middle';
  const x = el.textAlign === 'center' ? w / 2 : el.textAlign === 'right' ? w - border : border;
  ctx.fillText(text, x, h / 2, available);
  if (el.underline) {
    const width = Math.min(ctx.measureText(text).width, available);
    const left = el.textAlign === 'center' ? x - width / 2 : el.textAlign === 'right' ? x - width : x;
    const thickness = Math.min(Math.max(0.5, fs / 14), Math.max(0, h - border * 2));
    const top = Math.max(border, Math.min(h / 2 + fs * 0.42, h - border - thickness));
    ctx.fillRect(left, top, width, thickness);
  }
  } finally {
    ctx.restore();
  }
}
