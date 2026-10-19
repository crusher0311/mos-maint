import { createHash, createHmac, timingSafeEqual, randomBytes } from "node:crypto";
import { z } from "zod";
import { requireThat } from "../../shop-dispatch/model";
const payloadSchema = z.object({shopId: z.number().int().positive(), visitId: z.string().min(1).max(100),
  id: z.string().regex(/^[a-f0-9]{64}$/)}).strict();
export type LinkScope = z.infer<typeof payloadSchema>;
export const tokenHash = (token: string) => createHash("sha256").update(token).digest("hex");
export const linkId = () => randomBytes(32).toString("hex");
export function encodeLink(scope: LinkScope, secret: string) {
  requireThat(secret.length >= 32, "Report link signing is not provisioned", 503);
  const payload = Buffer.from(JSON.stringify(payloadSchema.parse(scope))).toString("base64url");
  const signature = createHmac("sha256", secret).update(`workflow-findings-v1:${payload}`).digest("base64url");
  return `${payload}.${signature}`;
}
export function decodeLink(token: string, secret: string): LinkScope {
  requireThat(secret.length >= 32 && token.length <= 600, "Report unavailable", 404);
  const [payload, signature, extra] = token.split(".");
  requireThat(payload && signature && !extra, "Report unavailable", 404);
  const expected = createHmac("sha256", secret).update(`workflow-findings-v1:${payload}`).digest();
  const supplied = Buffer.from(signature, "base64url");
  requireThat(supplied.length === expected.length && timingSafeEqual(supplied, expected), "Report unavailable", 404);
  return payloadSchema.parse(JSON.parse(Buffer.from(payload, "base64url").toString("utf8")));
}
