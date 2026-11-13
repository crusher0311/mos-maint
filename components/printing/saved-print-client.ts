import type { DestinationSettings, LabelKind, PrintStock, SavedDestination } from "@/lib/print-queue/ipp-contract";

export const browserDefaultKey = (shopId: number, kind: LabelKind) => `mos:printing:v1:${shopId}:${kind}`;
export function readBrowserDefault(settings: DestinationSettings): string | null | undefined {
  try {
    const raw = localStorage.getItem(browserDefaultKey(settings.shopId, settings.kind));
    if (raw === null) return undefined;
    const parsed: unknown = JSON.parse(raw);
    return parsed === null || typeof parsed === "string" ? parsed : undefined;
  } catch { return undefined; }
}
export function writeBrowserDefault(settings: DestinationSettings, id: string | null | undefined) {
  const key = browserDefaultKey(settings.shopId, settings.kind);
  if (id === undefined) localStorage.removeItem(key);
  else localStorage.setItem(key, JSON.stringify(id));
}
export function resolvedDefault(settings: DestinationSettings) {
  const local = readBrowserDefault(settings);
  return local === undefined ? settings.defaultDestinationId : local;
}
export async function printJson<T>(url: string, init?: RequestInit): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    const response = await fetch(url, { credentials: "include", cache: "no-store", ...init, signal: init?.signal || controller.signal });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `Printing request failed (${response.status})`);
    return data as T;
  } catch (error) {
    if (controller.signal.aborted) throw new Error("Printing request timed out.");
    throw error;
  } finally { clearTimeout(timer); }
}
export function inchesToStock(width: number | string, height: number | string): PrintStock {
  const parse = (value: number | string) => {
    if (typeof value === "string" && !/^\d+(\.\d+)?in$/.test(value)) throw new Error("Rendered label dimensions are unavailable. Nothing was sent.");
    const inches = typeof value === "number" ? value : Number(value.slice(0, -2));
    if (!Number.isFinite(inches) || inches <= 0) throw new Error("Rendered label dimensions are unavailable. Nothing was sent.");
    return Math.round(inches * 2540);
  };
  return { width: parse(width), height: parse(height) };
}
export function assertMatchingStock(destination: SavedDestination, stock: PrintStock) {
  if (destination.stock.width !== stock.width || destination.stock.height !== stock.height) {
    throw new Error("This label's rendered size does not match the selected printer stock. Choose matching stock or use Browser Print. Nothing was sent.");
  }
}
export function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("Could not read rendered label. Nothing was sent."));
    reader.readAsDataURL(blob);
  });
}
