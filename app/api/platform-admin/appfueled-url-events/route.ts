import { handleAppFueledUrlAdmin } from "@/lib/appfueled-url-admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  return handleAppFueledUrlAdmin(req);
}
export async function POST(req: Request) {
  return handleAppFueledUrlAdmin(req);
}
export async function PATCH(req: Request) {
  return handleAppFueledUrlAdmin(req);
}