import { HookInputError, MAX_HOOK_BYTES } from "./appfueled-url-contract";

/** Stream bound applies even with missing/lying Content-Length. */
export async function readHookJson(req: Request, timeMs = 1500): Promise<unknown> {
  if (req.headers.has("content-encoding") && req.headers.get("content-encoding") !== "identity") throw new HookInputError("unsupported_encoding", 415);
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers.get("content-type") || "")) throw new HookInputError("json_content_type_required", 415);
  const length = req.headers.get("content-length");
  if (length && (!/^\d+$/.test(length) || Number(length) > MAX_HOOK_BYTES)) throw new HookInputError("body_too_large", 413);
  if (!req.body) throw new HookInputError("invalid_json");
  const reader = req.body.getReader();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    const reading = (async () => {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > MAX_HOOK_BYTES) throw new HookInputError("body_too_large", 413);
        chunks.push(value);
      }
      const raw = Buffer.concat(chunks, bytes).toString("utf8");
      try { return JSON.parse(raw); } catch { throw new HookInputError("invalid_json"); }
    })();
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new HookInputError("body_timeout", 408)), timeMs);
    });
    return await Promise.race([reading, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
    void reader.cancel().catch(() => {});
  }
}

export function hookJson(body: unknown, status = 200) {
  return Response.json(body, { status, headers: {
    "Cache-Control": "no-store, private", "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
  } });
}