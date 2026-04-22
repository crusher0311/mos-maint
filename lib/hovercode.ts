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
  patch: Record<string, any>
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
    trackApiRequest("hovercode", `/${hovercodeId}/update/`, "PUT", response.status, latencyMs);

    if (!response.ok) {
      const errText = await response.text().catch(() => "");
      return { success: false, error: `HoverCode API error: ${response.status} ${errText.slice(0, 200)}` };
    }
    return { success: true };
  } catch (error: any) {
    return { success: false, error: error?.message || "Failed to update QR code" };
  }
}

export async function updateHovercodeDestination(
  hovercodeId: string,
  newDestination: string
): Promise<{ success: boolean; error?: string }> {
  return patchHovercode(hovercodeId, { qr_data: newDestination });
}

export async function updateHovercodeLogo(
  hovercodeId: string,
  logoUrl: string
): Promise<{ success: boolean; error?: string }> {
  return patchHovercode(hovercodeId, { logo_url: logoUrl });
}
