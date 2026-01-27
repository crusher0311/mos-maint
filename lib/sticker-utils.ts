export function getBaseUrl(): string {
  // Check explicit configuration first
  const baseUrl = process.env.NEXT_PUBLIC_BASE_URL || process.env.APP_BASE_URL;
  
  if (baseUrl) {
    return baseUrl.replace(/\/$/, "");
  }
  
  // Auto-detect Render environment
  if (process.env.RENDER_EXTERNAL_URL) {
    return process.env.RENDER_EXTERNAL_URL.replace(/\/$/, "");
  }
  
  // Fallback for development
  if (process.env.NODE_ENV === "development") {
    return "http://localhost:3000";
  }
  
  throw new Error(
    "Missing base URL configuration. Set NEXT_PUBLIC_BASE_URL or APP_BASE_URL environment variable."
  );
}

export function getStickerRedirectUrl(shopId: number): string {
  return `${getBaseUrl()}/api/sticker/redirect/${shopId}`;
}
