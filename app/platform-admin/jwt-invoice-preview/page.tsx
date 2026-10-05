import { requirePlatformAdmin } from "@/lib/auth";
import JwtInvoicePreviewClient from "./JwtInvoicePreviewClient";

export const dynamic = "force-dynamic";

export default async function JwtInvoicePreviewPage() {
  await requirePlatformAdmin();
  return <JwtInvoicePreviewClient />;
}
