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

  useEffect(() => {
    const searchParams = new URLSearchParams(window.location.search);
    const token = searchParams.get("token");

    if (!token) {
      setError("Invalid report link. Please request a new link from your service advisor.");
      setLoading(false);
      return;
    }

    fetch(`/api/report/${params.vin}?token=${encodeURIComponent(token)}`)
      .then((res) => {
        if (res.status === 403) throw new Error("This report link has expired. Please request a new one from your service advisor.");
        if (res.status === 404) throw new Error("Report not found. The vehicle plan may not be available yet.");
        if (!res.ok) throw new Error("Unable to load report. Please try again later.");
        return res.json();
      })
      .then((result) => {
        setData(result.plan);
        setShopName(result.shopName || "");
        setShopPhone(result.shopPhone || "");
        setLoading(false);
      })
      .catch((err) => {
        setError(err.message);
        setLoading(false);
      });
  }, [params.vin]);

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="text-center">
          <div className="w-10 h-10 border-4 border-[#1e3a5f] border-t-transparent rounded-full animate-spin mx-auto" />
          <p className="text-gray-500 mt-4 text-sm">Loading vehicle report...</p>
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
    />
  );
}
