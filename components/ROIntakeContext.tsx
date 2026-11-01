"use client";
import {useEffect, useState} from "react";
import type {IntakeContext} from "@/lib/auto-dvi/staff/intake-context";

export function ROIntakeContext({enabled, scope, vin, mileage, unit, confirmed}: {
  enabled: boolean; scope: string; vin: string; mileage: string; unit?: "miles" | "kilometers"; confirmed: boolean;
}) {
  const [result, setResult] = useState<{key: string; value: IntakeContext | null} | null>(null);
  const key = JSON.stringify([enabled, scope, vin, mileage, unit, confirmed]);
  useEffect(() => {
    if (!enabled || !confirmed || !unit || !/^[A-HJ-NPR-Z0-9]{17}$/.test(vin) || !/^\d+$/.test(mileage)) return;
    const controller = new AbortController();
    let active = true;
    let poll: ReturnType<typeof setTimeout> | undefined;
    let attempt = 0;
    setResult({key, value: null});
    const timer = setTimeout(() => controller.abort(), 40_000);
    const load = () => {attempt++; void fetch("/api/dashboard/protractor/intake-context", {method: "POST", credentials: "include",
      headers: {"Content-Type": "application/json"}, signal: controller.signal,
      body: JSON.stringify({vin, mileage: Number(mileage), distanceUnit: unit})})
      .then(async response => {
        if (!response.ok) throw Error("Context unavailable");
        const value = await response.json() as IntakeContext;
        if (!["available", "missing", "unavailable", "preparing"].includes(value.status) || !Array.isArray(value.checks)) throw Error("Invalid context");
        if (active) {
          setResult({key, value: value.status === "preparing" && attempt >= 10 ?
            {status: "unavailable", coverage: "unknown", checks: []} : value});
          if (value.status === "preparing" && attempt < 10) poll = setTimeout(load, 3000);
          else clearTimeout(timer);
        }
      }).catch(() => {
        if (active) setResult({key, value: {status: "unavailable", coverage: "unknown", checks: []}});
        clearTimeout(timer);
      });};
    load();
    return () => {active = false; controller.abort(); clearTimeout(timer); if (poll) clearTimeout(poll);};
  }, [key, enabled, confirmed, unit, vin, mileage]);
  if (!enabled || !confirmed || result?.key !== key) return null;
  return <aside className="rounded-lg border border-gray-200 bg-gray-50 p-3 text-sm" aria-label="Early maintenance context">
    <strong>Maintenance context · not inspection results</strong>
    {!result.value || result.value.status === "preparing" ? <p role="status">Preparing available VHI context. You can continue check-in without waiting.</p> :
      result.value.status !== "available" ? <p>No usable VHI context is available yet. Check-in can continue; no health score or inspection result has been inferred.</p> : <>
        <p>Available retained-history context · {result.value.coverage === "sufficient" ? "recorded history coverage" : "limited or unknown history coverage"}. Confirm these checks during inspection.</p>
        <ul>{result.value.checks.map((check, index) => <li key={index}>{check.title} · {check.timing === "overdue" ? "Overdue maintenance" : "Maintenance due soon"}</li>)}</ul>
        {!result.value.checks.length && <p>No attention items in the available context. This does not establish a satisfactory inspection.</p>}
      </>}
    <small>Automatic preparation uses retained history, never a paid CARFAX lookup. Missing coverage is not an inspection result.</small>
  </aside>;
}
