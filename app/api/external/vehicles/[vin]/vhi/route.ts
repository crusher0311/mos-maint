import { createExternalEndpoint } from "@/lib/external-api/middleware";
import { buildPartnerVhiResponse } from "@/lib/external-api/partner-vhi-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = createExternalEndpoint(
  "vehicles:read",
  (req, context) => buildPartnerVhiResponse(req, context),
);
