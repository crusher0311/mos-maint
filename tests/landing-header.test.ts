import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import type { AddressInfo } from "node:net";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import { build } from "esbuild";
import puppeteer from "puppeteer-core";
import chromium from "@sparticuz/chromium";
import { createLandingFixture } from "./browser/landing-fixture-server";

test("homepage preserves signed-out rendering and signed-in redirect without stores", async () => {
  const bundle = await build({
    entryPoints: ["app/page.tsx"], bundle: true, write: false, platform: "node",
    format: "cjs", jsx: "automatic", packages: "external",
    plugins: [{
      name: "offline-home-boundaries",
      setup(b) {
        b.onResolve({ filter: /^(@\/lib\/auth|next\/navigation|\.\/LandingPage)$/ },
          args => ({ path: args.path, namespace: "offline" }));
        b.onLoad({ filter: /.*/, namespace: "offline" }, args => ({
          contents: args.path === "@/lib/auth"
            ? "export async function getSession(){ return globalThis.fixtureSession; }"
            : args.path === "next/navigation"
              ? "export function redirect(path){throw new Error('REDIRECT:'+path)}"
              : "export default function LandingPage(){}",
        }));
      },
    }],
  });
  for (const session of [null, { id: "offline-user" }]) {
    const module = { exports: {} as { default: () => Promise<any> } };
    runInNewContext(bundle.outputFiles[0].text, {
      module, exports: module.exports, require: createRequire(import.meta.url), fixtureSession: session,
    });
    if (session) await assert.rejects(module.exports.default(), /REDIRECT:\/dashboard/);
    else assert.equal((await module.exports.default()).type.name, "LandingPage");
  }
});

test("header links fit phones and desktop, provide touch targets, and navigate", { timeout: 120000 }, async () => {
  const server = await createLandingFixture();
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  let browser;
  try {
    let executablePath;
    try { executablePath = execFileSync("which", ["chromium"], { encoding: "utf8" }).trim(); }
    catch { executablePath = await chromium.executablePath(); }
    browser = await puppeteer.launch({
      executablePath, headless: true,
      args: [...chromium.args, "--disable-quic",
        "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1"],
    });
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(String(error)));
    await page.setRequestInterception(true);
    page.on("request", req => {
      if (req.url().startsWith(`${origin}/`)) void req.continue();
      else { errors.push(`Unexpected request: ${req.url()}`); void req.abort(); }
    });
    for (const width of [320, 375, 390, 640, 1280]) {
      await page.setViewport({ width, height: 900, hasTouch: width < 640, isMobile: width < 640 });
      await page.goto(origin, { waitUntil: "networkidle0" });
      await page.waitForSelector('header a[href="/login"]', { visible: true, timeout: 5000 })
        .catch(error => { throw new Error(`${error}\nBrowser errors: ${errors.join("\n")}`); });
      assert.ok(await page.$eval("header img", img => (img as HTMLImageElement).naturalWidth > 0));
      const dimensions = await page.$eval("header", header => {
        const brand = header.querySelector("img")!.parentElement!;
        const links = Array.from(header.querySelectorAll("a"));
        return {
          viewport: innerWidth, scroll: document.documentElement.scrollWidth,
          boxes: [brand, ...links].map(el => {
            const r = el.getBoundingClientRect();
            return { left: r.left, right: r.right, width: r.width, height: r.height };
          }),
          labels: links.map(el => el.textContent!.trim()),
          hrefs: links.map(el => el.getAttribute("href")),
          loginFont: getComputedStyle(links[0]).fontSize,
          loginPadding: getComputedStyle(links[0]).paddingLeft,
        };
      });
      assert.deepEqual(dimensions.labels, ["Sign In", "Get Started"]);
      assert.deepEqual(dimensions.hrefs, ["/login", "/setup"]);
      assert.equal(dimensions.viewport, width);
      assert.ok(dimensions.scroll <= width, `page overflow at ${width}`);
      dimensions.boxes.forEach((box, i, boxes) => {
        assert.ok(box.left >= 0 && box.right <= width, `clipped at ${width}`);
        if (i > 0) {
          assert.ok(box.left >= boxes[i - 1].right, `overlap at ${width}`);
          if (width < 640) assert.ok(box.width >= 44 && box.height >= 44, `touch target at ${width}`);
        }
      });
      if (width >= 640) {
        assert.equal(dimensions.loginFont, "16px");
        assert.equal(dimensions.loginPadding, "16px");
      }
      await Promise.all([
        page.waitForNavigation(),
        width < 640 ? page.tap('header a[href="/login"]') : page.click('header a[href="/login"]'),
      ]);
      assert.equal(new URL(page.url()).pathname, "/login");
    }
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
