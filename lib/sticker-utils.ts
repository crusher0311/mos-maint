export function getBaseUrl(): string {
  const baseUrl = process.env.NEXT_PUBLIC_BASE_URL || process.env.APP_BASE_URL;
  
  if (!baseUrl) {
    throw new Error(
      "Missing base URL configuration. Set NEXT_PUBLIC_BASE_URL or APP_BASE_URL environment variable."
    );
  }
  
  return baseUrl.replace(/\/$/, "");
}

export function getStickerRedirectUrl(shopId: number): string {
  return `${getBaseUrl()}/api/sticker/redirect/${shopId}`;
}
