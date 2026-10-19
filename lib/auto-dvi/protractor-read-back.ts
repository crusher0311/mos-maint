/** Read-only evidence contract. A content match is NOT proof of UI display. */
export interface NativeInspectionPackage {
  ID: string;
  Chapter: string;
  ServicePackageHeader: { Title: string };
  ServicePackageInspectionLines: { ItemCollection: Array<{
    ID: string; Type: string; Title: string; Result: string; Notes: string;
    Header?: { DeletionTimeSpecified?: boolean };
  }> };
}

export interface InspectionReadBackScope {
  shopId: number;
  workOrderGuid: string;
}

export interface InspectionReadBackEvidence extends InspectionReadBackScope {
  workOrder: unknown;
  /** Separately captured shop setup, not inferred from the submitted Result. */
  ratingLabels?: { green: string; yellow: string; red: string };
}

export interface InspectionReadBackReport {
  readBackStatus: "matched" | "mismatched" | "unavailable";
  ratingLabelsStatus: "matched" | "mismatched" | "unverified";
  issues: Array<{ code: string; lineId?: string; field?: string }>;
}

const collection = (value: any): any[] | undefined =>
  Array.isArray(value) ? value : Array.isArray(value?.ItemCollection) ? value.ItemCollection : undefined;

export function compareInspectionReadBack(
  scope: InspectionReadBackScope,
  expected: NativeInspectionPackage,
  ratings: Array<"green" | "yellow" | "red" | null | undefined>,
  evidence: InspectionReadBackEvidence,
): InspectionReadBackReport {
  const unavailable = (code: string): InspectionReadBackReport => ({
    readBackStatus: "unavailable", ratingLabelsStatus: "unverified", issues: [{ code }],
  });
  // This contract submits exactly one package. Its ID and every line ID must
  // be nonempty and unique; repeated expected IDs cannot share saved evidence.
  const expectedLines = expected.ServicePackageInspectionLines.ItemCollection;
  if (!expected.ID || expectedLines.some(line => !line.ID || line.ID === expected.ID) ||
      new Set(expectedLines.map(line => line.ID)).size !== expectedLines.length) {
    return unavailable("invalid_submitted_ids");
  }
  const wo = evidence.workOrder as any;
  if (evidence.shopId !== scope.shopId || evidence.workOrderGuid !== scope.workOrderGuid ||
      wo?.ID !== scope.workOrderGuid) return unavailable("scope_mismatch");
  const packages = collection(wo.ServicePackages);
  if (!packages) return unavailable("invalid_snapshot");
  const issues: InspectionReadBackReport["issues"] = [];
  const matches = packages.filter(p => p?.ID === expected.ID);
  if (matches.length !== 1) {
    issues.push({ code: matches.length ? "duplicate_package_id" : "missing_package" });
  } else {
    const saved = matches[0];
    if (saved.Chapter !== expected.Chapter) issues.push({ code: "content_mismatch", field: "Chapter" });
    if (saved.ServicePackageHeader?.Title !== expected.ServicePackageHeader.Title)
      issues.push({ code: "content_mismatch", field: "packageTitle" });
    const lines = collection(saved.ServicePackageInspectionLines);
    if (!lines) return unavailable("invalid_lines");
    for (const line of expected.ServicePackageInspectionLines.ItemCollection) {
      const found = lines.filter(l => l?.ID === line.ID);
      const deleted = line.Header?.DeletionTimeSpecified === true;
      if (deleted && (found.length === 0 || (found.length === 1 &&
          found[0].Header?.DeletionTimeSpecified === true && found[0].Type === line.Type &&
          found[0].Title === "" && found[0].Result === "" && found[0].Notes === ""))) continue;
      if (found.length !== 1) {
        issues.push({ code: found.length ? "duplicate_line_id" : "missing_line", lineId: line.ID });
        continue;
      }
      if (deleted || found[0].Header?.DeletionTimeSpecified === true) {
        issues.push({ code: "deletion_mismatch", lineId: line.ID });
        continue;
      }
      for (const field of ["Type", "Title", "Result", "Notes"] as const) {
        if (found[0][field] !== line[field]) issues.push({ code: "content_mismatch", lineId: line.ID, field });
      }
    }
  }
  const contentMismatch = issues.length > 0;
  let ratingLabelsStatus: InspectionReadBackReport["ratingLabelsStatus"] = "unverified";
  if (evidence.ratingLabels && ["green", "yellow", "red"].every(
    key => typeof (evidence.ratingLabels as any)[key] === "string" && (evidence.ratingLabels as any)[key].trim(),
  )) {
    ratingLabelsStatus = "matched";
    for (const [index, rating] of ratings.entries()) {
      const line = expected.ServicePackageInspectionLines.ItemCollection[index];
      if (rating && line && line.Result !== evidence.ratingLabels![rating]) {
        ratingLabelsStatus = "mismatched";
        issues.push({ code: "rating_label_mismatch", lineId: line.ID, field: "Result" });
      }
    }
  }
  return { readBackStatus: contentMismatch || ratingLabelsStatus === "mismatched" ? "mismatched" : "matched",
    ratingLabelsStatus, issues };
}
