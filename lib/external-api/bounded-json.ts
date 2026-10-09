import { NextRequest } from "next/server";

export class BodyError extends Error {
  constructor(message: string, public status: number) { super(message); }
}

export async function readBoundedJson(req: NextRequest): Promise<unknown> {
  if (req.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json")
    throw new BodyError("Content-Type must be application/json", 415);
  if (Number(req.headers.get("content-length")) > 8192) throw new BodyError("Body exceeds 8192 bytes", 413);
  const reader = req.body?.getReader();
  if (!reader) throw new BodyError("JSON body required", 400);
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 8192) {
        await reader.cancel();
        throw new BodyError("Body exceeds 8192 bytes", 413);
      }
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch (error) {
    if (error instanceof BodyError) throw error;
    throw new BodyError("Malformed JSON", 400);
  } finally { reader.releaseLock(); }
}
