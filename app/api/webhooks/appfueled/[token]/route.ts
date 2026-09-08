import { handleAppFueledUrlWebhook } from "@/lib/appfueled-url-webhook";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 10;

export async function POST(req: Request, { params }: { params: { token: string } }) {
  return handleAppFueledUrlWebhook(req, params.token);
}