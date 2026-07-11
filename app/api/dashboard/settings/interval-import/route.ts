import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { getOpenAI, trackOpenAiCall } from "@/lib/ai";
import { enforceAiBudget } from "@/lib/ai-budget";
import { isPlatformAdmin as isPlatformAdminEmail } from "@/lib/super-admins";
import { sanitizeExtraction, buildIntervalProposals } from "@/lib/interval-import";
import { recordUnmatchedIntervalImportName } from "@/lib/interval-import-log";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_FILE_BYTES = 10 * 1024 * 1024;
const ROUTE = "/api/dashboard/settings/interval-import";

const IMAGE_MIMES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

const EXTRACTION_INSTRUCTIONS = `You are transcribing a shop's mileage-based maintenance guide. The document lists mileage milestones (e.g. "30,000 Mile Service") with the recommended services under each.

Return ONLY a JSON object with this exact shape:
{
  "confidence": "high" | "medium" | "low",
  "milestones": [
    {
      "miles": <milestone mileage as a number, e.g. 30000>,
      "services": [
        { "name": "<service line exactly as written, WITHOUT any parenthetical>", "note": "<parenthetical / inline rule text like 'Every 2 years or 30k' or 'If applicable', or null>" }
      ]
    }
  ]
}

Rules:
- Transcribe faithfully. Do NOT invent services or milestones that are not in the document.
- Keep inspect-only wording intact (e.g. "Inspect Cabin Air Filter" must keep the word "Inspect").
- Put any parenthetical or inline cadence/condition text into "note", not "name".
- If the document is not a mileage-based maintenance guide, or is unreadable/garbled, set "confidence" to "low" and return an empty "milestones" array.
- Return ONLY valid JSON, no other text.`;

async function extractDocxText(buf: Buffer): Promise<string | null> {
  try {
    const { Open } = await import("unzipper");
    const dir = await Open.buffer(buf);
    const entry = dir.files.find((f) => f.path === "word/document.xml");
    if (!entry) return null;
    const xml = (await entry.buffer()).toString("utf8");
    const text = xml
      .replace(/<\/w:p>/g, "\n")
      .replace(/<w:tab[^>]*\/>/g, "\t")
      .replace(/<[^>]+>/g, "")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
    return text || null;
  } catch (err) {
    console.error("[interval-import] docx extraction failed:", err);
    return null;
  }
}

type FileKind = "docx" | "pdf" | "image" | "text" | "unsupported";

function classifyFile(file: File): FileKind {
  const name = (file.name || "").toLowerCase();
  const mime = (file.type || "").toLowerCase();
  if (name.endsWith(".docx") || mime === "application/vnd.openxmlformats-officedocument.wordprocessingml.document") return "docx";
  if (name.endsWith(".pdf") || mime === "application/pdf") return "pdf";
  if (IMAGE_MIMES.has(mime) || /\.(png|jpe?g|webp|gif)$/.test(name)) return "image";
  if (name.endsWith(".txt") || mime === "text/plain") return "text";
  return "unsupported";
}

export async function POST(req: NextRequest) {
  try {
    const sess = await getSession();
    if (!sess) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const isAdmin = await isPlatformAdminEmail(sess.email);
    const blocked = await enforceAiBudget({
      shopId: Number(sess.shopId),
      route: ROUTE,
      isPlatformAdmin: isAdmin,
    });
    if (blocked) return blocked;

    const formData = await req.formData();
    const file = formData.get("document") as File | null;
    if (!file) {
      return NextResponse.json({ error: "No document provided" }, { status: 400 });
    }
    if (file.size > MAX_FILE_BYTES) {
      return NextResponse.json({ error: "File too large (max 10MB)" }, { status: 400 });
    }

    const kind = classifyFile(file);
    if (kind === "unsupported") {
      return NextResponse.json(
        { error: "Unsupported file type. Upload a .docx, .pdf, or an image (photo/scan) of the guide." },
        { status: 400 },
      );
    }

    const buf = Buffer.from(await file.arrayBuffer());

    // Build the user-message content for the extraction call.
    let userContent: any;
    if (kind === "docx" || kind === "text") {
      const text = kind === "docx" ? await extractDocxText(buf) : buf.toString("utf8").trim() || null;
      if (!text) {
        return NextResponse.json(
          { error: "Couldn't read any text from that document. Try re-saving it or uploading a PDF/photo instead." },
          { status: 422 },
        );
      }
      userContent = [
        { type: "text", text: `${EXTRACTION_INSTRUCTIONS}\n\nDocument text:\n"""\n${text.slice(0, 30000)}\n"""` },
      ];
    } else if (kind === "image") {
      const mimeType = file.type || "image/jpeg";
      userContent = [
        { type: "text", text: EXTRACTION_INSTRUCTIONS },
        {
          type: "image_url",
          image_url: { url: `data:${mimeType};base64,${buf.toString("base64")}`, detail: "high" },
        },
      ];
    } else {
      // pdf — send the file directly (GPT-4o supports PDF file inputs).
      userContent = [
        { type: "text", text: EXTRACTION_INSTRUCTIONS },
        {
          type: "file",
          file: {
            filename: file.name || "maintenance-guide.pdf",
            file_data: `data:application/pdf;base64,${buf.toString("base64")}`,
          },
        },
      ];
    }

    const openai = getOpenAI();
    const aiStart = Date.now();
    let response;
    try {
      response = await openai.chat.completions.create({
        model: "gpt-4o",
        messages: [{ role: "user", content: userContent }],
        max_tokens: 3000,
        temperature: 0,
        response_format: { type: "json_object" },
      });
    } catch (err: any) {
      console.error("[interval-import] OpenAI extraction failed:", err?.message || err);
      return NextResponse.json(
        { error: "The AI service couldn't process this document right now. Please try again." },
        { status: 502 },
      );
    }
    trackOpenAiCall(Number(sess.shopId), ROUTE, response, Date.now() - aiStart);

    const rawText = response.choices[0]?.message?.content?.trim() || "";
    let parsed: any = null;
    try {
      parsed = JSON.parse(rawText);
    } catch {
      const jsonMatch = rawText.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        try {
          parsed = JSON.parse(jsonMatch[0]);
        } catch {
          /* fall through */
        }
      }
    }

    if (!parsed) {
      console.error("[interval-import] Unparseable AI response:", rawText.slice(0, 500));
      return NextResponse.json(
        { error: "Couldn't read a maintenance schedule out of that document. Nothing was changed." },
        { status: 422 },
      );
    }

    if (parsed.confidence === "low") {
      return NextResponse.json(
        {
          error:
            "The document didn't look like a readable mileage-based maintenance guide. Nothing was changed — try a clearer scan or the original file.",
        },
        { status: 422 },
      );
    }

    const extraction = sanitizeExtraction(parsed);
    if (!extraction) {
      return NextResponse.json(
        { error: "Couldn't find any mileage milestones with services in that document. Nothing was changed." },
        { status: 422 },
      );
    }

    const result = buildIntervalProposals(extraction);
    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: 422 });
    }

    // Log unmatched names so the service-key synonym list can grow from
    // real shop documents (same pattern as the CARFAX match-gap tally).
    for (const name of result.unmatchedNames) {
      recordUnmatchedIntervalImportName(name, { shopId: sess.shopId });
    }

    return NextResponse.json({
      success: true,
      proposals: result.proposals,
      flagged: result.flagged,
      milestones: result.milestones,
      extractionConfidence: parsed.confidence === "medium" ? "medium" : "high",
    });
  } catch (err: any) {
    console.error("[interval-import] Error:", err);
    return NextResponse.json({ error: err.message || "Internal error" }, { status: 500 });
  }
}
