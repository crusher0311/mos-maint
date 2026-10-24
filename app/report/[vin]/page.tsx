"use client";

import React, { useEffect, useState } from "react";
import VehicleHealthReport, { computeScore } from "@/components/vehicle-health-report/VehicleHealthReport";
import type { VHIData } from "@/components/vehicle-health-report/VehicleHealthReport";

export default function ReportPage({ params }: { params: { vin: string } }) {
  const [data, setData] = useState<VHIData | null>(null);
  const [shopName, setShopName] = useState<string>("");
  const [shopPhone, setShopPhone] = useState<string>("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [preparing, setPreparing] = useState(false);
  const [loadAttempt, setLoadAttempt] = useState(0);

  useEffect(() => {
    const searchParams = new URLSearchParams(window.location.search);
    const token = searchParams.get("token");

    if (!token) {
      setError("Invalid report link. Please request a new link from your service advisor.");
      setLoading(false);
      return;
    }

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let attempts = 0;
    setLoading(true);
    setError(null);
    const load = () => fetch(`/api/report/${encodeURIComponent(params.vin)}?token=${encodeURIComponent(token)}`, {
      signal: AbortSignal.timeout(15000),
      cache: "no-store",
    })
      .then((res) => {
        if (res.status === 202) {
          if (++attempts >= 40) throw new Error("Your report is still being prepared. Please try again shortly.");
          if (!cancelled) {
            setPreparing(true);
            timer = setTimeout(load, 3000);
          }
          return null;
        }
        if (res.status === 403) throw new Error("This report link has expired. Please request a new one from your service advisor.");
        if (res.status === 404) throw new Error("Report not found. The vehicle plan may not be available yet.");
        if (!res.ok) throw new Error("Unable to load report. Please try again later.");
        return res.json();
      })
      .then((result) => {
        if (!result || cancelled) return;
        setData(result.plan);
        setShopName(result.shopName || "");
        setShopPhone(result.shopPhone || "");
        setLoading(false);
        setPreparing(false);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err.message);
        setLoading(false);
      });
    void load();
    return () => { cancelled = true; if (timer) clearTimeout(timer); };
  }, [params.vin, loadAttempt]);

  async function updateMileage(mileage: number): Promise<void> {
    if (!Number.isInteger(mileage) || mileage < 101 || mileage > 999999) {
      throw new Error("Enter a whole number between 101 and 999,999.");
    }
    const token = new URLSearchParams(window.location.search).get("token");
    if (!token) {
      throw new Error("Invalid report link. Please request a new link from your service advisor.");
    }
    const reportUrl = `/api/report/${encodeURIComponent(params.vin)}`;
    let response: Response;
    try {
      response = await fetch(`${reportUrl}/mileage?token=${encodeURIComponent(token)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mileage }),
        signal: AbortSignal.timeout(15000),
      });
    } catch {
      throw new Error("Unable to confirm the mileage update. Please try again.");
    }
    const result = await response.json().catch(() => null);
    if (!response.ok || result?.ok !== true) {
      throw new Error(
        typeof result?.error === "string"
          ? result.error
          : "Unable to update mileage. Please try again."
      );
    }
    try {
      const refreshed = await fetch(`${reportUrl}?token=${encodeURIComponent(token)}`, {
        signal: AbortSignal.timeout(15000),
        cache: "no-store",
      });
      if (!refreshed.ok) throw new Error("Report refresh failed.");
      const report = await refreshed.json();
      if (!report.plan) throw new Error("Report not found.");
      setData(report.plan);
      setShopName(report.shopName || "");
      setShopPhone(report.shopPhone || "");
    } catch {
      throw new Error("Mileage was saved, but the report could not be refreshed. Please reload this page.");
    }
  }

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="text-center">
          <div className="w-10 h-10 border-4 border-[#1e3a5f] border-t-transparent rounded-full animate-spin mx-auto" />
          <p className="text-gray-500 mt-4 text-sm" role="status">{preparing ? "Preparing your vehicle report. This page will update automatically…" : "Loading vehicle report..."}</p>
        </div>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center px-4">
        <div className="text-center max-w-sm">
          <div className="w-14 h-14 rounded-full bg-red-100 flex items-center justify-center mx-auto mb-4">
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#ef4444" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="10" />
              <line x1="12" y1="8" x2="12" y2="12" />
              <line x1="12" y1="16" x2="12.01" y2="16" />
            </svg>
          </div>
          <p className="text-gray-800 font-semibold text-lg">Unable to Load Report</p>
          <p className="text-gray-500 text-sm mt-2 leading-relaxed">{error || "Report not found"}</p>
          <button onClick={() => setLoadAttempt(n => n + 1)} className="mt-4 rounded-md bg-[#1e3a5f] px-4 py-2 text-sm font-semibold text-white">Try again</button>
        </div>
      </div>
    );
  }

  const score = computeScore(data);

  return (
    <VehicleHealthReport
      data={data}
      score={score}
      shopName={shopName}
      shopPhone={shopPhone}
      onUpdateMileage={updateMileage}
    />
  );
}
