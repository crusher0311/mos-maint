const DEEPGRAM_TTS_URL = "https://api.deepgram.com/v1/speak";

export interface TTSResult {
  audio: Buffer;
  contentType: string;
  characters: number;
}

export async function synthesizeSpeech(
  text: string,
  voiceId: string = "aura-asteria-en",
): Promise<TTSResult> {
  const apiKey = process.env.DEEPGRAM_API_KEY;
  if (!apiKey) throw new Error("DEEPGRAM_API_KEY is required");

  const params = new URLSearchParams({
    model: voiceId,
    encoding: "mulaw",
    sample_rate: "8000",
    container: "none",
  });

  const response = await fetch(`${DEEPGRAM_TTS_URL}?${params.toString()}`, {
    method: "POST",
    headers: {
      Authorization: `Token ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ text }),
  });

  if (!response.ok) {
    const errorBody = await response.text().catch(() => "");
    throw new Error(
      `Deepgram TTS failed: ${response.status} ${response.statusText} ${errorBody}`,
    );
  }

  const arrayBuffer = await response.arrayBuffer();
  return {
    audio: Buffer.from(arrayBuffer),
    contentType: "audio/mulaw",
    characters: text.length,
  };
}

export function chunkMulawAudio(
  audio: Buffer,
  frameSize: number = 160,
): Buffer[] {
  const chunks: Buffer[] = [];
  for (let offset = 0; offset < audio.length; offset += frameSize) {
    const end = Math.min(offset + frameSize, audio.length);
    const chunk = Buffer.alloc(frameSize, 0xff);
    audio.copy(chunk, 0, offset, end);
    chunks.push(chunk);
  }
  return chunks;
}
