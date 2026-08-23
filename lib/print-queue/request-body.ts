import {
  MAX_PRINT_REQUEST_BODY_BYTES,
  PrintPayloadTooLargeError,
} from "./types";

/**
 * Read and parse a print request with a hard byte cap, including chunked
 * requests. req.json()/req.text() allocate the full body before callers can
 * inspect imageBase64, so the queue front doors use this instead.
 */
export async function readPrintJsonBody(
  req: Request,
  maxBytes = MAX_PRINT_REQUEST_BODY_BYTES,
): Promise<any> {
  const declaredLength = Number(req.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    await req.body?.cancel().catch(() => undefined);
    throw new PrintPayloadTooLargeError();
  }
  if (!req.body) throw new SyntaxError("Request body is empty");

  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new PrintPayloadTooLargeError();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const raw = Buffer.concat(
    chunks.map((chunk) => Buffer.from(chunk)),
    total,
  ).toString("utf8");
  return JSON.parse(raw);
}