import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";

for (const entry of [
  "app/api/analyze/route.ts",
  "app/api/recommended/analyze/route-handler.ts",
  "app/api/recommended/analyze-stream/route.ts",
]) test(`${entry} rejects caller models without upstream work`, async () => {
  const dir = await mkdtemp(join(tmpdir(), "ai-model-route-"));
  const text = await readFile(entry, "utf8");
  const exports = new Map<string, string[]>();
  for (const m of text.matchAll(/import\s*\{([^}]+)\}\s*from\s*["']([^"']+)["']/g))
    exports.set(m[2], m[1].split(",").map(s => s.trim().split(/\s+as\s+/)[0]).filter(Boolean));
  try {
    const result = await build({ entryPoints: [entry], bundle: true, write: false, platform: "node", format: "esm",
      plugins: [{ name: "offline", setup(b) {
        b.onResolve({ filter: /^(next\/server|@\/lib\/)/ }, a =>
          a.path.endsWith("/openai-model-policy") ? undefined : ({ path: a.path, namespace: "fake" }));
        b.onLoad({ filter: /.*/, namespace: "fake" }, a => ({
          loader: "js", contents: a.path === "next/server"
            ? `export const NextResponse={json:(body,init)=>new Response(JSON.stringify(body),{...init,headers:{"content-type":"application/json"}})}`
            : (exports.get(a.path) ?? []).map(name => {
              const body = ["getSession", "requireSession"].includes(name) ? "return {shopId:1}" :
                name === "getFeatureEntitlements" ? "return {}" :
                name === "canAccessShopFeature" ? "return true" :
                'throw new Error("Unexpected upstream operation")';
              return `export const ${name}=()=>{${body}};`;
            }).join("\n"),
        }));
      } }],
    });
    const file = join(dir, "route.mjs");
    await writeFile(file, result.outputFiles[0].text);
    const { POST } = await import(pathToFileURL(file).href);
    for (const model of ["gpt-5.4", "gpt-4.1-turbo", {}, 9, "gpt-4o?secret"]) {
      const response = await POST(new Request("https://offline.test", {
        method: "POST", body: JSON.stringify({ model, shopId: 1, vin: "offline" }),
      }));
      assert.equal(response.status, 400);
      assert.match((await response.json()).error, /Unsupported AI model/);
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});
