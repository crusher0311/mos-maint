/** Additive legacy-push contract. "acknowledged" is not a provider read-back.
 * No recovery is authorized by this response: that requires durable operation
 * identity, exact-ID reconciliation and provider-edit conflict checks. */
export interface DviPushOutcome {
  packageStatus: "acknowledged" | "uncertain";
  resultsStatus: "acknowledged" | "not_requested" | "uncertain";
  readBackStatus: "not_performed" | "matched" | "mismatched" | "unavailable";
  ratingLabelsStatus?: "matched" | "mismatched" | "unverified";
  readBackIssues?: Array<{ code: string; lineId?: string; field?: string }>;
}

export const DVI_PUSH_UNCERTAIN_MESSAGE =
  "The write could not be confirmed. Check this work order in Protractor before writing again; it may already contain the package or findings. Contact support if verification is needed. Do not resend the inspection.";

export function publicDviPushOutcome(outcome: DviPushOutcome, receiptRecorded = true) {
  const complete = outcome.packageStatus === "acknowledged" &&
    outcome.resultsStatus !== "uncertain" &&
    !["mismatched", "unavailable"].includes(outcome.readBackStatus) &&
    outcome.ratingLabelsStatus !== "unverified";
  const message = outcome.packageStatus === "uncertain"
    ? DVI_PUSH_UNCERTAIN_MESSAGE
    : outcome.resultsStatus === "uncertain"
      ? "The inspection package was saved, but its findings in Protractor's inspection view could not be confirmed. Check that view on this work order and contact support if findings are missing. Do not resend the inspection."
      : ["mismatched", "unavailable"].includes(outcome.readBackStatus) || outcome.ratingLabelsStatus === "unverified"
        ? "Protractor acknowledged the findings, but their saved content or configured rating labels could not be verified. Check the inspection view and contact support. Do not resend the inspection."
      : !receiptRecorded
        ? "Protractor acknowledged the inspection write, but MOS could not save its local activity record. Check the work order before any further write. Do not resend the inspection."
        : undefined;
  return {
    ...outcome,
    outcome: !receiptRecorded || outcome.packageStatus === "uncertain"
      ? "uncertain" as const : complete ? "complete" as const : "partial" as const,
    localReceiptStatus: receiptRecorded ? "recorded" as const : "unconfirmed" as const,
    recoveryAllowed: false,
    ...(message ? { message } : {}),
  };
}
