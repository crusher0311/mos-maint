// Render the real landing component and stylesheet without booting Next/auth/stores.
import http from "node:http";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import postcss from "postcss";
import tailwind from "@tailwindcss/postcss";

export async function createLandingFixture() {
  const [bundle, css] = await Promise.all([
    build({
      stdin: {
        contents: `import React from "react"; import {createRoot} from "react-dom/client";
          import LandingPage from "./app/LandingPage";
          createRoot(document.getElementById("root")).render(<LandingPage/>);`,
        resolveDir: process.cwd(), loader: "tsx",
      },
      bundle: true, write: false, jsx: "automatic", platform: "browser", format: "iife",
      define: { "process.env.NODE_ENV": '"production"', "process.env": "{}" },
    }),
    readFile("app/globals.css", "utf8").then(source =>
      postcss([tailwind()]).process(source, { from: "app/globals.css" })),
  ]);
  return http.createServer(async (req, res) => {
    const path = new URL(req.url!, "http://fixture.invalid").pathname;
    if (path === "/fixture.js") {
      res.setHeader("Content-Type", "text/javascript"); res.end(bundle.outputFiles[0].text);
    } else if (path === "/fixture.css") {
      res.setHeader("Content-Type", "text/css"); res.end(css.css);
    } else if (path === "/icon.png" || /^\/screenshots\/[\w-]+\.png$/.test(path)) {
      try { res.setHeader("Content-Type", "image/png"); res.end(await readFile(path === "/icon.png" ? "app/icon.png" : `public${path}`)); }
      catch { res.writeHead(404).end(); }
    } else if (path === "/") {
      res.setHeader("Content-Type", "text/html");
      res.end(`<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1">
        <link rel="stylesheet" href="/fixture.css"></head><body class="antialiased">
        <div id="root"></div><script src="/fixture.js"></script></body></html>`);
    } else if (path === "/login" || path === "/setup") {
      res.setHeader("Content-Type", "text/html"); res.end(`<h1>Offline destination: ${path}</h1>`);
    } else { res.writeHead(404).end(); }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  createLandingFixture().then(server => server.listen(5000, "0.0.0.0",
    () => console.log("Offline landing fixture ready on 5000")));
}
