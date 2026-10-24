// Keep an ambiguous failed request pinned until success or changed input.
// Only successful completion releases the identity for an intentional reprint.
const pending = new Map<string, string>();
export function stickerPrintAction(key: string): string {
  const existing = pending.get(key);
  if (existing) return existing;
  const id = crypto.randomUUID();
  pending.set(key, id);
  return id;
}
export function completeStickerPrintAction(key: string): void {
  pending.delete(key);
  if (typeof window !== "undefined") window.dispatchEvent(new Event("sticker-supply-refresh"));
}
