import { NextRequest } from "next/server";
import { handleTutorialRequest } from "@/lib/tutorial-route-handler";
export const dynamic = "force-dynamic";
export const GET = (request: NextRequest) => handleTutorialRequest(request, false);
export const PUT = (request: NextRequest) => handleTutorialRequest(request, false);
