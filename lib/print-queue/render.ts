/**
 * ZINK Cloud Print Queue — image generation glue (task #542, Milestone 2).
 *
 * Reuses the existing canvas renderers (`lib/canvas-renderer.ts`) — the
 * same functions the `/api/extension/keytag` and `/api/extension/sticker`
 * routes use — rather than reimplementing any rendering logic. This module
 * only adapts their PNG output into the bare base64 JPEG payload the agent
 * contract expects, and provides a thin keytag config -> renderer bridge.
 */

import { renderKeytagLegacy, renderKeytagDesigner } from "@/lib/canvas-renderer";
import type { DesignerLayout } from "@/lib/keytag-designer-types";
import { resolvePaperSize } from "@/lib/keytag-paper-sizes";

const DATA_URI_RE = /^data:([\w/+.-]+);base64,(.*)$/s;

/**
 * Normalize any image input (Buffer, bare base64, or data URI — PNG or
 * JPEG) into a bare base64 JPEG string. The agent decodes this directly;
 * encoding as JPEG keeps the wire payload aligned with the contract.
 */
export async function toJpegBase64(input: Buffer | string): Promise<string> {
  const { createCanvas, loadImage } = require("canvas");

  let buf: Buffer;
  if (Buffer.isBuffer(input)) {
    buf = input;
  } else {
    let b64 = input.trim();
    const m = b64.match(DATA_URI_RE);
    if (m) b64 = m[2];
    b64 = b64.replace(/\s+/g, "");
    buf = Buffer.from(b64, "base64");
  }
  if (buf.length === 0) {
    throw new Error("image payload decoded to zero bytes");
  }

  const img = await loadImage(buf);
  const canvas = createCanvas(img.width, img.height);
  const ctx = canvas.getContext("2d");
  // White matte so any transparency flattens to white (thermal media is
  // white) instead of black.
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, img.width, img.height);
  ctx.drawImage(img, 0, 0, img.width, img.height);

  const jpeg = canvas.toBuffer("image/jpeg", { quality: 0.92 });
  return jpeg.toString("base64");
}

export interface KeytagConfigLike {
  colors?: { text?: string; background?: string };
  designerLayout?: DesignerLayout;
}

export interface KeytagRenderInput {
  customerName: string;
  vehicleInfo: string;
  vin?: string;
  roNumber: string;
  mileage: string | number;
}

/**
 * Render a keytag PNG buffer from a shop's keytag config + RO data,
 * mirroring the path `/api/extension/keytag` uses (designer layout when
 * present, legacy otherwise). Returns the raw PNG Buffer.
 */
export async function renderKeytagBuffer(
  config: KeytagConfigLike | null | undefined,
  data: KeytagRenderInput,
): Promise<Buffer> {
  const cfg = config ?? {};
  const paper = resolvePaperSize(cfg.designerLayout?.paperSize);

  if (cfg.designerLayout) {
    return renderKeytagDesigner(
      {
        elements: cfg.designerLayout.elements,
        canvasWidth: cfg.designerLayout.canvasWidth || paper.designWidth,
        canvasHeight: cfg.designerLayout.canvasHeight || paper.designHeight,
        backgroundColor: cfg.designerLayout.backgroundColor || "#FFFFFF",
        textColor: cfg.designerLayout.textColor || "#000000",
      },
      data,
      paper.renderWidth,
      paper.renderHeight,
      2,
    );
  }

  return renderKeytagLegacy(
    { colors: cfg.colors },
    data,
    paper.renderWidth,
    paper.renderHeight,
    2,
  );
}
