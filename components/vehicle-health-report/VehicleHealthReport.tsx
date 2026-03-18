"use client";

import React, { useState } from "react";
import HealthGauge from "./HealthGauge";
import ServiceIcon from "./ServiceIcon";
import ScoreSimulator from "./ScoreSimulator";

type ReportTab = "recommendations" | "plan" | "improve";

interface LastService {
  miles: number | null;
  date: string | null;
  source: string | null;
}

interface PlanItem {
  key: string;
  serviceKey: string | null;
  title: string;
  category: string;
  intervalMiles: number | null;
  intervalMonths: number | null;
  last: LastService | null;
  dueAtMiles: number | null;
  dueAtDate: string | null;
  milesToGo: number | null;
  daysToGo: number | null;
  bump: "red" | "yellow" | null;
  source: string;
  dviSource?: "autoflow" | "autovitals" | "tekmetric" | null;
  reason: string | null;
  usingShopInterval: boolean;
  declined: boolean;
  matchedDeferred: any;
  protractorDeferredId: string | null;
}

interface VehicleInfo {
  year: number | null;
  make: string | null;
  model: string | null;
  engine: string | null;
}

interface VHIData {
  vehicle: VehicleInfo;
  vin: string;
  currentMiles: number;
  customerName: string;
  buckets: {
    overdue: PlanItem[];
    dueSoon: PlanItem[];
    upcoming: PlanItem[];
  };
}

interface VehicleHealthReportProps {
  data: VHIData;
  score: number;
  shopName?: string;
  shopPhone?: string;
  onScheduleService?: () => void;
  onViewDetails?: () => void;
}

function computeScore(data: VHIData): number {
  let score = 100;

  const categoryMultiplier = (category: string): number => {
    const cat = category.toLowerCase();
    if (cat.includes("brake") || cat.includes("tire") || cat.includes("steering") || cat.includes("suspension")) return 1.5;
    if (cat.includes("engine") || cat.includes("transmission") || cat.includes("drivetrain")) return 1.3;
    if (cat.includes("wiper") || cat.includes("light") || cat.includes("cabin") || cat.includes("body")) return 0.7;
    return 1.0;
  };

  for (const item of data.buckets.overdue) {
    let deduction = item.bump === "red" ? 7 : item.bump === "yellow" ? 5 : 5;
    deduction *= categoryMultiplier(item.category);
    if (item.declined) deduction += 1;
    score -= deduction;
  }

  for (const item of data.buckets.dueSoon) {
    let deduction = item.bump === "yellow" ? 2.5 : item.bump === "red" ? 3 : 2;
    deduction *= categoryMultiplier(item.category);
    score -= deduction;
  }

  return Math.max(0, Math.min(100, Math.round(score)));
}

function getStatusLabel(item: PlanItem, bucket: "overdue" | "dueSoon"): { text: string; color: string } {
  if (item.source === "dvi" || item.category === "DVI Finding") {
    return { text: "REPAIR", color: "#dc2626" };
  }
  if (bucket === "overdue") {
    return { text: "OVERDUE", color: "#dc2626" };
  }
  return { text: "DUE SOON", color: "#f59e0b" };
}

function getItemDescription(item: PlanItem): string {
  if (item.category === "DVI Finding") {
    return "Identified during vehicle inspection. Repair recommended.";
  }
  if (!item.last) {
    return `This service has never been performed. ${item.intervalMiles ? `Recommended every ${item.intervalMiles.toLocaleString()} miles.` : ""}`;
  }
  const lastDate = item.last.date ? new Date(item.last.date).toLocaleDateString("en-US", { month: "short", year: "numeric" }) : null;
  const lastMiles = item.last.miles?.toLocaleString();
  if (item.milesToGo !== null && item.milesToGo < 0) {
    return `Overdue by ${Math.abs(item.milesToGo).toLocaleString()} miles.${lastDate ? ` Last serviced ${lastDate}.` : ""}`;
  }
  if (item.milesToGo !== null && item.milesToGo > 0) {
    return `Due in approximately ${item.milesToGo.toLocaleString()} miles.${lastDate ? ` Last serviced ${lastDate}.` : ""}`;
  }
  if (lastDate) {
    return `Last serviced ${lastDate}${lastMiles ? ` at ${lastMiles} miles` : ""}.`;
  }
  return "Service recommended based on manufacturer schedule.";
}

function formatDate(dateStr: string | null): string {
  if (!dateStr) return "";
  return new Date(dateStr).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
}

function getBucketColor(bucket: "overdue" | "dueSoon" | "upcoming"): string {
  if (bucket === "overdue") return "#dc2626";
  if (bucket === "dueSoon") return "#f59e0b";
  return "#6b7280";
}

function getBucketDot(bucket: "overdue" | "dueSoon" | "upcoming"): string {
  if (bucket === "overdue") return "bg-red-500";
  if (bucket === "dueSoon") return "bg-amber-500";
  return "bg-gray-400";
}

export default function VehicleHealthReport({
  data,
  score: scoreProp,
  shopName,
  shopPhone,
  onScheduleService,
  onViewDetails,
}: VehicleHealthReportProps) {
  const [activeTab, setActiveTab] = useState<ReportTab>("recommendations");
  const score = scoreProp ?? computeScore(data);
  const { vehicle, currentMiles, customerName, buckets } = data;
  const ymm = [vehicle.year, vehicle.make, vehicle.model].filter(Boolean).join(" ");

  const goodSystems = buckets.upcoming.filter(
    (item) => item.milesToGo !== null && item.milesToGo > 5000
  );

  const tabs: { key: ReportTab; label: string }[] = [
    { key: "recommendations", label: "Recommendations" },
    { key: "plan", label: "Plan" },
    { key: "improve", label: "Improve My Score" },
  ];

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="max-w-2xl mx-auto bg-white shadow-lg">
        {/* Header */}
        <div className="bg-[#1e3a5f] text-white text-center py-4 px-4">
          <div className="flex items-center justify-center gap-3">
            <img src="/icons/vehicle-health-intelligence.png" alt="" className="w-10 h-10" />
            <div>
              <h1 className="text-lg sm:text-xl font-bold tracking-wide">Vehicle Health Indicator<sup className="text-xs align-super">™</sup></h1>
              <p className="text-xs italic opacity-80">authentically intelligent</p>
            </div>
          </div>
        </div>

        {/* Customer & Vehicle Info */}
        <div className="text-center py-5 px-4 border-b border-gray-100">
          <h2 className="text-xl sm:text-2xl font-bold text-gray-900">{customerName}</h2>
          <p className="text-sm sm:text-base text-gray-500 mt-1">
            {ymm} &middot; {currentMiles.toLocaleString()} miles
          </p>
        </div>

        {/* Health Score Gauge */}
        <div className="py-6 px-4 flex flex-col items-center">
          <HealthGauge score={score} />

          <div className="flex flex-col sm:flex-row gap-3 mt-5 w-full sm:w-auto px-4">
            {onScheduleService && (
              <button
                onClick={onScheduleService}
                className="bg-[#1e3a5f] text-white font-semibold py-2.5 px-6 rounded-md hover:bg-[#2a4f7a] transition-colors text-sm"
              >
                Schedule Service
              </button>
            )}
            {onViewDetails && (
              <button
                onClick={onViewDetails}
                className="border-2 border-[#1e3a5f] text-[#1e3a5f] font-semibold py-2.5 px-6 rounded-md hover:bg-gray-50 transition-colors text-sm"
              >
                View Details
              </button>
            )}
          </div>
        </div>

        {/* Tab Navigation */}
        <div className="border-b border-gray-200">
          <div className="flex">
            {tabs.map((tab) => (
              <button
                key={tab.key}
                onClick={() => setActiveTab(tab.key)}
                className={`flex-1 py-3 px-2 text-xs sm:text-sm font-semibold text-center transition-colors relative ${
                  activeTab === tab.key
                    ? "text-[#1e3a5f]"
                    : "text-gray-400 hover:text-gray-600"
                }`}
              >
                {tab.label}
                {activeTab === tab.key && (
                  <div className="absolute bottom-0 left-0 right-0 h-[3px] bg-[#1e3a5f] rounded-t" />
                )}
              </button>
            ))}
          </div>
        </div>

        {/* Tab Content */}
        <div className="min-h-[300px]">
          {/* RECOMMENDATIONS TAB */}
          {activeTab === "recommendations" && (
            <div>
              {buckets.overdue.length > 0 && (
                <div className="px-4 py-5 border-b border-gray-100">
                  <div className="flex items-center gap-2 mb-4">
                    <div className="w-6 h-6 rounded-full bg-red-500 flex items-center justify-center flex-shrink-0">
                      <svg width="14" height="14" viewBox="0 0 14 14" fill="white">
                        <path d="M7 1 L13 12 L1 12 Z" fill="none" stroke="white" strokeWidth="1.5" strokeLinejoin="round" />
                        <line x1="7" y1="5" x2="7" y2="8.5" stroke="white" strokeWidth="1.5" strokeLinecap="round" />
                        <circle cx="7" cy="10.5" r="0.8" fill="white" />
                      </svg>
                    </div>
                    <h3 className="text-base sm:text-lg font-bold text-red-600">
                      Needs Attention Now ({buckets.overdue.length})
                    </h3>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    {buckets.overdue.map((item) => {
                      const status = getStatusLabel(item, "overdue");
                      return (
                        <div
                          key={item.key}
                          className="border border-red-200 rounded-lg p-3 bg-red-50/50"
                        >
                          <div className="flex items-start gap-2.5">
                            <div className="text-red-600 flex-shrink-0 mt-0.5">
                              <ServiceIcon serviceKey={item.serviceKey ?? item.key} title={item.title} size={28} />
                            </div>
                            <div className="flex-1 min-w-0">
                              <h4 className="font-bold text-sm text-gray-900 leading-tight">{item.title}</h4>
                              <p className="text-xs text-gray-600 mt-1 leading-relaxed">
                                {getItemDescription(item)}
                              </p>
                              <div className="mt-2 flex items-center gap-2 flex-wrap">
                                <span
                                  className="text-xs font-bold uppercase"
                                  style={{ color: status.color }}
                                >
                                  Status: {status.text}
                                </span>
                                {item.declined && (
                                  <span className="text-[10px] bg-gray-200 text-gray-600 px-1.5 py-0.5 rounded font-medium">
                                    Previously Declined
                                  </span>
                                )}
                              </div>
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {buckets.dueSoon.length > 0 && (
                <div className="px-4 py-5 border-b border-gray-100">
                  <div className="flex items-center gap-2 mb-4">
                    <div className="w-6 h-6 rounded-full bg-amber-500 flex items-center justify-center flex-shrink-0">
                      <svg width="14" height="14" viewBox="0 0 14 14" fill="white">
                        <circle cx="7" cy="7" r="5.5" fill="none" stroke="white" strokeWidth="1.5" />
                        <line x1="7" y1="4" x2="7" y2="7.5" stroke="white" strokeWidth="1.5" strokeLinecap="round" />
                        <line x1="7" y1="7.5" x2="9.5" y2="9" stroke="white" strokeWidth="1.5" strokeLinecap="round" />
                      </svg>
                    </div>
                    <h3 className="text-base sm:text-lg font-bold text-amber-600">
                      Coming Up Soon ({buckets.dueSoon.length})
                    </h3>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    {buckets.dueSoon.map((item) => {
                      const status = getStatusLabel(item, "dueSoon");
                      return (
                        <div
                          key={item.key}
                          className="border border-amber-200 rounded-lg p-3 bg-amber-50/50"
                        >
                          <div className="flex items-start gap-2.5">
                            <div className="text-amber-600 flex-shrink-0 mt-0.5">
                              <ServiceIcon serviceKey={item.serviceKey ?? item.key} title={item.title} size={28} />
                            </div>
                            <div className="flex-1 min-w-0">
                              <h4 className="font-bold text-sm text-gray-900 leading-tight">{item.title}</h4>
                              <p className="text-xs text-gray-600 mt-1 leading-relaxed">
                                {getItemDescription(item)}
                              </p>
                              <span
                                className="text-xs font-bold uppercase mt-2 inline-block"
                                style={{ color: status.color }}
                              >
                                Status: {status.text}
                              </span>
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {goodSystems.length > 0 && (
                <div className="px-4 py-5 border-b border-gray-100">
                  <div className="flex items-center gap-2 mb-4">
                    <div className="w-6 h-6 rounded-full bg-green-500 flex items-center justify-center flex-shrink-0">
                      <svg width="14" height="14" viewBox="0 0 14 14" fill="white">
                        <polyline points="3,7 6,10 11,4" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    </div>
                    <h3 className="text-base sm:text-lg font-bold text-green-600">Systems in Good Condition</h3>
                  </div>

                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                    {goodSystems.slice(0, 8).map((item) => (
                      <div key={item.key} className="flex items-center gap-2 text-gray-600">
                        <div className="text-green-500 flex-shrink-0">
                          <ServiceIcon serviceKey={item.serviceKey ?? item.key} title={item.title} size={24} />
                        </div>
                        <span className="text-xs sm:text-sm font-medium truncate">{item.title}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* PLAN TAB */}
          {activeTab === "plan" && (
            <div className="px-4 py-5">
              <div className="grid grid-cols-3 gap-0 rounded-lg overflow-hidden border border-gray-200">
                <div>
                  <div className="bg-[#1e3a5f] text-white text-center py-2 px-2">
                    <span className="text-xs sm:text-sm font-bold tracking-wide">NOW</span>
                  </div>
                  <div className="p-2 sm:p-3 space-y-2">
                    {buckets.overdue.map((item) => (
                      <div key={item.key} className="flex items-center gap-1.5">
                        <div className={`w-2 h-2 rounded-full flex-shrink-0 ${item.bump === "red" || item.category === "DVI Finding" ? "bg-red-500" : "bg-red-400"}`} />
                        <span className="text-[11px] sm:text-xs text-gray-700 font-medium leading-tight">{item.title}</span>
                      </div>
                    ))}
                    {buckets.overdue.length === 0 && (
                      <p className="text-[11px] text-gray-400 italic">Nothing overdue</p>
                    )}
                  </div>
                </div>

                <div className="border-x border-gray-200">
                  <div className="bg-[#2a5a8f] text-white text-center py-2 px-2">
                    <span className="text-xs sm:text-sm font-bold tracking-wide">NEXT 3 MO</span>
                  </div>
                  <div className="p-2 sm:p-3 space-y-2">
                    {buckets.dueSoon.map((item) => (
                      <div key={item.key} className="flex items-center gap-1.5">
                        <div className={`w-2 h-2 rounded-full flex-shrink-0 ${item.bump === "yellow" ? "bg-amber-400" : "bg-amber-500"}`} />
                        <span className="text-[11px] sm:text-xs text-gray-700 font-medium leading-tight">{item.title}</span>
                      </div>
                    ))}
                    {buckets.dueSoon.length === 0 && (
                      <p className="text-[11px] text-gray-400 italic">Nothing due soon</p>
                    )}
                  </div>
                </div>

                <div>
                  <div className="bg-[#4a7ab5] text-white text-center py-2 px-2">
                    <span className="text-xs sm:text-sm font-bold tracking-wide">LATER</span>
                  </div>
                  <div className="p-2 sm:p-3 space-y-2">
                    {buckets.upcoming.map((item) => (
                      <div key={item.key} className="flex items-center gap-1.5">
                        <div className="w-2 h-2 rounded-full bg-gray-400 flex-shrink-0" />
                        <span className="text-[11px] sm:text-xs text-gray-700 font-medium leading-tight">{item.title}</span>
                      </div>
                    ))}
                    {buckets.upcoming.length === 0 && (
                      <p className="text-[11px] text-gray-400 italic">All caught up</p>
                    )}
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* IMPROVE MY SCORE TAB */}
          {activeTab === "improve" && (
            <ScoreSimulator data={data} currentScore={score} />
          )}
        </div>

        {/* Footer */}
        <div className="bg-gray-50 text-center py-4 px-4">
          {shopName && (
            <p className="text-sm font-semibold text-gray-700">{shopName}</p>
          )}
          {shopPhone && (
            <p className="text-xs text-gray-500 mt-1">{shopPhone}</p>
          )}
          <p className="text-[10px] text-gray-400 mt-2">
            Report generated {new Date().toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })}
          </p>
          <p className="text-[10px] text-gray-400 mt-0.5">
            Powered by Detect Dog &middot; MOS Tools
          </p>
        </div>
      </div>
    </div>
  );
}

export { computeScore };
export type { VHIData, PlanItem, VehicleInfo };
