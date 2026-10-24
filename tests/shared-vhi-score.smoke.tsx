import assert from "node:assert/strict";
import React, { act } from "react";
import { JSDOM } from "jsdom";
import { createRoot } from "react-dom/client";
import VehicleHealthReport, { computeScore, type VHIData } from "../components/vehicle-health-report/VehicleHealthReport";
import ScoreSimulator from "../components/vehicle-health-report/ScoreSimulator";
import { base } from "./fixtures/shared-vhi-score";

const dom = new JSDOM("<div id='root'></div>", { url: "http://localhost/" });
Object.assign(globalThis, { window: dom.window, document: dom.window.document, React, IS_REACT_ACT_ENVIRONMENT: true });
const container = document.getElementById("root")!;
const root = createRoot(container);
function render(data: VHIData, score = computeScore(data), standalone = false) {
  act(() => root.render(standalone
    ? <ScoreSimulator data={data} currentScore={score} />
    : <VehicleHealthReport data={data} score={score} />));
}
function click(label: string) {
  const button = [...container.querySelectorAll("button")].find(b => b.textContent?.trim() === label);
  assert(button, `button ${label} exists`);
  act(() => button.click());
}
function unavailable() {
  assert.match(container.textContent!, /reliable score and repair projection are unavailable/i);
  assert.doesNotMatch(container.textContent!, /After Repair|point.*improvement|Score moves to|Excellent|Good Condition|Needs Attention|Poor Condition|Critical/);
  assert.equal(container.querySelectorAll("svg text").length, 0);
  assert(![...container.querySelectorAll("button")].some(b => /Select All|Clear|Engine Oil Change/.test(b.textContent!)));
}
const insufficient = { ...base, dataQuality: { sufficient: false } };
render(insufficient);
assert.match(container.textContent!, /Insufficient Service History/);
assert.match(container.textContent!, /Engine Oil Change/);
click("Improve My Score");
{
  unavailable();
  click("Recommendations");
  assert.match(container.textContent!, /Engine Oil Change/);
  click("Plan");
  click("Improve My Score");
  unavailable();
  for (const quality of [{ sufficient: true }, undefined, null]) {
    act(() => root.render(null));
    const data = { ...base, dataQuality: quality };
    render(data);
    assert.equal(container.querySelector("svg text")?.textContent, String(computeScore(data)));
    click("Improve My Score");
    click("Select All");
    assert.match(container.textContent!, /After Repair100/);
    assert.match(container.textContent!, new RegExp(`\\+${100 - computeScore(data)} points improvement`));
    click("Clear");
    assert.doesNotMatch(container.textContent!, /After Repair/);
    click("Engine Oil ChangeOverdue");
    render(insufficient);
    unavailable();
    render(data);
    assert.doesNotMatch(container.textContent!, /After Repair/);
  }
  render(base, 0);
  assert.equal(container.querySelector("svg text")?.textContent, "0");
  click("Select All");
  assert.match(container.textContent!, /Current0/);
  // Direct simulator callers cannot bypass the policy, even after selection.
  render(base, 0, true);
  click("Select All");
  render(insufficient, 0, true);
  unavailable();
  render({ ...insufficient, buckets: { overdue: [], dueSoon: [], upcoming: [] } }, 100, true);
  unavailable();
  render(base, 0, true);
  assert.doesNotMatch(container.textContent!, /After Repair/);
  console.log("Shared VHI score eligibility, initial rendering, selection, and transition checks passed.");
}
act(() => root.unmount());
dom.window.close();
