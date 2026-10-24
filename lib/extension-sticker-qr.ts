import type { Db } from "mongodb";
import { getStickerRedirectUrl } from "./sticker-utils";

interface Config {
  hovercodeQRId?: string;
  qrTargetUrl?: string;
  cachedQrCodeDataUri?: string;
  colors?: { background?: string };
}

type Result = { dataUri: string; id: string; source: string };
type Dependencies = {
  fetch?: typeof fetch;
  timeoutMs?: number;
  decode: (data: string) => Promise<string | null>;
  svgToPng: (svg: string, size: number, logo: string | null, signal: AbortSignal) => Promise<string | null>;
};

/**
 * One budget for cache reads, provider requests, response bodies and images.
 * The raced work is read/create-only: a late completion cannot publish a cache.
 * Never log provider bodies, URLs or IDs (vehicle targets are bearer links).
 */
export async function getExtensionStickerQr(
  db: Db, shopId: number, target: string, config: Config, shopName: string,
  deps: Dependencies,
): Promise<string | null> {
  const generic = target === getStickerRedirectUrl(shopId);
  const controller = new AbortController();
  const signal = controller.signal;
  const request = deps.fetch || fetch;
  let reason = "unavailable";
  const diagnostic = (outcome: string) =>
    console.info("[Extension Sticker QR]", { shopId, kind: generic ? "generic" : "vehicle", outcome });
  const check = () => signal.throwIfAborted();
  const fetchChecked = async (url: string, init?: RequestInit) => {
    check();
    return request(url, { ...init, signal });
  };
  const image = async (record: any): Promise<string | null> => {
    if (record.png) {
      try {
        const response = await fetchChecked(record.png);
        if (response.ok) {
          const bytes = Buffer.from(await response.arrayBuffer());
          check();
          const decoded = await deps.decode(`data:image/png;base64,${bytes.toString("base64")}`);
          if (decoded) return decoded;
        }
      } catch { check(); }
    }
    let svg = record.svg;
    if (!svg && record.svg_file) {
      const response = await fetchChecked(record.svg_file);
      if (response.ok) svg = await response.text();
    }
    check();
    if (svg) return deps.svgToPng(svg, 300, record.logo || null, signal);
    return null;
  };
  const work = async (): Promise<Result | null> => {
    if (generic) {
      if (config.hovercodeQRId) {
        try {
          const media = await db.collection("shop_media").findOne({
            shopId, type: "qr_code", hovercodeId: config.hovercodeQRId, targetUrl: target,
          });
          check();
          if (media?.dataUri) {
            const decoded = await deps.decode(media.dataUri);
            if (decoded) return { dataUri: decoded, id: config.hovercodeQRId, source: "media_cache" };
          }
        } catch { check(); }
      }
      if (config.hovercodeQRId && config.qrTargetUrl === target && config.cachedQrCodeDataUri) {
        const decoded = await deps.decode(config.cachedQrCodeDataUri);
        if (decoded) return { dataUri: decoded, id: config.hovercodeQRId, source: "config_cache" };
      }
    }
    const token = process.env.HOVERCODE_API_TOKEN;
    const workspace = process.env.HOVERCODE_WORKSPACE_ID;
    if (!token) { reason = "not_configured"; return null; }
    const base = "https://hovercode.com/api/v2/hovercode";
    const headers = { Authorization: `Token ${token}`, "Content-Type": "application/json" };
    if (generic && config.hovercodeQRId) {
      try {
        const response = await fetchChecked(`${base}/${encodeURIComponent(config.hovercodeQRId)}/`, { headers });
        if (response.ok) {
          const record = await response.json();
          check();
          if (record.qr_data === target) {
            const dataUri = await image(record);
            if (dataUri) return { dataUri, id: config.hovercodeQRId, source: "existing" };
          }
        }
      } catch { check(); }
    }
    if (!workspace) { reason = "not_configured"; return null; }
    const logoBase = (process.env.NEXT_PUBLIC_BASE_URL || "https://mos.tools").replace(/\/$/, "");
    const response = await fetchChecked(`${base}/create/`, {
      method: "POST", headers,
      body: JSON.stringify({
        workspace, qr_data: target, dynamic: true,
        display_name: `${shopName} - Oil Sticker`,
        primary_color: "#111111", background_color: "#ffffff",
        pattern: "Squares", eye_style: "Rounded", size: 300,
        logo_url: `${logoBase}/appointment-logo.png`, generate_png: true,
      }),
    });
    if (!response.ok) { reason = `provider_http_${response.status}`; return null; }
    const record = await response.json();
    check();
    if (typeof record.id !== "string" || !record.id ||
        (record.qr_data !== undefined && record.qr_data !== target)) {
      reason = "provider_invalid_response"; return null;
    }
    const dataUri = await image(record);
    if (!dataUri) { reason = "image_unavailable"; return null; }
    return { dataUri, id: record.id, source: "created" };
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      work(),
      new Promise<null>(resolve => {
        timer = setTimeout(() => { reason = "timeout"; controller.abort(); resolve(null); }, deps.timeoutMs ?? 6000);
      }),
    ]);
    if (!result) { diagnostic(`local_fallback:${reason}`); return null; }
    if (generic && (result.source === "created" || result.source === "existing")) {
      // CAS prevents an in-flight print from replacing a newer settings identity.
      // Preserve legacy handles and publish the image/target/ID in ONE write.
      const update = db.collection("shops").updateOne(
        { shopId, "stickerConfig.hovercodeQRId": config.hovercodeQRId ?? { $exists: false },
          "stickerConfig.qrTargetUrl": config.qrTargetUrl ?? { $exists: false } },
        {
          $set: {
            "stickerConfig.hovercodeQRId": result.id,
            "stickerConfig.qrTargetUrl": target,
            "stickerConfig.cachedQrCodeDataUri": result.dataUri,
          },
          ...(config.hovercodeQRId && !config.qrTargetUrl
            ? { $addToSet: { "stickerConfig.legacyHovercodeQRIds": config.hovercodeQRId } } : {}),
        },
      );
      // Cache persistence is optional; don't hold printing past the same budget.
      await Promise.race([
        update.catch(() => { diagnostic("cache_publish_failed"); }),
        new Promise<void>(resolve => {
          if (signal.aborted) resolve();
          else signal.addEventListener("abort", () => resolve(), { once: true });
        }),
      ]);
    }
    diagnostic(`hovercode:${result.source}`);
    return result.dataUri;
  } catch {
    diagnostic(`local_fallback:${signal.aborted ? "timeout" : "provider_or_image_error"}`);
    return null;
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}
