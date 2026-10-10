import { createExternalEndpoint } from "@/lib/external-api/middleware";
import { externalCreateHold,externalReadHold,externalReleaseHold } from "@/lib/shop-dispatch/schedule-external";
export const runtime="nodejs";
export const dynamic="force-dynamic";
export const GET=createExternalEndpoint("workflow:holds",externalReadHold);
export const POST=createExternalEndpoint("workflow:holds",externalCreateHold);
export const DELETE=createExternalEndpoint("workflow:holds",externalReleaseHold);
