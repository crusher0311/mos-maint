import crypto from "crypto";

export function verifyAutoflowSignature(rawBody: string, signature: string, secret: string): boolean {
  if (!secret) return true; // if no secret configured, accept (not recommended)
  if (!signature) return false;
  try {
    const h = crypto.createHmac("sha256", secret).update(rawBody, "utf8").digest("hex");
    return crypto.timingSafeEqual(Buffer.from(h), Buffer.from(signature));
  } catch {
    return false;
  }
}

type IncomingCustomer = {
  id?: string | number;
  shopId?: number | string;
  firstName?: string;
  lastName?: string;
  name?: string;
  email?: string;
  phone?: string;
};

export function toCustomerDoc(payload: any) {
  // Adapt these paths to match AutoFlow’s exact JSON
  const data: IncomingCustomer =
    payload?.data?.customer ||
    payload?.customer ||
    payload?.data ||
    {};

  const shopIdRaw = data.shopId ?? payload?.shopId ?? payload?.data?.shopId;
  const shopId = Number(shopIdRaw);
  if (!Number.isFinite(shopId)) return null;

  const externalIdRaw = data.id ?? payload?.data?.id ?? payload?.id;

  const first = (data.firstName || "").toString().trim();
  const last  = (data.lastName || "").toString().trim();
  const name  = (data.name || `${first} ${last}`.trim()).trim() || null;

  const email = normalizeEmail(data.email);
  const phone = normalizePhone(data.phone);
  const externalId = externalIdRaw != null ? String(externalIdRaw) : null;

  return { shopId, name, email, phone, externalId };
}

function normalizePhone(s?: string | null): string | null {
  if (!s) return null;
  const digits = String(s).replace(/\D/g, "");
  return digits || null;
}

function normalizeEmail(s?: string | null): string | null {
  if (!s) return null;
  const t = String(s).trim().toLowerCase();
  return t || null;
}

