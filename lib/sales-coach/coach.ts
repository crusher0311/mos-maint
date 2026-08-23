// Transcription + AI coaching for the sales trainer (task #987).
//
// Transcription prefers Deepgram (already a dependency, DEEPGRAM_API_KEY on
// prod) and falls back to OpenAI audio via the central lib/ai client.
// Coaching runs through the same OpenAI client with token usage recorded via
// trackOpenAiCall so it shows up in api_usage / the AI budget telemetry.
import { getOpenAI, trackOpenAiCall } from "@/lib/ai";
import type { SalesCoachScenarioContext, SalesCoachFeedback } from "@/lib/db/schema/sales-coach";

const ROUTE = "/api/platform-admin/sales-coach/sessions";

export async function transcribeAudio(
  audio: Buffer,
  mime: string,
): Promise<{ transcript: string; provider: string }> {
  if (process.env.DEEPGRAM_API_KEY) {
    try {
      const { DeepgramClient } = await import("@deepgram/sdk");
      const dg = new DeepgramClient({ apiKey: process.env.DEEPGRAM_API_KEY });
      const result = await dg.listen.v1.media.transcribeFile(new Uint8Array(audio), {
        model: "nova-2",
        smart_format: true,
      });
      const transcript =
        ("results" in result
          ? result.results.channels?.[0]?.alternatives?.[0]?.transcript
          : undefined
        )?.trim() || "";
      if (transcript) return { transcript, provider: "deepgram" };
      console.warn("[SalesCoach] Deepgram returned empty transcript; falling back to OpenAI");
    } catch (err: any) {
      console.warn(`[SalesCoach] Deepgram transcription failed, falling back to OpenAI: ${err?.message || err}`);
    }
  }

  const openai = getOpenAI();
  const ext = mime.includes("ogg") ? "ogg" : mime.includes("mp4") ? "mp4" : mime.includes("mpeg") ? "mp3" : "webm";
  const file = new File([new Uint8Array(audio)], `pitch.${ext}`, { type: mime });
  const res = await openai.audio.transcriptions.create({
    model: "whisper-1",
    file,
  });
  return { transcript: (res.text || "").trim(), provider: "openai-whisper" };
}

function describeScenario(ctx: SalesCoachScenarioContext): string {
  const vehicle = ctx.vehicle
    ? `${ctx.vehicle.year ?? ""} ${ctx.vehicle.make ?? ""} ${ctx.vehicle.model ?? ""}`.trim()
    : "Unknown vehicle";
  const jobs = ctx.jobs.map((j, i) =>
    `${i + 1}. ${j.title} — $${j.total.toFixed(2)} (labor $${j.laborTotal.toFixed(2)}${j.laborHours ? ` / ${j.laborHours}h` : ""}, parts $${j.partsTotal.toFixed(2)})${j.declined ? ` [DECLINED${j.declineReason ? `: ${j.declineReason}` : ""}]` : ""}`
  ).join("\n");
  return [
    `Vehicle: ${vehicle}${ctx.odometerIn ? ` at ${ctx.odometerIn.toLocaleString()} miles` : ""}`,
    ctx.customerFirstName ? `Customer: ${ctx.customerFirstName}` : null,
    ctx.customerConcern ? `Customer concern: ${ctx.customerConcern}` : null,
    `Estimate total: $${ctx.grandTotal.toFixed(2)}`,
    ctx.declinedTotal > 0 ? `Declined work total: $${ctx.declinedTotal.toFixed(2)}` : null,
    `Recommended jobs:\n${jobs}`,
  ].filter(Boolean).join("\n");
}

export async function coachPitch(
  ctx: SalesCoachScenarioContext,
  transcript: string,
): Promise<SalesCoachFeedback> {
  const openai = getOpenAI();
  const start = Date.now();
  const completion = await openai.chat.completions.create({
    model: "gpt-4o",
    messages: [
      {
        role: "system",
        content: `You are an elite automotive service-advisor sales coach. A service advisor is practicing the phone/counter pitch for a real repair order. You are given the RO's actual jobs, prices, and declined items, plus a transcript of the advisor's spoken pitch.

Evaluate the pitch STRICTLY against this scenario's specifics:
- Did they mention the actual recommended jobs and use real prices (or reasonable roundings) rather than vague amounts?
- Did they build value (safety, reliability, cost-of-delay) around the work — whether per job or for the visit as a whole?
- Did they address the customer's stated concern first?
- ONLY IF the scenario lists declined items: did they attempt to recover them with empathy rather than pressure? If the scenario has no declined items, this criterion does not exist — never mention declined items in your feedback.
- Clarity, structure, confidence, and a clear close / next step.

Ground every point in the transcript:
- Each "toImprove" item must QUOTE or closely paraphrase the transcript moment it refers to, or state exactly what phrase was searched for and not found. Before criticizing a missing element (concern acknowledgment, close/next step, value framing), re-read the transcript to confirm it is actually missing. If the advisor did it, credit it under "whatWorked" instead — even a brief version counts as done (you may suggest strengthening it, but never claim it was absent).
- Acknowledging the diagnostic/concern ("we found the source of your problem") COUNTS as addressing the customer's concern first. A closing question like "would you like us to get started?" COUNTS as a clear close/next step.
- Do not invent customer objections, declined items, or scenario details that are not in the data provided.
- The transcript is machine-generated speech-to-text: dollar amounts and numbers may be garbled (e.g. "$16.42.80" for "$1,642.80"). Interpret malformed numbers charitably against the scenario's real prices; never penalize the advisor for a transcription artifact.

Respect legitimate style differences:
- Presenting one grand total for the visit (rather than per-job prices) is a valid, common approach — advisors often present the full total and handle prioritization only when the customer objects. Do not mark it down as a structural flaw; only critique HOW the total was framed and supported.
- NEVER judge whether the shop's pricing is high or low — evaluate only how the advisor communicates it.

Return ONLY a JSON object:
{
  "score": 0-100 integer,
  "summary": "2-3 sentence overall assessment",
  "whatWorked": ["specific strength", ...],   // 2-4 items
  "toImprove": ["specific, actionable improvement", ...],   // 2-4 items
  "suggestedPhrasing": "A short example of stronger phrasing for the weakest moment of the pitch, tailored to this RO's actual jobs and prices."
}`,
      },
      {
        role: "user",
        content: `SCENARIO (real repair order):\n${describeScenario(ctx)}\n\nADVISOR'S PITCH TRANSCRIPT:\n"""${transcript}"""`,
      },
    ],
    temperature: 0.4,
    max_tokens: 900,
    response_format: { type: "json_object" },
  });
  trackOpenAiCall(null, ROUTE, completion, Date.now() - start);

  let parsed: any = {};
  try {
    parsed = JSON.parse(completion.choices[0]?.message?.content || "{}");
  } catch {
    // fall through to defaults below
  }
  const score = Math.max(0, Math.min(100, Math.round(Number(parsed.score) || 0)));
  return {
    score,
    summary: typeof parsed.summary === "string" ? parsed.summary : "No summary produced.",
    whatWorked: Array.isArray(parsed.whatWorked) ? parsed.whatWorked.map(String).slice(0, 6) : [],
    toImprove: Array.isArray(parsed.toImprove) ? parsed.toImprove.map(String).slice(0, 6) : [],
    suggestedPhrasing: typeof parsed.suggestedPhrasing === "string" ? parsed.suggestedPhrasing : "",
  };
}
