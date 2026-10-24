import { defineConfig } from "../../artifacts/detect-dog-workflow/node_modules/vite/dist/node/index.js";
import tailwind from "@tailwindcss/postcss";
import path from "node:path";
import { readFileSync } from "node:fs";
const root = process.cwd();
const source = readFileSync(path.join(root, "components/theme/theme-runtime.ts"), "utf8");
const bootstrap = source.match(/themeBootstrap = `([\s\S]*?)`;/)[1].replace("${THEME_KEY}", "mos-website-appearance");
export default defineConfig({
  plugins: [{ name: "ssr-theme-head", configureServer(server) {
    server.middlewares.use("/icon.png", (_req, res) => {
      res.setHeader("Content-Type", "image/png");
      res.end(readFileSync(path.join(root, "app/icon.png")));
    });
  }, transformIndexHtml(html) {
    return html.replace("<head>", `<head><script>${bootstrap}</script>`);
  } }],
  root: path.join(root, "tests/theme-browser"),
  publicDir: path.join(root, "public"),
  resolve: { alias: [
    { find: "next/link", replacement: path.join(root, "tests/theme-browser/next-shim.tsx") },
    { find: "next/image", replacement: path.join(root, "tests/theme-browser/next-shim.tsx") },
    { find: "next/navigation", replacement: path.join(root, "tests/theme-browser/next-shim.tsx") },
    { find: "@", replacement: root },
  ] },
  esbuild: { jsx: "automatic" },
  css: { postcss: { plugins: [tailwind()] } },
  server: { host: "0.0.0.0", port: 24101, strictPort: true, allowedHosts: true, fs: { allow: [root] } },
});
