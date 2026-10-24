import "../mos-tools-extension/sticker-viscosity-core.js";

export const stickerViscosity = (globalThis as unknown as {
  MosStickerViscosity: {
    common: string[];
    normalize(value: unknown): string | null;
    extract(lines: unknown): string;
    tekmetricLines(ro: unknown): string[];
    draft(previous: ViscosityDraft | null, key: string, automatic: string, manual?: string): ViscosityDraft;
  };
}).MosStickerViscosity;
export interface ViscosityDraft { key: string; value: string; edited: boolean }
