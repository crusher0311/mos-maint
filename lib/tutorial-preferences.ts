/** Stable, bounded personal choices. These keys do not change with releases. */
export const TUTORIAL_IDS = ["vhi", "jobs", "printing"] as const;
export type TutorialId = typeof TUTORIAL_IDS[number];
export type TutorialAction = { action: "notice" } | { action: "dismiss" | "complete"; guide: TutorialId };
export function parseTutorialAction(value: unknown): TutorialAction | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (v.action === "notice" && Object.keys(v).length === 1) return { action: "notice" };
  if ((v.action === "dismiss" || v.action === "complete") &&
      Object.keys(v).length === 2 && TUTORIAL_IDS.includes(v.guide as TutorialId)) {
    return { action: v.action, guide: v.guide as TutorialId };
  }
  return null;
}
export function tutorialPreferenceKey(action: TutorialAction): string {
  return action.action === "notice" ? "noticeSeen" : `${action.action}_${action.guide}`;
}
export function tutorialState(value: unknown) {
  const v = value && typeof value === "object" ? value as Record<string, unknown> : {};
  return {
    noticeSeen: v.noticeSeen === true,
    dismissed: TUTORIAL_IDS.filter(id => v[`dismiss_${id}`] === true),
    completed: TUTORIAL_IDS.filter(id => v[`complete_${id}`] === true),
  };
}
