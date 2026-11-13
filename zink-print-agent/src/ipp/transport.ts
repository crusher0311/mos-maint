import http from "node:http";
import https from "node:https";
import { resolveAddress } from "../printer";
import { decodeReply, encodeRequest, MAX_REPLY_BYTES, type Attributes, type Reply } from "./codec";

export interface Exchange {
  (uri: string, operation: number, groups: { tag: number; values: Attributes }[],
    document?: Buffer): Promise<Reply>;
}
export class IppDiagnosticError extends Error {
  constructor(public readonly code: string) { super(code); }
}

/** Only local enrollment supplies this URI. Cloud payloads must never supply it. */
export function printerUrl(uri: string): URL {
  const url = new URL(uri);
  if (!["ipp:", "ipps:"].includes(url.protocol) || !url.hostname ||
      url.username || url.password || url.search || url.hash || uri.length > 1024)
    throw new Error("Expected an IPP/IPPS printer URI without credentials or query");
  return url;
}

/** No redirects, HTTP retries, bearer tokens, or insecure TLS options. */
export function createExchange(timeoutMs = 10000): Exchange {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 60000)
    throw new Error("IPP timeout must be between 100 and 60000ms");
  let requestId = 0;
  return async (uri, operation, groups, document) => {
    const url = printerUrl(uri);
    const hostname = url.hostname.replace(/^\[|\]$/g, "");
    let host: string;
    try { host = await resolveAddress(hostname, { timeoutMs: Math.min(timeoutMs, 5000) }); }
    catch { throw new IppDiagnosticError("name_resolution_failed"); }
    requestId = requestId % 0x7ffffffe + 1;
    const id = requestId;
    const body = encodeRequest(operation, id, groups, document);
    return new Promise<Reply>((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error, reply?: Reply) => {
        if (settled) return;
        settled = true; clearTimeout(timer);
        if (error) reject(error); else resolve(reply!);
      };
      const transport = url.protocol === "ipps:" ? https : http;
      const req = transport.request({
        hostname: host, servername: hostname, port: url.port || 631,
        path: url.pathname || "/ipp/print", method: "POST", agent: false,
        headers: { "Content-Type": "application/ipp", "Content-Length": body.length },
      }, res => {
        if (res.statusCode !== 200 ||
            res.headers["content-type"]?.split(";")[0].trim() !== "application/ipp") {
          res.destroy();
          finish(new Error("Printer returned a non-IPP HTTP response")); return;
        }
        const chunks: Buffer[] = []; let size = 0;
        res.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_REPLY_BYTES) {
            res.destroy(); finish(new Error("IPP response exceeds limit"));
          } else chunks.push(chunk);
        });
        res.on("error", () => finish(new Error("IPP response interrupted")));
        res.on("aborted", () => finish(new Error("IPP response interrupted")));
        res.on("end", () => {
          try { finish(undefined, decodeReply(Buffer.concat(chunks), id)); }
          catch { finish(new Error("Invalid IPP response")); }
        });
      });
      const timer = setTimeout(() => {
        req.destroy(); finish(new Error("IPP exchange timed out"));
      }, timeoutMs);
      req.on("error", (error: NodeJS.ErrnoException) => finish(new IppDiagnosticError(
        ["DEPTH_ZERO_SELF_SIGNED_CERT", "SELF_SIGNED_CERT_IN_CHAIN", "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
          "CERT_HAS_EXPIRED", "ERR_TLS_CERT_ALTNAME_INVALID", "UNABLE_TO_GET_ISSUER_CERT_LOCALLY"].includes(error.code ?? "")
          ? "certificate_rejected" : "connection_failed")));
      req.end(body);
    });
  };
}
