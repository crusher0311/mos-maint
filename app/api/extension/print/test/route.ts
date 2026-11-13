import { NextResponse } from "next/server";
import { extensionTest, ippCors } from "@/lib/print-queue/ipp-http";
import { withExtensionErrorMarker } from "@/lib/extension-route-wrapper";
// gate-exempt: guardExtensionShopRequest is applied in the shared IPP handler.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const OPTIONS = async () => new NextResponse(null, { status: 204, headers: ippCors });
export const POST = withExtensionErrorMarker(extensionTest);
