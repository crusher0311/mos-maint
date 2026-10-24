"use client";

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { appearance, THEME_KEY, type Appearance } from "./theme-runtime";
import "./theme.css";

const ThemeContext = createContext<{
  preference: Appearance;
  resolved: "light" | "dark";
  setPreference: (value: Appearance) => void;
}>({ preference: "system", resolved: "light", setPreference: () => {} });

export function ThemeProvider({ children }: { children: ReactNode }) {
  // Identical server and hydration render; <head> has already set the palette.
  const [preference, setPreferenceState] = useState<Appearance>("system");
  const [resolved, setResolved] = useState<"light" | "dark">("light");
  const [ready, setReady] = useState(false);

  useEffect(() => {
    setPreferenceState(appearance(document.documentElement.dataset.appearance));
    setReady(true);
    const onStorage = (event: StorageEvent) => {
      if (event.key === THEME_KEY || event.key === null) {
        setPreferenceState(appearance(event.newValue));
      }
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  useEffect(() => {
    if (!ready) return;
    const media = typeof window.matchMedia === "function"
      ? window.matchMedia("(prefers-color-scheme: dark)") : null;
    const apply = () => {
      const next = preference === "system" ? (media?.matches ? "dark" : "light") : preference;
      document.documentElement.dataset.theme = next;
      document.documentElement.dataset.appearance = preference;
      setResolved(next);
    };
    apply();
    media?.addEventListener("change", apply);
    return () => media?.removeEventListener("change", apply);
  }, [preference, ready]);

  const setPreference = (next: Appearance) => {
    setPreferenceState(next);
    try { localStorage.setItem(THEME_KEY, next); } catch { /* Still works for this session. */ }
  };
  return <ThemeContext.Provider value={{ preference, resolved, setPreference }}>{children}</ThemeContext.Provider>;
}

export function AppearanceSelector() {
  const { preference, resolved, setPreference } = useContext(ThemeContext);
  return <label className="mos-appearance-control">
    <span>Appearance</span>
    <select aria-label="Appearance" value={preference} onChange={e => setPreference(appearance(e.target.value))}>
      <option value="light">Light</option>
      <option value="dark">Dark</option>
      <option value="system">System</option>
    </select>
    <span className="mos-appearance-resolved" aria-live="polite">
      {preference === "system" ? `Device: ${resolved}` : "This browser"}
    </span>
  </label>;
}

export function AppearanceBar() {
  return <div className="mos-appearance-bar" data-hide-print><AppearanceSelector /></div>;
}
