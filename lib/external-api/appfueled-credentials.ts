import { createCipheriv, createHash, randomBytes } from "crypto";

export class AppFueledInputError extends Error {}

export function parseConnectionShopId(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0 || value > 2147483647)
    throw new AppFueledInputError("shopId must be a positive MOS shop ID");
  return value;
}

export function connectionDigest(value: string) {
  return createHash("sha256").update(`appfueled-connection-v1:${value}`).digest("hex");
}

export function parseCredentials(body: any) {
  const shopId = parseConnectionShopId(body?.shopId);
  for (const field of ["apiKey", "apiSecret", "connectionId"]) {
    if (typeof body?.[field] !== "string" || !body[field].trim() ||
        body[field].length > 2048 || /[\u0000-\u0020\u007f]/.test(body[field]))
      throw new AppFueledInputError("Provide all three credentials without whitespace (maximum 2048 characters each)");
  }
  return { shopId, apiKey: body.apiKey as string, apiSecret: body.apiSecret as string, connectionId: body.connectionId as string };
}

// Dedicated key, no fallback to session/API secrets. Versioned authenticated
// encryption binds ciphertext to this shop so copying rows cannot change scope.
export function encryptCredentials(input: ReturnType<typeof parseCredentials>, keyHex: string | undefined) {
  if (!keyHex || !/^[a-fA-F0-9]{64}$/.test(keyHex)) throw new Error("Credential encryption unavailable");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", Buffer.from(keyHex, "hex"), iv);
  cipher.setAAD(Buffer.from(`appfueled:v1:${input.shopId}`));
  const encrypted = Buffer.concat([cipher.update(JSON.stringify({
    apiKey: input.apiKey, apiSecret: input.apiSecret,
  }), "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64"), cipher.getAuthTag().toString("base64"), encrypted.toString("base64")].join(".");
}
