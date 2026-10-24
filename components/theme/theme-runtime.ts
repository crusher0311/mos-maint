/** Browser-only preference, deliberately independent from shop/account settings. */
export const THEME_KEY = "mos-website-appearance";
export type Appearance = "light" | "dark" | "system";
export function appearance(value: unknown): Appearance {
  return value === "light" || value === "dark" ? value : "system";
}

// Kept dependency-free so the exact initializer can run in <head> before paint.
export const themeBootstrap = `(function(){var p="system";try{var v=localStorage.getItem("${THEME_KEY}");if(v==="light"||v==="dark")p=v}catch(e){}var dark=false;try{dark=matchMedia("(prefers-color-scheme: dark)").matches}catch(e){}document.documentElement.dataset.theme=p==="system"?(dark?"dark":"light"):p;document.documentElement.dataset.appearance=p;})();`;
