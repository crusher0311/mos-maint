import { NextRequest, NextResponse } from "next/server";
import { extensionDestinations, ippCors } from "@/lib/print-queue/ipp-http";
import { withExtensionErrorMarker } from "@/lib/extension-route-wrapper";
// gate-exempt: guardExtensionShopRequest is applied in the shared IPP handler.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const OPTIONS = async () => new NextResponse(null, { status: 204, headers: ippCors });
export const GET = withExtensionErrorMarker((req: NextRequest) => extensionDestinations(req));
export const PUT = withExtensionErrorMarker((req: NextRequest) => extensionDestinations(req));
