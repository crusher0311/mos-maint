import { getSession } from "./auth";
import { getDb } from "./mongo";
import { renderStickerStandard, renderStickerDesigner } from "./canvas-renderer";
import { pngBufferToSizedPdfBuffer } from "./sticker-pdf";
export const stickerGenerateDeps = { getSession, getDb, renderStickerStandard, renderStickerDesigner, pngBufferToSizedPdfBuffer };
