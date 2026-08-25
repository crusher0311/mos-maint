import { createHmac, timingSafeEqual } from "node:crypto";

export type PlanBuildMileageSource =
  | "actual"
  | "estimated_carfax"
  | "estimated_annual";

export interface PlanBuildMileageMetadata {
  mileageSource: PlanBuildMileageSource;
  mileageEstimateDetails: Record<string, unknown> | null;
}

export interface PlanBuildMileageSignatureContext {
  shopId: number;
  vin: string;
  mileage: number;
}

const ESTIMATED_SOURCES = new Set<PlanBuildMileageSource>([
  "estimated_carfax",
  "estimated_annual",
]);

export function appendPlanBuildMileageMetadata(
  params: URLSearchParams,
  metadata?: PlanBuildMileageMetadata,
): void {
  if (!metadata) return;
  params.set("mileageSource", metadata.mileageSource);
  if (
    metadata.mileageSource !== "actual" &&
    metadata.mileageEstimateDetails
  ) {
    params.set(
      "mileageEstimateDetails",
      JSON.stringify(metadata.mileageEstimateDetails),
    );
  }
}

function signaturePayload(
  params: Pick<URLSearchParams, "get">,
  context: PlanBuildMileageSignatureContext,
): string {
  return JSON.stringify([
    String(context.shopId),
    context.vin.toUpperCase(),
    String(context.mileage),
    params.get("mileageSource") ?? "",
    params.get("mileageEstimateDetails") ?? "",
  ]);
}

export function signPlanBuildMileageMetadata(
  params: Pick<URLSearchParams, "get">,
  context: PlanBuildMileageSignatureContext,
  secret: string,
): string {
  return createHmac("sha256", secret)
    .update(signaturePayload(params, context))
    .digest("hex");
}

export function verifyPlanBuildMileageMetadataSignature(
  signature: string | null,
  params: Pick<URLSearchParams, "get">,
  context: PlanBuildMileageSignatureContext,
  secret: string | undefined,
): boolean {
  if (!signature || !secret || !/^[a-f0-9]{64}$/i.test(signature)) return false;
  const expected = signPlanBuildMileageMetadata(params, context, secret);
  return timingSafeEqual(
    Buffer.from(signature, "hex"),
    Buffer.from(expected, "hex"),
  );
}

/**
 * Only trusted internal callers may label a plan's mileage as estimated.
 * Browser/session requests always default to actual mileage.
 */
export function readPlanBuildMileageMetadata(
  params: Pick<URLSearchParams, "get">,
  trustedInternalRequest: boolean,
): PlanBuildMileageMetadata {
  const source = params.get("mileageSource") as PlanBuildMileageSource | null;
  if (!trustedInternalRequest || !source || !ESTIMATED_SOURCES.has(source)) {
    return { mileageSource: "actual", mileageEstimateDetails: null };
  }

  const rawDetails = params.get("mileageEstimateDetails");
  if (!rawDetails) {
    return { mileageSource: source, mileageEstimateDetails: null };
  }

  try {
    const parsed = JSON.parse(rawDetails);
    return {
      mileageSource: source,
      mileageEstimateDetails:
        parsed && typeof parsed === "object" && !Array.isArray(parsed)
          ? parsed
          : null,
    };
  } catch {
    return { mileageSource: source, mileageEstimateDetails: null };
  }
}