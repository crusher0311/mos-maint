export const APPEARANCE_KEY = 'mos-workflow-appearance';
export const SYSTEM_QUERY = '(prefers-color-scheme: dark)';
export type Appearance = 'light' | 'dark' | 'system';
export type ResolvedAppearance = Exclude<Appearance, 'system'>;

export function parseAppearance(value: unknown): Appearance {
  return value === 'light' || value === 'dark' || value === 'system' ? value : 'system';
}

/** Access storage lazily: even the localStorage getter can throw in private contexts. */
export function readAppearance(): Appearance {
  try { return parseAppearance(window.localStorage.getItem(APPEARANCE_KEY)); }
  catch { return 'system'; }
}

export function persistAppearance(value: Appearance): void {
  try { window.localStorage.setItem(APPEARANCE_KEY, value); }
  catch { /* The in-memory choice still works for the current page. */ }
}

export function resolveAppearance(preference: Appearance, systemDark: boolean): ResolvedAppearance {
  return preference === 'system' ? (systemDark ? 'dark' : 'light') : preference;
}

export function systemAppearance(): boolean {
  try { return window.matchMedia(SYSTEM_QUERY).matches; }
  catch { return false; }
}

export function applyAppearance(resolved: ResolvedAppearance): void {
  const root = document.documentElement;
  root.dataset.workflowTheme = resolved;
  root.style.colorScheme = resolved;
  root.style.backgroundColor = resolved === 'dark' ? '#17221e' : '#f1f2e9';
}
