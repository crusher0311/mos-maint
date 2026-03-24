import twilio from "twilio";

let client: ReturnType<typeof twilio> | undefined;

export function getTwilioClient() {
  if (client) return client;

  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;

  if (!accountSid || !authToken) {
    throw new Error("Missing TWILIO_ACCOUNT_SID or TWILIO_AUTH_TOKEN");
  }

  client = twilio(accountSid, authToken);
  return client;
}

export function getTwilioConfig() {
  return {
    accountSid: process.env.TWILIO_ACCOUNT_SID || "",
    authToken: process.env.TWILIO_AUTH_TOKEN || "",
    apiKey: process.env.TWILIO_API_KEY || "",
    apiSecret: process.env.TWILIO_API_SECRET || "",
    twimlAppSid: process.env.TWILIO_TWIML_APP_SID || "",
    phoneNumber: process.env.TWILIO_PHONE_NUMBER || "",
    baseUrl: process.env.NEXT_PUBLIC_APP_URL
      ?? (process.env.REPLIT_DEV_DOMAIN ? `https://${process.env.REPLIT_DEV_DOMAIN}` : "http://localhost:5000"),
  };
}

export function validateTwilioSignature(
  url: string,
  params: Record<string, string>,
  signature: string
): boolean {
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  if (!authToken) return false;

  return twilio.validateRequest(authToken, signature, url, params);
}
