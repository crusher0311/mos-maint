import { createExternalEndpoint } from "@/lib/external-api/middleware";
import { externalAvailability } from "@/lib/shop-dispatch/schedule-external";
export const runtime="nodejs";
export const dynamic="force-dynamic";
export const GET=createExternalEndpoint("workflow:availability",externalAvailability);
