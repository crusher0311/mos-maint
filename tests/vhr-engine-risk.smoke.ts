/**
 * Regression smoke test for Task #176 / Task #195
 * (engine-aware oil warning chip + Safety Check — Oil Level row on the
 * printed Vehicle Health Report).
 *
 * Run: `npx tsx tests/vhr-engine-risk.smoke.ts`
 *
 * Mounts the real <VehicleHealthReport /> component into a jsdom DOM with
 * a fixture that has `engineRiskFlag: true` on the Oil & Filter row plus a
 * Safety Check — Oil Level row, and asserts:
 *   1. The "Engine flagged — long oil interval" chip renders in the
 *      Recommendations tab and carries the engineRiskReason on its
 *      `title` tooltip.
 *   2. The Safety Check — Oil Level row is surfaced (i.e. NOT silently
 *      filtered out by the complimentary-item heuristic) and lands in
 *      the Coming Up Soon bucket.
 *   3. After clicking the Plan tab, the engine-risk warning glyph also
 *      renders in the Plan tab with an `aria-label` of
 *      "Engine flagged — long oil interval" and a `title` carrying the
 *      engineRiskReason.
 *   4. The Safety Check — Oil Level row also appears in the Plan tab
 *      (NEXT 3 MO column) rather than the Additional Services strip.
 *   5. `isComplimentaryItem` directly returns false for the Safety Check
 *      — Oil Level fixture (defence-in-depth against the
 *      complimentary-keys / title-keyword filter quietly absorbing it).
 */

import { JSDOM } from "jsdom";

const dom = new JSDOM(
  "<!doctype html><html><body><div id='root'></div></body></html>",
  { url: "http://localhost/", pretendToBeVisual: true },
);

(globalThis as any).window = dom.window;
(globalThis as any).document = dom.window.document;
(globalThis as any).navigator = dom.window.navigator;
(globalThis as any).HTMLElement = dom.window.HTMLElement;
(globalThis as any).HTMLAnchorElement = dom.window.HTMLAnchorElement;
(globalThis as any).Element = dom.window.Element;
(globalThis as any).Node = dom.window.Node;
(globalThis as any).MouseEvent = dom.window.MouseEvent;
(globalThis as any).Event = dom.window.Event;
(globalThis as any).getComputedStyle = dom.window.getComputedStyle;
(dom.window as any).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import VehicleHealthReport, {
  isComplimentaryItem,
  type PlanItem,
  type VHIData,
} from "../components/vehicle-health-report/VehicleHealthReport";

const ENGINE_RISK_REASON =
  "Engine flagged for accelerated oil wear (long OEM oil interval).";
const ENGINE_RISK_CHIP_LABEL = "Engine flagged — long oil interval";
const SAFETY_CHECK_TITLE = "Safety Check — Oil Level";

const oilRow: PlanItem = {
  key: "oil_change",
  serviceKey: "oil_change",
  title: "Oil & Filter",
  category: "Engine",
  intervalMiles: 10000,
  intervalMonths: 12,
  last: { miles: 84900, date: "2025-11-02T00:00:00.000Z", source: "shop" },
  dueAtMiles: 94900,
  dueAtDate: "2026-11-02T00:00:00.000Z",
  milesToGo: -120,
  daysToGo: -3,
  bump: "red",
  source: "oem",
  dviSource: null,
  reason: null,
  usingShopInterval: false,
  declined: false,
  matchedDeferred: null,
  protractorDeferredId: null,
  engineRiskFlag: true,
  engineRiskReason: ENGINE_RISK_REASON,
};

const safetyCheckRow: PlanItem = {
  key: "safety_check_safety_check_oil_level",
  serviceKey: "safety_check_oil_level",
  title: SAFETY_CHECK_TITLE,
  category: "Shop Recommendation",
  intervalMiles: 3000,
  intervalMonths: null,
  last: { miles: 84900, date: "2025-11-02T00:00:00.000Z", source: "shop" },
  dueAtMiles: 87900,
  dueAtDate: null,
  milesToGo: 468,
  daysToGo: 22,
  bump: null,
  source: "common",
  dviSource: null,
  reason: "Engine flagged for shorter oil intervals. Recommended every 3,000 mi.",
  usingShopInterval: false,
  declined: false,
  matchedDeferred: null,
  protractorDeferredId: null,
  recommendedDefault: true,
  recommendedReason:
    "Auto-inserted by Detect Dog to verify oil level mid-interval.",
  engineRiskFlag: true,
  engineRiskReason: ENGINE_RISK_REASON,
};

const fixture: VHIData = {
  vehicle: {
    year: 2019,
    make: "Ram",
    model: "1500",
    engine: "3.6L V6 Pentastar",
  },
  vin: "1C6RR6FG7KS516181",
  currentMiles: 85020,
  customerName: "QA Pentastar",
  buckets: {
    overdue: [oilRow],
    dueSoon: [safetyCheckRow],
    upcoming: [],
  },
};

let failed = 0;
function ok(name: string, cond: boolean, detail?: string) {
  if (cond) {
    console.log(`  \u2713 ${name}`);
  } else {
    failed += 1;
    console.error(
      `  \u2717 ${name}${detail ? ` \u2014 ${detail}` : ""}`,
    );
  }
}

console.log("Vehicle Health Report — engine-risk regression (Task #176 / #195)");

// 0. Defence-in-depth: the complimentary-item filter must not absorb the
//    Safety Check — Oil Level row, otherwise the chip / row both vanish.
ok(
  "isComplimentaryItem(safetyCheckRow) === false",
  isComplimentaryItem(safetyCheckRow) === false,
  "Safety Check — Oil Level was misclassified as a complimentary item",
);
ok(
  "isComplimentaryItem(oilRow) === false",
  isComplimentaryItem(oilRow) === false,
);

const container = document.getElementById("root")!;
let root: Root | null = null;

act(() => {
  root = createRoot(container);
  root.render(
    React.createElement(VehicleHealthReport, {
      data: fixture,
      score: 72,
      shopName: "QA Shop",
      shopPhone: "(555) 555-0199",
    }),
  );
});

// 1. Recommendations tab assertions (default active tab).
const recsHtml = container.innerHTML;

ok(
  "Recommendations tab renders the engine-risk chip text",
  recsHtml.includes(ENGINE_RISK_CHIP_LABEL),
);

const recsChip = Array.from(container.querySelectorAll("span")).find(
  (el) => el.textContent?.includes(ENGINE_RISK_CHIP_LABEL),
);
ok(
  "Recommendations chip exists as a <span>",
  Boolean(recsChip),
);
ok(
  "Recommendations chip carries engineRiskReason on its title tooltip",
  recsChip?.getAttribute("title") === ENGINE_RISK_REASON,
  `title was: ${recsChip?.getAttribute("title") ?? "<missing>"}`,
);

function findSectionByHeading(
  rootEl: HTMLElement,
  selector: string,
  predicate: (text: string) => boolean,
): HTMLElement | null {
  const heading = Array.from(rootEl.querySelectorAll(selector)).find((el) =>
    predicate(el.textContent?.trim() ?? ""),
  ) as HTMLElement | undefined;
  if (!heading) return null;
  // Walk up to the containing section (the bordered band that wraps each
  // bucket on the Recommendations tab — `border-b border-gray-100`).
  let node: HTMLElement | null = heading;
  while (node && node !== rootEl) {
    if (
      node.classList?.contains("border-b") &&
      node.classList?.contains("border-gray-100")
    ) {
      return node;
    }
    node = node.parentElement;
  }
  return heading.parentElement as HTMLElement | null;
}

const comingUpSoonSection = findSectionByHeading(
  container,
  "h3",
  (t) => t.startsWith("Coming Up Soon"),
);
ok(
  "Recommendations tab has a 'Coming Up Soon' section",
  Boolean(comingUpSoonSection),
);
ok(
  "Safety Check — Oil Level h4 lives inside the Coming Up Soon section",
  Array.from(
    (comingUpSoonSection ?? container).querySelectorAll("h4"),
  ).some((h) => h.textContent?.trim() === SAFETY_CHECK_TITLE),
  "Safety Check — Oil Level h4 not found inside Coming Up Soon; complimentary filter or bucket routing may have moved/eaten it",
);

const additionalServicesSection = findSectionByHeading(
  container,
  "h3",
  (t) => t.startsWith("Additional Services"),
);
ok(
  "Safety Check — Oil Level row is NOT in the Recommendations Additional Services strip",
  additionalServicesSection
    ? !additionalServicesSection.textContent?.includes(SAFETY_CHECK_TITLE)
    : true,
);

// 2. Switch to the Plan tab and assert the chip + Safety Check row render
//    there too.
const planTabBtn = Array.from(container.querySelectorAll("button")).find(
  (b) => b.textContent?.trim() === "Plan",
);
ok("Plan tab button found", Boolean(planTabBtn));

act(() => {
  planTabBtn!.dispatchEvent(
    new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }),
  );
});

const planAriaChips = Array.from(
  container.querySelectorAll('[aria-label="Engine flagged — long oil interval"]'),
);
ok(
  "Plan tab renders engine-risk glyph with aria-label",
  planAriaChips.length > 0,
);
ok(
  "Plan tab engine-risk glyph carries engineRiskReason on its title tooltip",
  planAriaChips.some(
    (el) => el.getAttribute("title") === ENGINE_RISK_REASON,
  ),
  `Plan-tab title attrs: ${planAriaChips
    .map((el) => el.getAttribute("title"))
    .join(" | ") || "<none>"}`,
);

// Locate the NEXT 3 MO column — it's the column wrapper whose first child
// holds the "NEXT 3 MO" header span. Walk up from that span to the
// column root so we can scope subsequent assertions to it.
const next3MoHeader = Array.from(container.querySelectorAll("span")).find(
  (s) => s.textContent?.trim() === "NEXT 3 MO",
);
ok("Plan tab still mounts the NEXT 3 MO column header", Boolean(next3MoHeader));

const next3MoColumn = next3MoHeader?.parentElement?.parentElement ?? null;
ok(
  "NEXT 3 MO column resolves to a wrapper element",
  Boolean(next3MoColumn),
);
ok(
  "Safety Check — Oil Level row lives inside the NEXT 3 MO column",
  next3MoColumn
    ? Array.from(next3MoColumn.querySelectorAll("span")).some(
        (s) => s.textContent?.trim() === SAFETY_CHECK_TITLE,
      )
    : false,
  "Safety Check — Oil Level not found in NEXT 3 MO; bucket routing may have moved it to NOW or LATER",
);
ok(
  "Engine-risk glyph (with aria-label) lives inside the NEXT 3 MO column",
  next3MoColumn
    ? Array.from(
        next3MoColumn.querySelectorAll(
          '[aria-label="Engine flagged — long oil interval"]',
        ),
      ).length > 0
    : false,
);

// Plan tab: the optional "Additional Services" strip below the bucket grid
// must not be where the Safety Check — Oil Level row lands. The strip is
// rendered inside a div labelled "Additional Services" (a <p> not an <h3>).
const planAdditionalStrip = Array.from(container.querySelectorAll("p"))
  .filter((p) => p.textContent?.trim() === "Additional Services")
  .map((p) => p.parentElement)
  .find(Boolean) as HTMLElement | undefined;
ok(
  "Plan tab Additional Services strip (if rendered) does NOT contain the Safety Check — Oil Level row",
  planAdditionalStrip
    ? !planAdditionalStrip.textContent?.includes(SAFETY_CHECK_TITLE)
    : true,
);

// Tear down the React root cleanly so jsdom doesn't keep the event loop alive.
act(() => {
  root?.unmount();
});

if (failed === 0) {
  console.log("\nAll VHR engine-risk regression checks passed.");
  process.exit(0);
} else {
  console.error(`\n${failed} VHR engine-risk regression check(s) failed.`);
  process.exit(1);
}
