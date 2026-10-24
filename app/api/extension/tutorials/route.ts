// gate-exempt: personal help preferences do not unlock any shop feature.
import { NextRequest, NextResponse } from "next/server";
import { handleTutorialRequest, tutorialCors } from "@/lib/tutorial-route-handler";
import { withExtensionErrorMarker } from "@/lib/extension-route-wrapper";
export const GET = withExtensionErrorMarker((request: NextRequest) => handleTutorialRequest(request, true));
export const PUT = withExtensionErrorMarker((request: NextRequest) => handleTutorialRequest(request, true));
export const OPTIONS = () => new NextResponse(null, { status: 204, headers: tutorialCors });
