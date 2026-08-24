"use client";

import React, { useState } from "react";
import HealthGauge from "./HealthGauge";
import ServiceIcon from "./ServiceIcon";
import ScoreSimulator from "./ScoreSimulator";
import { getOELogoUrl } from "@/lib/oe-logos";

type ReportTab = "recommendations" | "plan" | "improve" | "dvi";

interface LastService {
  miles: number | null;
  date: string | null;
  source: string | null;
  /** Task #434: customer-facing parent label when `lastSource === "implied"`. */
  impliedFromParentName?: string | null;
  /** Task #434: stable parent id when `lastSource === "implied"`. */
  impliedFromParentKey?: string | null;
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
  /** Task #808: declined-work provenance (null on plans cached before schema v8). */
  declinedAt?: string | null;
  declinedReason?: string | null;
  declinedRoNumber?: number | null;
  declinedOrigin?: "shop" | "tekmetric" | null;
  matchedDeferred: any;
  protractorDeferredId: string | null;
  action?: string | null;
  notes?: string | null;
  recommendedDefault?: boolean;
  recommendedReason?: string | null;
  /**
   * Task #868: True ONLY when the interval came from the lifetime-fluid
   * default — distinguishes genuine lifetime fluids from other
   * recommendedDefault rows (e.g. the Safety Check — Oil Level engine-risk
   * row) so the badge text doesn't conflate them. Absent on plans cached
   * before schema v10.
   */
  lifetimeFluidDefault?: boolean;
  /** Task #198: True when OEM only schedules an "Inspect …" verb on a known fluid. */
  inspectOnly?: boolean;
  /** Task #198: Tooltip / chip rationale for inspectOnly. */
  inspectOnlyReason?: string | null;
  engineRiskFlag?: boolean;
  engineRiskReason?: string | null;
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
  approvedServiceKeys?: string[];
  /**
   * Shop's distance preference. When "kilometers", every distance label on
   * this report renders "km" / "kilometers" instead of "mi" / "miles". The
   * underlying numeric values in `currentMiles`, `item.intervalMiles`,
   * `item.last.miles`, etc. are ALREADY in this unit — triage converts OEM
   * miles → shop unit once at plan-build time (Task #333). Defaulted at the
   * API boundary so the legacy report path keeps rendering "miles".
   */
  distanceUnit?: "miles" | "kilometers";
  /**
   * Task #439: when present and `sufficient: false`, the report renders
   * a gray "Insufficient Service History" badge instead of the colored
   * gauge. Absent / `sufficient: true` keeps the normal score display.
   */
  dataQuality?: {
    sufficient: boolean;
    carfaxStatus?: string;
    anchorCount?: number;
    reasons?: string[];
  };
  /**
   * Task #991 — customer-facing DVI: technician inspection findings for
   * this vehicle. When present (shop has Auto DVI + recorded findings),
   * the report shows an "Inspection" tab. Media streams through the
   * token-authorized /api/report/[vin]/media/[mediaId] route.
   */
  dvi?: {
    updatedAt?: string | null;
    items: Array<{
      itemId: string;
      name: string;
      rating: "green" | "yellow" | "red" | null;
      notes: string | null;
      recommendation: string | null;
      media: Array<{ mediaId: string; kind: "photo" | "video"; contentType: string }>;
    }>;
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

const COMPLIMENTARY_KEYS = new Set([
  "oil_reminder",
  "oil_replacement_reminder",
  "reset_oil_replacement_reminder",
  "chassis_body",
  "tighten_nuts_bolts",
  "multi_point_inspection",
  "tire_pressure",
  "tire_pressure_check",
]);

const COMPLIMENTARY_TITLE_KEYWORDS = [
  "oil replacement reminder",
  "maint reqd",
  "oil reset",
  "reset oil",
  "tighten nuts and bolts",
  "tighten nuts & bolts",
  "chassis and body",
  "chassis & body",
  "multi-point inspection",
  "multi point inspection",
  "tire pressure check",
  "tire pressure set",
  "set tire pressure",
];

function isComplimentaryItem(item: PlanItem): boolean {
  const key = (item.serviceKey || item.key || "").toLowerCase();
  if (COMPLIMENTARY_KEYS.has(key)) return true;
  const title = item.title.toLowerCase();
  return COMPLIMENTARY_TITLE_KEYWORDS.some(kw => title.includes(kw));
}

function isApprovedItem(item: PlanItem, approvedKeys?: string[]): boolean {
  if (!approvedKeys || approvedKeys.length === 0) return false;
  const sk = (item.serviceKey || item.key || "").toLowerCase();
  return approvedKeys.some(k => k.toLowerCase() === sk);
}

/*
 * Task #678: client-side mirror of the canonical proportional score in
 * `lib/vhi-score.ts`. The math MUST stay in lockstep with the server so the
 * live "What If You Repair Today?" simulation and the server-rendered gauge
 * agree. See the canonical module for the full rationale. Differences from
 * the server version: this mirror additionally excludes customer-approved
 * items (the report-only `approvedServiceKeys` concept) from scoring.
 */
const VHI_OVERDUE_BASE = 1.0;
const VHI_DUE_SOON_BASE = 0.4;
const VHI_OVERDUE_RED_BONUS = 0.15;
const VHI_OVERDUE_DECLINED_BONUS = 0.1;
const VHI_DUE_SOON_RED_BONUS = 0.1;
const VHI_DUE_SOON_YELLOW_BONUS = 0.05;
const VHI_MAX_STATE_FACTOR = VHI_OVERDUE_BASE + VHI_OVERDUE_RED_BONUS + VHI_OVERDUE_DECLINED_BONUS; // 1.25
const VHI_SOFT_FLOOR = 12;
const VHI_CURVE_EXPONENT = 1.15;

function vhiCategoryMultiplier(category: string): number {
  const cat = (category || "").toLowerCase();
  if (cat.includes("brake") || cat.includes("tire") || cat.includes("steering") || cat.includes("suspension")) return 1.5;
  if (cat.includes("engine") || cat.includes("transmission") || cat.includes("drivetrain")) return 1.3;
  if (cat.includes("wiper") || cat.includes("light") || cat.includes("cabin") || cat.includes("body")) return 0.7;
  return 1.0;
}

function computeScore(data: VHIData): number {
  const approved = data.approvedServiceKeys;

  let penalty = 0;
  let maxPenalty = 0;

  const accrue = (item: PlanItem, stateFactor: number) => {
    if (isComplimentaryItem(item)) return;
    if (isApprovedItem(item, approved)) return;
    const weight = vhiCategoryMultiplier(item.category);
    penalty += weight * stateFactor;
    maxPenalty += weight * VHI_MAX_STATE_FACTOR;
  };

  for (const item of data.buckets.overdue) {
    let s = VHI_OVERDUE_BASE;
    if (item.bump === "red") s += VHI_OVERDUE_RED_BONUS;
    if (item.declined) s += VHI_OVERDUE_DECLINED_BONUS;
    accrue(item, s);
  }

  for (const item of data.buckets.dueSoon) {
    let s = VHI_DUE_SOON_BASE;
    if (item.bump === "red") s += VHI_DUE_SOON_RED_BONUS;
    else if (item.bump === "yellow") s += VHI_DUE_SOON_YELLOW_BONUS;
    accrue(item, s);
  }

  for (const item of data.buckets.upcoming) {
    accrue(item, 0);
  }

  if (maxPenalty <= 0) return 100;

  const ratio = Math.min(1, Math.max(0, penalty / maxPenalty));
  const score = 100 - (100 - VHI_SOFT_FLOOR) * Math.pow(ratio, VHI_CURVE_EXPONENT);
  return Math.max(0, Math.min(100, Math.round(score)));
}

function getStatusLabel(item: PlanItem, bucket: "overdue" | "dueSoon"): { text: string; color: string } {
  if (item.source === "dvi" || item.category === "DVI Finding") {
    return { text: "REPAIR", color: "#dc2626" };
  }
  // Lifetime / fill-for-life fluids surface as a shop recommendation rather
  // than an OEM-mandated overdue / due-soon item.
  if (item.recommendedDefault) {
    return { text: "RECOMMENDED", color: "#2563eb" };
  }
  // Task #198: OEM-only-inspect rows on known fluids surface as an
  // INSPECT badge rather than OVERDUE / DUE SOON, so customers don't
  // misread an inspection cadence as an overdue replacement.
  if (item.inspectOnly) {
    return { text: "INSPECT", color: "#b45309" };
  }
  if (bucket === "overdue") {
    return { text: "OVERDUE", color: "#dc2626" };
  }
  return { text: "DUE SOON", color: "#f59e0b" };
}

function appendNotes(base: string, item: PlanItem): string {
  const extras: string[] = [];
  if (item.recommendedDefault && item.recommendedReason) {
    extras.push(item.recommendedReason);
  }
  // Task #198: surface the OEM-inspect rationale in the printed report
  // body so the printed VHR is self-explanatory even without chip hover.
  if (item.inspectOnly && item.inspectOnlyReason) {
    extras.push(item.inspectOnlyReason);
  }
  if (item.notes && item.notes.trim()) {
    extras.push(`Note: ${item.notes.trim()}`);
  }
  if (extras.length === 0) return base;
  const trimmedBase = base.trim();
  return `${trimmedBase}${trimmedBase && !trimmedBase.endsWith(".") ? "." : ""} ${extras.join(" ")}`.trim();
}

function getItemDescription(item: PlanItem, unit: DistanceUnit = "miles"): string {
  const dWord = distWord(unit);
  if (item.category === "DVI Finding") {
    return appendNotes("Identified during vehicle inspection. Repair recommended.", item);
  }
  if (!item.last) {
    const base = `No record of this service being performed. ${item.intervalMiles ? `Recommended every ${item.intervalMiles.toLocaleString()} ${dWord}.` : ""}`;
    return appendNotes(base, item);
  }
  const lastDate = item.last.date ? new Date(item.last.date).toLocaleDateString("en-US", { month: "short", year: "numeric" }) : null;
  const lastMiles = item.last.miles?.toLocaleString();
  // Task #434: when the anchor was inferred from a parent service via the
  // implies-reset map, lead with "Anchored to <parent>" instead of the
  // misleading "Last serviced" phrasing — the child wasn't directly
  // performed on that date, the parent was.
  const impliedParent = item.last.impliedFromParentName?.trim() || null;
  const lastVerb = impliedParent ? `Anchored to ${impliedParent}` : "Last serviced";
  if (item.milesToGo !== null && item.milesToGo < 0) {
    return appendNotes(`Overdue by ${Math.abs(item.milesToGo).toLocaleString()} ${dWord}.${lastDate ? ` ${lastVerb} ${lastDate}.` : ""}`, item);
  }
  if (item.milesToGo !== null && item.milesToGo > 0) {
    let dateEst = "";
    if (item.daysToGo !== null && item.daysToGo > 0) {
      const estDate = new Date(Date.now() + item.daysToGo * 86400000);
      dateEst = ` Estimated around ${estDate.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}.`;
    }
    return appendNotes(`Due in approximately ${item.milesToGo.toLocaleString()} ${dWord}.${dateEst}${lastDate ? ` ${lastVerb} ${lastDate}.` : ""}`, item);
  }
  if (lastDate) {
    return appendNotes(`${lastVerb} ${lastDate}${lastMiles ? ` at ${lastMiles} ${dWord}` : ""}.`, item);
  }
  return appendNotes("Service recommended based on manufacturer schedule.", item);
}

function formatDate(dateStr: string | null): string {
  if (!dateStr) return "";
  return new Date(dateStr).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
}

/**
 * Distance unit helpers. Triage stores distances in shop units already
 * (Task #333), so these only swap labels — no numeric conversion.
 */
type DistanceUnit = "miles" | "kilometers";
function distAbbrev(unit: DistanceUnit | undefined): string {
  return unit === "kilometers" ? "km" : "mi";
}
function distWord(unit: DistanceUnit | undefined): string {
  return unit === "kilometers" ? "kilometers" : "miles";
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
  const distanceUnit: DistanceUnit = data.distanceUnit === "kilometers" ? "kilometers" : "miles";
  const dAbbrev = distAbbrev(distanceUnit);
  const ymm = [vehicle.year, vehicle.make, vehicle.model].filter(Boolean).join(" ");
  // Resolve once so any unmatched-make miss is recorded a single time per
  // render instead of twice (once for the conditional, once for `src`).
  const vehicleOeLogoUrl = getOELogoUrl(vehicle.make);

  const approved = data.approvedServiceKeys;
  const complimentaryItems = [
    ...buckets.overdue.filter(isComplimentaryItem),
    ...buckets.dueSoon.filter(isComplimentaryItem),
  ];
  const approvedItems = [
    ...buckets.overdue.filter(i => !isComplimentaryItem(i) && isApprovedItem(i, approved)),
    ...buckets.dueSoon.filter(i => !isComplimentaryItem(i) && isApprovedItem(i, approved)),
  ];
  const filteredOverdue = buckets.overdue.filter(i => !isComplimentaryItem(i) && !isApprovedItem(i, approved));
  const filteredDueSoon = buckets.dueSoon.filter(i => !isComplimentaryItem(i) && !isApprovedItem(i, approved));

  const goodSystems = buckets.upcoming.filter(
    (item) => item.milesToGo !== null && item.milesToGo > 5000
  );

  // Task #194: when the plan flags this engine for accelerated oil wear
  // (or auto-inserts the 3,000-mi Safety Check — Oil Level row), the only
  // explanation on-card today is a hover tooltip with technical wording.
  // Customers reading the printed report can't see tooltips, so render a
  // short plain-English callout block whenever either signal is present.
  // Rendered above the tab navigation so it appears in SSR HTML on every
  // tab and prints reliably.
  const allItems = [
    ...buckets.overdue,
    ...buckets.dueSoon,
    ...buckets.upcoming,
  ];
  const hasEngineRiskFlag = allItems.some((item) => item.engineRiskFlag);
  const hasOilLevelSafetyCheck = allItems.some(
    (item) => (item.serviceKey ?? item.key ?? "").toLowerCase() === "safety_check_oil_level"
  );
  const showEngineFlagCallout = hasEngineRiskFlag || hasOilLevelSafetyCheck;

  const dviItems = data.dvi?.items || [];
  const tabs: { key: ReportTab; label: string }[] = [
    { key: "recommendations", label: "Recommendations" },
    { key: "plan", label: "Plan" },
    { key: "improve", label: "Improve My Score" },
    ...(dviItems.length > 0 ? ([{ key: "dvi", label: "Inspection" }] as { key: ReportTab; label: string }[]) : []),
  ];
  // Media on the shared report reuses the page's own share token.
  const shareToken =
    typeof window !== "undefined" ? new URLSearchParams(window.location.search).get("token") || "" : "";
  const dviMediaUrl = (mediaId: string) =>
    `/api/report/${encodeURIComponent(data.vin)}/media/${encodeURIComponent(mediaId)}?token=${encodeURIComponent(shareToken)}`;
  const DVI_GROUPS: Array<{
    rating: "red" | "yellow" | "green" | null;
    title: string;
    badge: string;
    badgeClass: string;
    cardClass: string;
  }> = [
    { rating: "red", title: "Needs Attention", badge: "Attention", badgeClass: "bg-red-100 text-red-700 border-red-300", cardClass: "border-red-200 bg-red-50/50" },
    { rating: "yellow", title: "Monitor", badge: "Monitor", badgeClass: "bg-amber-100 text-amber-800 border-amber-300", cardClass: "border-amber-200 bg-amber-50/50" },
    { rating: "green", title: "Checked & Good", badge: "Good", badgeClass: "bg-green-100 text-green-700 border-green-300", cardClass: "border-green-200 bg-green-50/40" },
    { rating: null, title: "Also Inspected", badge: "Inspected", badgeClass: "bg-gray-100 text-gray-600 border-gray-300", cardClass: "border-gray-200 bg-gray-50" },
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

        {/* Vehicle Info Header */}
        <div className="py-4 px-4 border-b border-gray-200">
          <div className="flex items-center gap-3">
            {vehicleOeLogoUrl && (
              <img
                src={vehicleOeLogoUrl}
                alt={vehicle.make || ""}
                className="h-10 sm:h-12 object-contain flex-shrink-0"
              />
            )}
            <div className="min-w-0">
              <h2 className="text-lg sm:text-2xl font-bold text-gray-900 truncate">{ymm || "Vehicle"}</h2>
              <p className="text-xs sm:text-sm text-gray-500">
                {customerName && <><span className="font-medium text-gray-700">{customerName}</span> &bull; </>}
                VIN <code className="text-xs">{data.vin}</code>
                {currentMiles > 0 && <> &bull; Current: <span className="font-medium">{currentMiles.toLocaleString()} {dAbbrev}</span></>}
              </p>
            </div>
          </div>
        </div>

        {/* Health Score Gauge */}
        <div className="py-6 px-4 flex flex-col items-center">
          <HealthGauge score={score} insufficient={data.dataQuality?.sufficient === false} />

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

        {/* Engine-flagged / oil-level safety check explanation (Task #194). */}
        {showEngineFlagCallout && (
          <div className="px-4 pb-4">
            <div className="border border-amber-300 bg-amber-50 rounded-lg p-3 sm:p-4 flex items-start gap-3">
              <span
                aria-hidden="true"
                className="text-amber-600 text-lg leading-none flex-shrink-0 mt-0.5"
              >
                ⚠
              </span>
              <div className="min-w-0">
                {(() => {
                  // Task #194 anchors this safety check at 3,000 mi in the
                  // engine-risk classifier; render the rounded km equivalent
                  // (~4,800 km) for metric shops so the copy matches the
                  // values customers see elsewhere on the report.
                  const safetyCheckLabel = distanceUnit === "kilometers" ? "4,800-km" : "3,000-mile";
                  const safetyCheckValue = distanceUnit === "kilometers" ? "4,800 km" : "3,000 miles";
                  return (
                    <>
                      <p className="text-sm font-semibold text-amber-900 leading-tight">
                        Why we added a {safetyCheckLabel} oil-level safety check
                      </p>
                      <p className="text-xs sm:text-sm text-amber-900/90 mt-1 leading-relaxed">
                        Your vehicle&apos;s factory oil-change interval is on the
                        longer side, which can let oil run low or wear out before the
                        next full change. To help catch that early, we&apos;ve added a
                        quick complimentary oil-level check at about {safetyCheckValue} since
                        your last oil change.
                      </p>
                    </>
                  );
                })()}
              </div>
            </div>
          </div>
        )}

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
              {filteredOverdue.length > 0 && (
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
                      Needs Attention Now ({filteredOverdue.length})
                    </h3>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    {filteredOverdue.map((item) => {
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
                                {getItemDescription(item, distanceUnit)}
                              </p>
                              <div className="mt-2 flex items-center gap-2 flex-wrap">
                                <span
                                  className="text-xs font-bold uppercase"
                                  style={{ color: status.color }}
                                >
                                  Status: {status.text}
                                </span>
                                {item.engineRiskFlag && (
                                  <span
                                    className="text-[10px] font-semibold bg-amber-100 text-amber-800 border border-amber-300 px-1.5 py-0.5 rounded inline-flex items-center gap-0.5"
                                    title={item.engineRiskReason ?? "Engine flagged for accelerated oil wear."}
                                  >
                                    <span aria-hidden="true">⚠</span>
                                    Engine flagged — long oil interval
                                  </span>
                                )}
                                {item.recommendedDefault && (
                                  <span
                                    className="text-[10px] font-semibold bg-blue-50 text-blue-700 border border-blue-200 px-1.5 py-0.5 rounded"
                                    title={item.recommendedReason ?? (item.lifetimeFluidDefault ? "OEM lists this as lifetime fluid; shop recommendation only." : "Shop-recommended service.")}
                                  >
                                    {item.lifetimeFluidDefault
                                      ? "OEM lifetime fluid · Shop recommendation"
                                      : `Shop recommendation${item.intervalMiles ? ` · every ${item.intervalMiles.toLocaleString()} ${dAbbrev}` : ""}`}
                                  </span>
                                )}
                                {item.inspectOnly && (
                                  <span
                                    className="text-[10px] font-semibold bg-amber-100 text-amber-800 border border-amber-300 px-1.5 py-0.5 rounded"
                                    title={item.inspectOnlyReason ?? "OEM only schedules an inspection (not a replacement) for this fluid."}
                                  >
                                    OEM: Inspect{item.intervalMiles ? ` every ${item.intervalMiles.toLocaleString()} ${dAbbrev}` : (item.intervalMonths ? ` every ${item.intervalMonths} mo` : "")}
                                  </span>
                                )}
                                {item.declined && (
                                  <span
                                    className="text-[10px] bg-orange-100 text-orange-700 border border-orange-200 px-1.5 py-0.5 rounded font-medium"
                                    title={(() => {
                                      // Task #808: show the decline date / RO when known
                                      // (Tekmetric-declined work carries both; older
                                      // cached plans have neither).
                                      const d = item.declinedAt ? new Date(item.declinedAt) : null;
                                      const parts: string[] = [];
                                      if (d && !isNaN(d.getTime())) parts.push(`Declined on ${d.toLocaleDateString()}`);
                                      if (item.declinedRoNumber) parts.push(`RO #${item.declinedRoNumber}`);
                                      if (item.declinedReason) parts.push(item.declinedReason);
                                      return parts.join(" · ") || "Previously declined";
                                    })()}
                                  >
                                    Previously Declined
                                    {(() => {
                                      const d = item.declinedAt ? new Date(item.declinedAt) : null;
                                      return d && !isNaN(d.getTime()) ? ` · ${d.toLocaleDateString()}` : "";
                                    })()}
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

              {filteredDueSoon.length > 0 && (
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
                      Coming Up Soon ({filteredDueSoon.length})
                    </h3>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    {filteredDueSoon.map((item) => {
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
                                {getItemDescription(item, distanceUnit)}
                              </p>
                              <div className="mt-2 flex items-center gap-2 flex-wrap">
                                <span
                                  className="text-xs font-bold uppercase"
                                  style={{ color: status.color }}
                                >
                                  Status: {status.text}
                                </span>
                                {item.engineRiskFlag && (
                                  <span
                                    className="text-[10px] font-semibold bg-amber-100 text-amber-800 border border-amber-300 px-1.5 py-0.5 rounded inline-flex items-center gap-0.5"
                                    title={item.engineRiskReason ?? "Engine flagged for accelerated oil wear."}
                                  >
                                    <span aria-hidden="true">⚠</span>
                                    Engine flagged — long oil interval
                                  </span>
                                )}
                                {item.recommendedDefault && (
                                  <span
                                    className="text-[10px] font-semibold bg-blue-50 text-blue-700 border border-blue-200 px-1.5 py-0.5 rounded"
                                    title={item.recommendedReason ?? (item.lifetimeFluidDefault ? "OEM lists this as lifetime fluid; shop recommendation only." : "Shop-recommended service.")}
                                  >
                                    {item.lifetimeFluidDefault
                                      ? "OEM lifetime fluid · Shop recommendation"
                                      : `Shop recommendation${item.intervalMiles ? ` · every ${item.intervalMiles.toLocaleString()} ${dAbbrev}` : ""}`}
                                  </span>
                                )}
                                {item.inspectOnly && (
                                  <span
                                    className="text-[10px] font-semibold bg-amber-100 text-amber-800 border border-amber-300 px-1.5 py-0.5 rounded"
                                    title={item.inspectOnlyReason ?? "OEM only schedules an inspection (not a replacement) for this fluid."}
                                  >
                                    OEM: Inspect{item.intervalMiles ? ` every ${item.intervalMiles.toLocaleString()} ${dAbbrev}` : (item.intervalMonths ? ` every ${item.intervalMonths} mo` : "")}
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

              {complimentaryItems.length > 0 && (
                <div className="px-4 py-5 border-b border-gray-100">
                  <div className="flex items-center gap-2 mb-4">
                    <div className="w-6 h-6 rounded-full bg-blue-500 flex items-center justify-center flex-shrink-0">
                      <svg width="14" height="14" viewBox="0 0 14 14" fill="white">
                        <path d="M7 2 L8.5 5.5 L12 5.5 L9 8 L10 12 L7 9.5 L4 12 L5 8 L2 5.5 L5.5 5.5 Z" fill="white" />
                      </svg>
                    </div>
                    <h3 className="text-base sm:text-lg font-bold text-blue-600">
                      Additional Services ({complimentaryItems.length})
                    </h3>
                  </div>

                  <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                    {complimentaryItems.map((item) => (
                      <div
                        key={item.key}
                        className="border border-blue-100 rounded-lg p-3 bg-blue-50/30"
                      >
                        <div className="flex items-center gap-2">
                          <div className="text-blue-500 flex-shrink-0">
                            <ServiceIcon serviceKey={item.serviceKey ?? item.key} title={item.title} size={22} />
                          </div>
                          <span className="text-xs font-medium text-gray-700 leading-tight">{item.title}</span>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {(goodSystems.length > 0 || approvedItems.length > 0) && (
                <div className="px-4 py-5 border-b border-gray-100">
                  <div className="flex items-center gap-2 mb-4">
                    <div className="w-6 h-6 rounded-full bg-green-500 flex items-center justify-center flex-shrink-0">
                      <svg width="14" height="14" viewBox="0 0 14 14" fill="white">
                        <polyline points="3,7 6,10 11,4" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    </div>
                    <h3 className="text-base sm:text-lg font-bold text-green-600">Systems in Good Condition</h3>
                  </div>

                  {approvedItems.length > 0 && (
                    <div className="mb-4 border border-green-200 rounded-lg bg-green-50/50 p-3">
                      <p className="text-xs font-semibold text-green-700 mb-2">Approved &amp; being performed during this active visit</p>
                      <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                        {approvedItems.map((item) => (
                          <div key={item.key} className="flex items-center gap-2">
                            <div className="text-green-600 flex-shrink-0">
                              <ServiceIcon serviceKey={item.serviceKey ?? item.key} title={item.title} size={20} />
                            </div>
                            <span className="text-xs font-medium text-green-800 truncate">{item.title}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {goodSystems.length > 0 && (
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
                  )}
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
                    {filteredOverdue.map((item) => (
                      <div key={item.key} className="flex items-center gap-1.5">
                        <div className={`w-2 h-2 rounded-full flex-shrink-0 ${item.bump === "red" || item.category === "DVI Finding" ? "bg-red-500" : "bg-red-400"}`} />
                        <span className="text-[11px] sm:text-xs text-gray-700 font-medium leading-tight">{item.title}</span>
                        {item.engineRiskFlag && (
                          <span
                            className="text-[9px] font-semibold text-amber-700 leading-none"
                            title={item.engineRiskReason ?? "Engine flagged for accelerated oil wear."}
                            aria-label="Engine flagged — long oil interval"
                          >
                            ⚠
                          </span>
                        )}
                      </div>
                    ))}
                    {filteredOverdue.length === 0 && (
                      <p className="text-[11px] text-gray-400 italic">Nothing overdue</p>
                    )}
                  </div>
                </div>

                <div className="border-x border-gray-200">
                  <div className="bg-[#2a5a8f] text-white text-center py-2 px-2">
                    <span className="text-xs sm:text-sm font-bold tracking-wide">NEXT 3 MO</span>
                  </div>
                  <div className="p-2 sm:p-3 space-y-2">
                    {filteredDueSoon.map((item) => (
                      <div key={item.key} className="flex items-center gap-1.5">
                        <div className={`w-2 h-2 rounded-full flex-shrink-0 ${item.bump === "yellow" ? "bg-amber-400" : "bg-amber-500"}`} />
                        <span className="text-[11px] sm:text-xs text-gray-700 font-medium leading-tight">{item.title}</span>
                        {item.engineRiskFlag && (
                          <span
                            className="text-[9px] font-semibold text-amber-700 leading-none"
                            title={item.engineRiskReason ?? "Engine flagged for accelerated oil wear."}
                            aria-label="Engine flagged — long oil interval"
                          >
                            ⚠
                          </span>
                        )}
                      </div>
                    ))}
                    {filteredDueSoon.length === 0 && (
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
                        {item.engineRiskFlag && (
                          <span
                            className="text-[9px] font-semibold text-amber-700 leading-none"
                            title={item.engineRiskReason ?? "Engine flagged for accelerated oil wear."}
                            aria-label="Engine flagged — long oil interval"
                          >
                            ⚠
                          </span>
                        )}
                      </div>
                    ))}
                    {buckets.upcoming.length === 0 && (
                      <p className="text-[11px] text-gray-400 italic">All caught up</p>
                    )}
                  </div>
                </div>
              </div>

              {complimentaryItems.length > 0 && (
                <div className="mt-4 border border-blue-100 rounded-lg p-3 bg-blue-50/30">
                  <p className="text-xs font-semibold text-blue-600 mb-2">Additional Services</p>
                  <div className="flex flex-wrap gap-x-4 gap-y-1">
                    {complimentaryItems.map((item) => (
                      <div key={item.key} className="flex items-center gap-1.5">
                        <div className="text-blue-400 flex-shrink-0">
                          <ServiceIcon serviceKey={item.serviceKey ?? item.key} title={item.title} size={16} />
                        </div>
                        <span className="text-[11px] text-gray-600 font-medium">{item.title}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* IMPROVE MY SCORE TAB */}
          {activeTab === "improve" && (
            <ScoreSimulator data={data} currentScore={score} />
          )}

          {/* INSPECTION (DVI) TAB — Task #991 */}
          {activeTab === "dvi" && dviItems.length > 0 && (
            <div className="px-4 py-5 space-y-5">
              <div>
                <h3 className="text-base sm:text-lg font-bold text-gray-900">Digital Vehicle Inspection</h3>
                <p className="text-xs text-gray-500 mt-0.5">
                  What our technician checked on your vehicle
                  {data.dvi?.updatedAt
                    ? ` · ${new Date(data.dvi.updatedAt).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })}`
                    : ""}
                </p>
              </div>
              {DVI_GROUPS.map((group) => {
                const groupItems = dviItems.filter((it) => (it.rating ?? null) === group.rating);
                if (groupItems.length === 0) return null;
                return (
                  <div key={group.title}>
                    <h4 className="text-sm font-bold text-gray-800 mb-2">
                      {group.title} ({groupItems.length})
                    </h4>
                    <div className="space-y-2">
                      {groupItems.map((it) => (
                        <div key={it.itemId} className={`border rounded-lg p-3 ${group.cardClass}`}>
                          <div className="flex items-start justify-between gap-2">
                            <div className="min-w-0 flex-1">
                              <div className="font-semibold text-sm text-gray-900">{it.name}</div>
                              {it.notes && (
                                <p className="text-xs text-gray-600 mt-1 leading-relaxed">{it.notes}</p>
                              )}
                              {it.recommendation && (
                                <p className="text-xs text-gray-800 mt-1 leading-relaxed">
                                  <span className="font-semibold">Recommendation:</span> {it.recommendation}
                                </p>
                              )}
                            </div>
                            <span className={`text-[10px] font-bold uppercase border rounded-full px-2 py-0.5 shrink-0 ${group.badgeClass}`}>
                              {group.badge}
                            </span>
                          </div>
                          {it.media.length > 0 && (
                            <div className="mt-2 flex flex-wrap gap-2">
                              {it.media.map((m) =>
                                m.kind === "video" ? (
                                  <video
                                    key={m.mediaId}
                                    src={dviMediaUrl(m.mediaId)}
                                    controls
                                    preload="metadata"
                                    className="h-28 rounded-lg border border-gray-200 bg-black"
                                  />
                                ) : (
                                  <a key={m.mediaId} href={dviMediaUrl(m.mediaId)} target="_blank" rel="noreferrer">
                                    <img
                                      src={dviMediaUrl(m.mediaId)}
                                      alt={it.name}
                                      className="h-28 w-auto rounded-lg border border-gray-200 object-cover"
                                    />
                                  </a>
                                ),
                              )}
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
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

export { computeScore, isComplimentaryItem };
export type { VHIData, PlanItem, VehicleInfo };
