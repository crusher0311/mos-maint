import "../mos-tools-extension/sticker-personalization-core.js";

export const stickerPersonalization = (globalThis as typeof globalThis & {
  MosStickerPersonalization: {
    tagline(config: { personalizeThankYou?: boolean; tagline?: string }, context: { roId?: unknown; customerName?: unknown }, manual?: unknown): string;
  };
}).MosStickerPersonalization;
