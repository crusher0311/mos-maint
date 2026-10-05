import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { DviEngagementDetail } from "../app/dashboard/reports/missed-opportunities/dvi-engagement-detail";
import { engagementFromTekmetric } from "../lib/dvi-engagement";

(globalThis as any).React = React;
const engagement = engagementFromTekmetric({
  workOrderId: "1", inspectionShareDate: "2026-10-02T18:00:00Z",
  dviInspectionViewReceivedAt: "2026-10-02T18:26:30Z",
});
const html = renderToStaticMarkup(<DviEngagementDetail engagement={engagement} />);
assert(html.includes(">Sent<") && html.includes(">Viewed<"));
assert(html.includes("Event received:") && html.includes("Tekmetric API"));
assert(html.includes('dateTime='));
const unknown = renderToStaticMarkup(<DviEngagementDetail />);
assert.equal((unknown.match(/>Unknown</g) || []).length, 2);
assert(unknown.includes("Missing tracking is not evidence of a missed advisor action"));
const other = renderToStaticMarkup(<DviEngagementDetail engagement={{
  sent: { status: "negative", source: "Authoritative test source", context: "Explicit negative" },
  viewed: { status: "unsupported", source: "Verified test contract", context: "Unsupported" },
}} />);
assert(other.includes(">Not sent<") && other.includes(">Not tracked<"));

// Optional visual fixture uses the real compiled app CSS, with synthetic evidence
// only. No authentication bypass or fixture route is added to the application.
async function visual() {
  const puppeteer = (await import("puppeteer")).default;
  const browser = await puppeteer.launch({ executablePath: process.env.CHROMIUM_PATH || "/usr/bin/chromium",
    headless: true, args: ["--no-sandbox"] });
  try {
    const page = await browser.newPage();
    await page.goto("http://127.0.0.1:5000/dashboard/reports/missed-opportunities", { waitUntil: "domcontentloaded" });
    const css = await page.evaluate(() => [...document.querySelectorAll('link[rel="stylesheet"]')].map(l => (l as HTMLLinkElement).href));
    await page.goto("about:blank");
    for (const width of [1100, 390]) {
      await page.setViewport({ width, height: 900 });
      await page.setContent(`<html><head>${css.map(url => `<link rel="stylesheet" href="${url}">`).join("")}</head><body style="background:#f8fafc;padding:16px"><h2>Expanded repair order · visual test fixture</h2>${html}${unknown}${other}</body></html>`, { waitUntil: "networkidle0" });
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "engagement overflows viewport");
      await page.screenshot({ path: `/tmp/dvi-engagement-${width}.png`, fullPage: true });
    }
  } finally { await browser.close(); }
}
(process.env.DVI_VISUAL_TEST === "1" ? visual() : Promise.resolve())
  .then(() => console.log("DVI engagement UI checks passed"))
  .catch(err => { console.error(err); process.exit(1); });
