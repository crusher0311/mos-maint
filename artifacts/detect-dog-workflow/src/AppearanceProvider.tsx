import { createContext, useContext, useLayoutEffect, useMemo, useState, type ReactNode } from 'react';
import { APPEARANCE_KEY, SYSTEM_QUERY, applyAppearance, parseAppearance, persistAppearance, readAppearance, resolveAppearance, systemAppearance, type Appearance, type ResolvedAppearance } from './appearance';

type AppearanceContextValue = {
  preference: Appearance;
  resolved: ResolvedAppearance;
  setPreference: (value: Appearance) => void;
};
const AppearanceContext = createContext<AppearanceContextValue | null>(null);

export function AppearanceProvider({ children }: { children: ReactNode }) {
  const [preference, setPreferenceState] = useState<Appearance>(readAppearance);
  const [systemDark, setSystemDark] = useState(systemAppearance);
  const resolved = resolveAppearance(preference, systemDark);

  useLayoutEffect(() => { applyAppearance(resolved); }, [resolved]);
  useLayoutEffect(() => {
    let media: MediaQueryList | undefined;
    const onChange = () => setSystemDark(media?.matches ?? false);
    try {
      media = window.matchMedia(SYSTEM_QUERY);
      onChange();
      if (media.addEventListener) media.addEventListener('change', onChange);
      else media.addListener(onChange);
    } catch { /* No matchMedia support: System stays light. */ }
    const onStorage = (event: StorageEvent) => {
      if (event.key === APPEARANCE_KEY || event.key === null) {
        setPreferenceState(event.key === null ? 'system' : parseAppearance(event.newValue));
      }
    };
    window.addEventListener('storage', onStorage);
    return () => {
      if (media?.removeEventListener) media.removeEventListener('change', onChange);
      else media?.removeListener(onChange);
      window.removeEventListener('storage', onStorage);
    };
  }, []);

  const value = useMemo(() => ({
    preference, resolved,
    setPreference: (next: Appearance) => {
      const safe = parseAppearance(next);
      persistAppearance(safe);
      setPreferenceState(safe);
    },
  }), [preference, resolved]);
  return <AppearanceContext.Provider value={value}>{children}</AppearanceContext.Provider>;
}

export function useAppearance() {
  const value = useContext(AppearanceContext);
  if (!value) throw new Error('AppearanceProvider must wrap the workflow preview.');
  return value;
}
