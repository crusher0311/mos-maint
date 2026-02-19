import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import OpenAI from "openai";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const openai = new OpenAI();

export async function POST(req: NextRequest) {
  try {
    const sess = await getSession();
    if (!sess) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const formData = await req.formData();
    const file = formData.get("image") as File | null;
    const type = (formData.get("type") as string) || "auto";

    if (!file) {
      return NextResponse.json({ error: "No image provided" }, { status: 400 });
    }

    if (file.size > 10 * 1024 * 1024) {
      return NextResponse.json({ error: "Image too large (max 10MB)" }, { status: 400 });
    }

    const bytes = await file.arrayBuffer();
    const base64 = Buffer.from(bytes).toString("base64");
    const mimeType = file.type || "image/jpeg";

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
                url: `data:${mimeType};base64,${base64}`,
                detail: "high",
              },
            },
          ],
        },
      ],
      max_tokens: 300,
      temperature: 0,
    });

    const rawText = response.choices[0]?.message?.content?.trim() || "";

    let parsed: any = null;
    try {
      const jsonMatch = rawText.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        parsed = JSON.parse(jsonMatch[0]);
      }
    } catch {
      console.error("[VIN/Plate OCR] Failed to parse response:", rawText);
    }

    if (!parsed) {
      return NextResponse.json({ error: "Could not extract information from image", raw: rawText }, { status: 422 });
    }

    return NextResponse.json({ success: true, result: parsed });
  } catch (err: any) {
    console.error("[VIN/Plate OCR] Error:", err);
    return NextResponse.json({ error: err.message || "Internal error" }, { status: 500 });
  }
}
