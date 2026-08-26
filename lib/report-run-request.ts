export function buildReportRunRequest(input: {
  selectedId?: string;
  selectedVersion?: number;
  persistedDefinition?: unknown;
  appliedDefinition: unknown;
  scope: unknown;
  force?: boolean;
}) {
  if (input.selectedId) {
    if (!input.persistedDefinition) {
      throw new Error("The saved report version is still loading.");
    }
    if (JSON.stringify(input.appliedDefinition) !== JSON.stringify(input.persistedDefinition)) {
      throw new Error("Save these changes as a new version before running the report.");
    }
    return {
      reportId: input.selectedId,
      reportVersion: input.selectedVersion,
      force: Boolean(input.force),
      refreshEnabled: true,
    };
  }
  return {
    definition: input.appliedDefinition,
    scope: input.scope,
    force: Boolean(input.force),
    refreshEnabled: false,
  };
}