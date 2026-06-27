import { withExtensionErrorMarker } from "@/lib/extension-route-wrapper";
import { NextRequest, NextResponse } from "next/server";
import { guardExtensionShopRequest } from "@/lib/extension-route-guard";
import { getOpenAI, trackOpenAiCall } from "@/lib/ai";
import { enforceAiBudget } from "@/lib/ai-budget";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders });
}

// chrome.runtime messaging can't pass File/Blob, so the side panel reads the
// captured photo as a base64 string and posts JSON (unlike the dashboard route
// which takes multipart form-data).
async function _POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { shopId, imageBase64, mimeType, type } = body as {
      shopId?: string;
      imageBase64?: string;
      mimeType?: string;
      type?: string;
    };

    if (!shopId) {
      return NextResponse.json({ error: "shopId is required" }, { status: 400, headers: corsHeaders });
    }
    if (!imageBase64) {
      return NextResponse.json({ error: "No image provided" }, { status: 400, headers: corsHeaders });
    }

    const guard = await guardExtensionShopRequest(req, {
      smsShopId: shopId,
      provider: body.provider || "protractor",
      corsHeaders,
    });
    if (!guard.ok) return guard.response;

    const blocked = await enforceAiBudget({
      shopId: guard.mosShopId,
      route: "/api/extension/protractor/vin-plate-ocr",
      isPlatformAdmin: guard.isPlatformAdmin,
    });
    if (blocked) {
      const data = await blocked.json();
      return NextResponse.json(data, {
        status: blocked.status,
        headers: { ...corsHeaders, ...(blocked.headers.get("Retry-After") ? { "Retry-After": blocked.headers.get("Retry-After")! } : {}) },
      });
    }

    // Strip any data-URL prefix the client may have included.
    const base64 = imageBase64.replace(/^data:[^;]+;base64,/, "");
    const approxBytes = Math.floor((base64.length * 3) / 4);
    if (approxBytes > 10 * 1024 * 1024) {
      return NextResponse.json({ error: "Image too large (max 10MB)" }, { status: 400, headers: corsHeaders });
    }
    const mime = mimeType || "image/jpeg";

    let prompt = "";
    if (type === "vin") {
      prompt = `Look at this image and extract the VIN (Vehicle Identification Number). A VIN is exactly 17 characters long, containing uppercase letters and digits (no I, O, or Q). Return ONLY a JSON object with these fields:
- "vin": the extracted VIN string (uppercase, 17 characters), or null if not found
- "confidence": "high", "medium", or "low"
- "notes": brief note about extraction quality

Return ONLY valid JSON, no other text.`;
    } else if (type === "plate") {
      prompt = `Look at this image and extract the license plate number. Return ONLY a JSON object with these fields:
- "plate": the extracted license plate string (uppercase), or null if not found
- "state": the state/province if visible, or null
- "confidence": "high", "medium", or "low"
- "notes": brief note about extraction quality

Return ONLY valid JSON, no other text.`;
    } else {
      prompt = `Look at this image. Determine if it shows a VIN (Vehicle Identification Number) label/plate or a vehicle license plate, and extract the relevant information.

A VIN is exactly 17 characters (uppercase letters and digits, no I, O, or Q).
A license plate is typically 5-8 characters.

Return ONLY a JSON object with these fields:
- "type": "vin" or "plate" (which was detected)
- "vin": the VIN if detected (17 chars, uppercase), or null
- "plate": the license plate if detected (uppercase), or null
- "state": the state/province if visible on a plate, or null
- "confidence": "high", "medium", or "low"
- "notes": brief note about what was found

Return ONLY valid JSON, no other text.`;
    }

    const openai = getOpenAI();
    const ocrStart = Date.now();
    const response = await openai.chat.completions.create({
      model: "gpt-4o",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: prompt },
            {
              type: "image_url",
              image_url: {
                url: `data:${mime};base64,${base64}`,
                detail: "high",
              },
            },
          ],
        },
      ],
      max_tokens: 300,
      temperature: 0,
    });
    trackOpenAiCall(guard.mosShopId, "/api/extension/protractor/vin-plate-ocr", response, Date.now() - ocrStart);

    const rawText = response.choices[0]?.message?.content?.trim() || "";

    let parsed: any = null;
    try {
      const jsonMatch = rawText.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        parsed = JSON.parse(jsonMatch[0]);
      }
    } catch {
      console.error("[Extension VIN/Plate OCR] Failed to parse response:", rawText);
    }

    if (!parsed) {
      return NextResponse.json({ error: "Could not extract information from image", raw: rawText }, { status: 422, headers: corsHeaders });
    }

    return NextResponse.json({ success: true, result: parsed }, { headers: corsHeaders });
  } catch (err: any) {
    console.error("[Extension VIN/Plate OCR] Error:", err);
    return NextResponse.json({ error: err.message || "Internal error" }, { status: 500, headers: corsHeaders });
  }
}

// Task #510: per-shop error-rate alerting — wrap all extension handlers
export const POST = withExtensionErrorMarker(_POST as any);
