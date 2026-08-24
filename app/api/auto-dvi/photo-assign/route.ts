// Task #991 — Auto DVI photo auto-assignment: a batch of inspection photos
// plus the vehicle checklist goes to one GPT-4o vision call; each photo
// comes back tagged with the checklist item it shows (or null when the
// model isn't confident). Classification only — the client attaches the
// photo via the existing media upload once the tech confirms.

import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { checkShopFeatureGate } from "@/lib/extension-route-guard";
import { getOpenAI, trackOpenAiCall } from "@/lib/ai";
import { parseChecklistParam, normalizeVoiceName } from "@/lib/auto-dvi/voice-parse";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const MAX_PHOTOS = 8;
const MAX_PHOTO_BYTES = 8 * 1024 * 1024;
const PHOTO_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const TIMEOUT_MS = 30_000;

export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = await checkShopFeatureGate(Number(session.shopId), ["auto_dvi"], {
    isPlatformAdmin: session.role === "platform_admin",
    featureLabel: "Auto DVI",
  });
  if (denied) return denied;

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ error: "Expected multipart form data" }, { status: 400 });
  }
  const checklist = parseChecklistParam(form.get("items"));
  if (checklist.length === 0) {
    return NextResponse.json({ error: "items (checklist) is required" }, { status: 400 });
  }
  const photos = form.getAll("photos").filter((p): p is File => p instanceof File && p.size > 0);
  if (photos.length === 0) return NextResponse.json({ error: "at least one photo is required" }, { status: 400 });
  if (photos.length > MAX_PHOTOS) {
    return NextResponse.json({ error: `max ${MAX_PHOTOS} photos per batch` }, { status: 400 });
  }
  for (const p of photos) {
    if (!PHOTO_TYPES.has(p.type)) {
      return NextResponse.json({ error: `unsupported photo type ${p.type || "unknown"}` }, { status: 400 });
    }
    if (p.size > MAX_PHOTO_BYTES) {
      return NextResponse.json({ error: "each photo must be under 8MB" }, { status: 400 });
    }
  }

  const names = checklist.map((c) => c.name);
  const content: any[] = [
    {
      type: "text",
      text: [
        "You are labeling photos taken during an automotive vehicle inspection.",
        "For EACH photo, decide which ONE checklist item it most likely documents.",
        "Checklist items:",
        ...names.map((n) => `- ${n}`),
        "",
        `Respond with JSON only: {"assignments":[{"index": <photo number starting at 0>, "item": "<checklist item name copied exactly, or null when unsure>", "label": "<3-6 word English description of what the photo shows>"}]}`,
        "Use null for item when the photo does not clearly show any checklist item — never guess.",
        `There are ${photos.length} photos, in order.`,
      ].join("\n"),
    },
  ];
  for (const p of photos) {
    const b64 = Buffer.from(await p.arrayBuffer()).toString("base64");
    content.push({ type: "image_url", image_url: { url: `data:${p.type};base64,${b64}`, detail: "low" } });
  }

  try {
    const openai = getOpenAI();
    const started = Date.now();
    const completion = await openai.chat.completions.create(
      {
        model: "gpt-4o",
        response_format: { type: "json_object" },
        temperature: 0,
        messages: [{ role: "user", content }],
      },
      { signal: AbortSignal.timeout(TIMEOUT_MS) },
    );
    trackOpenAiCall(Number(session.shopId), "/api/auto-dvi/photo-assign", completion as any, Date.now() - started, 200);
    let parsed: any = {};
    try {
      parsed = JSON.parse(completion.choices?.[0]?.message?.content || "{}");
    } catch {
      parsed = {};
    }
    const byName = new Map(checklist.map((c) => [normalizeVoiceName(c.name), c]));
    const raw: any[] = Array.isArray(parsed.assignments) ? parsed.assignments : [];
    const assignments = photos.map((_, i) => {
      const a = raw.find((x) => Number(x?.index) === i);
      const match = a && typeof a.item === "string" ? byName.get(normalizeVoiceName(a.item)) : undefined;
      return {
        index: i,
        itemId: match?.itemId ?? null,
        itemName: match?.name ?? null,
        label: a && typeof a.label === "string" ? a.label.slice(0, 120) : null,
      };
    });
    return NextResponse.json({ ok: true, assignments });
  } catch (err: any) {
    return NextResponse.json(
      { ok: false, error: `Photo classification failed: ${err?.message || String(err)}` },
      { status: 502 },
    );
  }
}
