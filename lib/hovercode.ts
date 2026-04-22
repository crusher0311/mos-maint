import { trackApiRequest } from "@/lib/api-usage-tracker";

const HOVERCODE_API_BASE = "https://hovercode.com/api/v2";

interface HovercodeCreateResponse {
  id: string;
  qr_data: string;
  qr_type: string;
  display_name: string;
  shortlink_url: string;
  dynamic: boolean;
  primary_color: string;
  background_color: string;
  svg?: string;
  svg_file?: string;
  png?: string;
  created: string;
}

interface HovercodeReadResponse {
  id: string;
  qr_data?: string;
  logo_url?: string | null;
  logo_image?: string | null;
  logo?: string | null;
  display_name?: string;
  primary_color?: string;
  background_color?: string;
  [key: string]: any;
}

interface DriftExpectation {
  qr_data?: string;
  logo_url?: string;
}

/**
 * Read-back guard: HoverCode returns 200 even when a field doesn't actually
 * stick (e.g. logo upload silently dropped). After create/update we GET the
 * record, compare the fields we set, and log a structured warning + push a
 * synthetic "drift" entry into api_usage so it shows up on the platform
 * observability page.
 *
 * This is purely advisory — failures here never bubble up to the caller.
 */
export async function verifyHovercode(
  hovercodeId: string,
  expected: DriftExpectation,
  shopId?: number,
  context: string = "verify"
): Promise<void> {
  const apiToken = process.env.HOVERCODE_API_TOKEN;
  if (!apiToken) return;

  const startTime = Date.now();
  const url = `${HOVERCODE_API_BASE}/hovercode/${hovercodeId}/`;

  try {
    const response = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Token ${apiToken}`,
        "Content-Type": "application/json",
      },
    });

    const latencyMs = Date.now() - startTime;

    if (!response.ok) {
      // Read-back itself failed; record as a drift signal too.
      const errText = await response.text().catch(() => "");
      console.warn(
        `[HoverCode-Drift] read-back GET failed for ${hovercodeId} (${context}): ${response.status} ${errText.slice(0, 120)}`
      );
      trackApiRequest(
        "hovercode",
        "/verify/drift",
        "GET",
        response.status,
        latencyMs,
        shopId,
        { errorMessage: `read-back failed (${context}): ${response.status}` }
      );
      return;
    }

    const record = (await response.json()) as HovercodeReadResponse;
    const mismatches: string[] = [];

    if (expected.qr_data !== undefined) {
      const actual = record.qr_data ?? "";
      if (actual !== expected.qr_data) {
        mismatches.push(
          `qr_data expected="${expected.qr_data}" actual="${actual}"`
        );
      }
    }

    if (expected.logo_url !== undefined && expected.logo_url) {
      // HoverCode commonly re-hosts logos, so we don't compare URLs verbatim;
      // we only require *some* logo to be present after the call.
      const hasLogo = Boolean(
        record.logo_url || record.logo_image || record.logo
      );
      if (!hasLogo) {
        mismatches.push(
          `logo missing after upload (sent="${expected.logo_url}")`
        );
      }
    }

    if (mismatches.length === 0) {
      // Track a successful verification so we can compute a drift rate later.
      trackApiRequest(
        "hovercode",
        "/verify/ok",
        "GET",
        200,
        latencyMs,
        shopId
      );
      return;
    }

    const summary = mismatches.join("; ");
    console.warn(
      `[HoverCode-Drift] ${context} ${hovercodeId}${shopId ? ` shop=${shopId}` : ""}: ${summary}`
    );
    trackApiRequest(
      "hovercode",
      "/verify/drift",
      "GET",
      409,
      latencyMs,
      shopId,
      { errorMessage: `${context}: ${summary}` }
    );
  } catch (err: any) {
    const latencyMs = Date.now() - startTime;
    console.warn(
      `[HoverCode-Drift] read-back threw for ${hovercodeId} (${context}): ${err?.message || err}`
    );
    trackApiRequest(
      "hovercode",
      "/verify/drift",
      "GET",
      0,
      latencyMs,
      shopId,
      { errorMessage: `read-back exception (${context}): ${err?.message || err}` }
    );
  }
}

interface CreateQRCodeOptions {
  shopId: number | string;
  shopName: string;
  primaryColor?: string;
  backgroundColor?: string;
  logoUrl?: string;
  pattern?: string;
  frame?: string;
}

export async function createHovercodeQR(options: CreateQRCodeOptions): Promise<{
  success: boolean;
  hovercodeId?: string;
  shortUrl?: string;
  error?: string;
}> {
  const apiToken = process.env.HOVERCODE_API_TOKEN;
  const workspaceId = process.env.HOVERCODE_WORKSPACE_ID;

  if (!apiToken || !workspaceId) {
    console.log("[HoverCode] API not configured, skipping QR creation");
    return { success: false, error: "HoverCode API not configured" };
  }

  const baseUrl = process.env.NEXT_PUBLIC_BASE_URL || "https://mos.tools";
  const destinationUrl = `${baseUrl}/sticker/redirect/${options.shopId}`;

  const startTime = Date.now();
  
  try {
    const prodDomain = process.env.NEXT_PUBLIC_BASE_URL || process.env.RENDER_EXTERNAL_URL || "https://mos.tools";
    const baseDomain = prodDomain.startsWith("http") ? prodDomain : `https://${prodDomain}`;
    const defaultLogoUrl = `${baseDomain}/appointment-logo.png`;
    
    const requestBody: Record<string, any> = {
      workspace: workspaceId,
      qr_data: destinationUrl,
      display_name: `MOS Sticker - ${options.shopName}`,
      primary_color: options.primaryColor || "#111111",
      background_color: options.backgroundColor || "#ffffff",
      dynamic: true,
      pattern: options.pattern || "Squares",
      eye_style: "Rounded",
      logo_url: options.logoUrl || defaultLogoUrl,
      generate_png: true,
    };
    
    if (options.frame) {
      requestBody.frame = options.frame;
    }
    
    console.log("[HoverCode] Creating QR with options:", {
      ...requestBody,
      workspace: "[redacted]"
    });
    
    const response = await fetch(`${HOVERCODE_API_BASE}/hovercode/create/`, {
      method: "POST",
      headers: {
        Authorization: `Token ${apiToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(requestBody),
    });

    const latencyMs = Date.now() - startTime;
    const shopIdNum = typeof options.shopId === 'string' ? parseInt(options.shopId, 10) : options.shopId;

    if (!response.ok) {
      const errorText = await response.text();
      console.error("[HoverCode] API error:", response.status, errorText);
      
      trackApiRequest("hovercode", "/hovercode/create/", "POST", response.status, latencyMs, shopIdNum);

      return { 
        success: false, 
        error: `HoverCode API error: ${response.status}` 
      };
    }

    const data: HovercodeCreateResponse = await response.json();
    
    trackApiRequest("hovercode", "/hovercode/create/", "POST", 200, latencyMs, shopIdNum);

    console.log(`[HoverCode] Created QR code ${data.id} for shop ${options.shopId}`);

    // Read-back guard — don't trust the 200 from create. Fire-and-forget.
    verifyHovercode(
      data.id,
      { qr_data: requestBody.qr_data, logo_url: requestBody.logo_url },
      shopIdNum,
      "create"
    ).catch(() => {});

    return {
      success: true,
      hovercodeId: data.id,
      shortUrl: data.shortlink_url,
    };
  } catch (error: any) {
    const latencyMs = Date.now() - startTime;
    console.error("[HoverCode] Create QR error:", error);
    
    const shopIdNum = typeof options.shopId === 'string' ? parseInt(options.shopId, 10) : options.shopId;
    trackApiRequest("hovercode", "/hovercode/create/", "POST", 0, latencyMs, shopIdNum);

    return { 
      success: false, 
      error: error?.message || "Failed to create QR code" 
    };
  }
}

async function patchHovercode(
  hovercodeId: string,
  patch: Record<string, any>,
  shopId?: number,
  context: string = "update"
): Promise<{ success: boolean; error?: string }> {
  const apiToken = process.env.HOVERCODE_API_TOKEN;
  if (!apiToken) return { success: false, error: "HoverCode API not configured" };

  const startTime = Date.now();
  // Use the proven endpoint shape (PUT /hovercode/<id>/update/) — same as
  // app/api/sticker/settings/route.ts. Note HOVERCODE_API_BASE here is
  // .../api/v2 (no trailing /hovercode), so we add it explicitly.
  const url = `${HOVERCODE_API_BASE}/hovercode/${hovercodeId}/update/`;

  try {
    const response = await fetch(url, {
      method: "PUT",
      headers: {
        Authorization: `Token ${apiToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(patch),
    });

    const latencyMs = Date.now() - startTime;
    trackApiRequest("hovercode", `/${hovercodeId}/update/`, "PUT", response.status, latencyMs, shopId);

    if (!response.ok) {
      const errText = await response.text().catch(() => "");
      return { success: false, error: `HoverCode API error: ${response.status} ${errText.slice(0, 200)}` };
    }

    // Read-back guard — fire-and-forget verification of the patched fields.
    const expected: DriftExpectation = {};
    if (typeof patch.qr_data === "string") expected.qr_data = patch.qr_data;
    if (typeof patch.logo_url === "string") expected.logo_url = patch.logo_url;
    if (expected.qr_data !== undefined || expected.logo_url !== undefined) {
      verifyHovercode(hovercodeId, expected, shopId, context).catch(() => {});
    }

    return { success: true };
  } catch (error: any) {
    return { success: false, error: error?.message || "Failed to update QR code" };
  }
}

export async function updateHovercodeDestination(
  hovercodeId: string,
  newDestination: string,
  shopId?: number
): Promise<{ success: boolean; error?: string }> {
  return patchHovercode(hovercodeId, { qr_data: newDestination }, shopId, "update-destination");
}

export async function updateHovercodeLogo(
  hovercodeId: string,
  logoUrl: string,
  shopId?: number
): Promise<{ success: boolean; error?: string }> {
  return patchHovercode(hovercodeId, { logo_url: logoUrl }, shopId, "update-logo");
}
