// app/dashboard/vehicles/[vin]/plan/PlanUI-modern.tsx
"use client";

import { useMemo, useState } from "react";

type TriagedItem = {
  key: string;
  title: string;
  category?: string;
  intervalMiles?: number | null;
  intervalMonths?: number | null;
  last?: { miles?: number | null; date?: Date | null } | null;
  dueAtMiles?: number | null;
  dueAtDate?: Date | null;
  milesToGo?: number | null;
  daysToGo?: number | null;
  bump?: "red" | "yellow" | null;
};

function fmtMiles(m?: number | null) {
  if (m === 0) return "0";
  if (m == null) return "";
  return m.toLocaleString();
}

export default function PlanUI({
  buckets,
  counts,
  vehicleInfo,
  debugData,
}: {
  buckets: { overdue: TriagedItem[]; dueSoon: TriagedItem[]; upcoming: TriagedItem[] };
  counts: { overdue: number; soon: number; upcoming: number };
  vehicleInfo: {
    year?: number | null;
    make?: string | null;
    model?: string | null;
    vin: string;
    currentMiles: number | null;
    mpdBlended: number | null;
  };
  debugData?: any;
}) {
  const [viewMode, setViewMode] = useState<"advisor" | "customer">("advisor");

  const totalCounts = {
    o: counts.overdue,
    s: counts.soon,
    u: counts.upcoming,
    total: counts.overdue + counts.soon + counts.upcoming
  };

  const vehicleDisplayName = [vehicleInfo.year, vehicleInfo.make, vehicleInfo.model]
    .filter(Boolean)
    .join(" ") || "Vehicle";

  return (
    <div className="min-h-screen bg-gradient-to-br from-gray-50 to-blue-50">
      {/* Modern Header */}
      <div className="bg-white/90 backdrop-blur-sm border-b border-gray-200 sticky top-0 z-20 shadow-sm">
        <div className="max-w-7xl mx-auto px-6 py-6">
          <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-6">
            <div className="space-y-2">
              <h1 className="text-3xl font-bold text-gray-900 flex items-center gap-3">
                🚗 {vehicleDisplayName} — Vehicle Health Indicator
              </h1>
              <div className="flex flex-wrap items-center gap-4 text-sm text-gray-600">
                <span>VIN: <code className="bg-gray-100 px-2 py-1 rounded text-xs">{vehicleInfo.vin}</code></span>
                {vehicleInfo.currentMiles && (
                  <span>Current: <strong>{fmtMiles(vehicleInfo.currentMiles)} mi</strong></span>
                )}
                {vehicleInfo.mpdBlended && (
                  <span>Avg: <strong>{vehicleInfo.mpdBlended.toFixed(1)} mi/day</strong></span>
                )}
              </div>
            </div>

            {/* Action Buttons */}
            <div className="flex items-center gap-3">
              <button
                onClick={() => window.print()}
                className="px-3 py-1.5 text-sm border border-gray-300 bg-white hover:bg-gray-50 rounded-md font-medium"
              >
                🖨️ Print VHI
              </button>
              <button
                title="Share VHI report"
                className="px-3 py-1.5 text-sm border border-gray-300 bg-white hover:bg-gray-50 rounded-md font-medium"
              >
                📤 Share
              </button>
              
              {/* View Mode Toggle */}
              <div className="flex bg-gray-100 rounded-lg p-1">
                <button
                  onClick={() => setViewMode("advisor")}
                  className={`px-3 py-1.5 text-sm font-medium rounded-md transition-all ${
                    viewMode === "advisor" 
                      ? "bg-white text-blue-600 shadow-sm" 
                      : "text-gray-600 hover:text-gray-900"
                  }`}
                >
                  Advisor View
                </button>
                <button
                  onClick={() => setViewMode("customer")}
                  className={`px-3 py-1.5 text-sm font-medium rounded-md transition-all ${
                    viewMode === "customer" 
                      ? "bg-white text-blue-600 shadow-sm" 
                      : "text-gray-600 hover:text-gray-900"
                  }`}
                >
                  Customer View
                </button>
              </div>
            </div>
          </div>

          {/* Summary Stats */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mt-6">
            <div className="bg-gradient-to-r from-red-500 to-red-600 rounded-lg p-4 text-white">
              <div className="text-2xl font-bold">{totalCounts.o}</div>
              <div className="text-red-100">Overdue Items</div>
            </div>
            <div className="bg-gradient-to-r from-amber-500 to-amber-600 rounded-lg p-4 text-white">
              <div className="text-2xl font-bold">{totalCounts.s}</div>
              <div className="text-amber-100">Due Soon</div>
            </div>
            <div className="bg-gradient-to-r from-blue-500 to-blue-600 rounded-lg p-4 text-white">
              <div className="text-2xl font-bold">{totalCounts.u}</div>
              <div className="text-blue-100">Upcoming</div>
            </div>
            <div className="bg-gradient-to-r from-green-500 to-green-600 rounded-lg p-4 text-white">
              <div className="text-2xl font-bold">{totalCounts.total}</div>
              <div className="text-green-100">Total Services</div>
            </div>
          </div>
        </div>
      </div>

      {/* Main Content */}
      <div className="max-w-7xl mx-auto px-6 py-6">
        {totalCounts.total === 0 ? (
          <div className="text-center py-12">
            <div className="text-6xl mb-4">🎉</div>
            <h3 className="text-xl font-semibold text-gray-900 mb-2">All Caught Up!</h3>
            <p className="text-gray-600">No maintenance items found.</p>
            {debugData && (
              <div className="mt-4 text-sm text-gray-500">
                OEM Count: {debugData.oemCount}, CarFax: {debugData.carfaxOk ? '✅' : '❌'}, DVI: {debugData.dviOk ? '✅' : '❌'}
              </div>
            )}
          </div>
        ) : (
          <div className="space-y-4">
            {/* AI Insight Banner */}
            <div className="bg-gradient-to-r from-purple-600 to-blue-600 rounded-xl p-6 text-white">
              <div className="flex items-start gap-4">
                <div className="text-3xl">🤖</div>
                <div>
                  <h3 className="text-lg font-semibold mb-2">AI-Powered Recommendations</h3>
                  <p className="text-purple-100 text-sm">
                    Our AI has analyzed this vehicle's service history, mileage patterns, and manufacturer 
                    specifications to prioritize the most critical maintenance items.
                    {totalCounts.o > 0 && ` ${totalCounts.o} items are overdue and should be addressed immediately.`}
                  </p>
                </div>
              </div>
            </div>

            {/* Service Items Placeholder */}
            <div className="text-center py-8 bg-white rounded-lg border-2 border-dashed border-gray-300">
              <div className="text-4xl mb-4">🔧</div>
              <h3 className="text-lg font-semibold text-gray-900 mb-2">Service Items Loading...</h3>
              <p className="text-gray-600">Found {totalCounts.total} maintenance items to display.</p>
            </div>
          </div>
        )}

        {/* Debug Panel (only in advisor view) */}
        {viewMode === "advisor" && debugData && (
          <details className="mt-8 bg-white rounded-lg border border-gray-200">
            <summary className="cursor-pointer p-4 font-medium text-gray-700 hover:bg-gray-50 rounded-lg">
              Debug Information (Advisor Only)
            </summary>
            <div className="p-4 border-t border-gray-200">
              <pre className="text-xs bg-gray-50 p-3 rounded overflow-auto max-h-72 text-gray-700">
                {JSON.stringify(debugData, null, 2)}
              </pre>
            </div>
          </details>
        )}
      </div>
    </div>
  );
}
  const [showDetails, setShowDetails] = useState(false);
  
  const lineForClipboard = useMemo(() => {
    const bits: string[] = [];
    bits.push(`${t.title}`);
    if (t.dueAtMiles != null) bits.push(`Due at ${fmtMiles(t.dueAtMiles)} mi`);
    if (t.milesToGo != null) {
      if (t.milesToGo <= 0) bits.push(`${fmtMiles(Math.abs(t.milesToGo))} mi overdue`);
      else bits.push(`~${fmtMiles(t.milesToGo)} mi remaining`);
    }
    if (t.last?.miles != null) {
      bits.push(`Last at ${fmtMiles(t.last.miles)} mi${t.last?.date ? ` (${t.last.date.toLocaleDateString()})` : ""}`);
    }
    return bits.join(" — ");
  }, [t]);

  // Modern card styling based on severity
  const cardStyle = useMemo(() => {
    switch (severity) {
      case "overdue":
        return "border-l-4 border-l-red-500 bg-gradient-to-r from-red-50 to-white hover:from-red-100 hover:to-red-50";
      case "soon":
        return "border-l-4 border-l-amber-500 bg-gradient-to-r from-amber-50 to-white hover:from-amber-100 hover:to-amber-50";
      case "upcoming":
        return "border-l-4 border-l-blue-500 bg-gradient-to-r from-blue-50 to-white hover:from-blue-100 hover:to-blue-50";
      default:
        return "border-l-4 border-l-gray-300 bg-white hover:bg-gray-50";
    }
  }, [severity]);

  const urgencyIcon = useMemo(() => {
    switch (severity) {
      case "overdue": return "🚨";
      case "soon": return "⚠️";
      case "upcoming": return "📅";
      default: return "🔧";
    }
  }, [severity]);

  const priorityBadge = useMemo(() => {
    switch (severity) {
      case "overdue": return { text: "OVERDUE", className: "bg-red-500 text-white animate-pulse" };
      case "soon": return { text: "DUE SOON", className: "bg-amber-500 text-white" };
      case "upcoming": return { text: "SCHEDULED", className: "bg-blue-500 text-white" };
      default: return { text: "PENDING", className: "bg-gray-500 text-white" };
    }
  }, [severity]);

  return (
    <Card className={`${cardStyle} transition-all duration-300 hover:shadow-lg hover:scale-[1.02] transform`}>
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between">
          <div className="flex items-start gap-3 flex-1">
            <div className="text-2xl">{urgencyIcon}</div>
            <div className="flex-1">
              <div className="flex items-center gap-2 mb-2">
                <CardTitle className="text-lg font-semibold text-gray-900">{t.title}</CardTitle>
                <Badge className={priorityBadge.className}>{priorityBadge.text}</Badge>
              </div>
              
              <div className="flex flex-wrap items-center gap-2 mb-2">
                {t.bump === "red" && <Badge className="bg-red-600 text-white text-xs">🔴 DVI Critical</Badge>}
                {t.bump === "yellow" && <Badge className="bg-amber-600 text-white text-xs">🟡 DVI Warning</Badge>}
                {(t.intervalMiles || t.intervalMonths) && (
                  <Badge variant="info" className="text-xs">
                    OEM: {t.intervalMiles ? `${fmtMiles(t.intervalMiles)} mi` : ""}
                    {t.intervalMiles && t.intervalMonths ? " / " : ""}
                    {t.intervalMonths ? `${t.intervalMonths} mo` : ""}
                  </Badge>
                )}
              </div>

              {/* Status Information */}
              <div className="text-sm font-medium text-gray-700">
                {t.milesToGo != null && t.milesToGo <= 0 && (
                  <div className="text-red-700">
                    <span className="font-semibold">{fmtMiles(Math.abs(t.milesToGo))} miles overdue</span>
                    {t.dueAtMiles && <span className="text-gray-600"> • Due at {fmtMiles(t.dueAtMiles)} mi</span>}
                  </div>
                )}
                {t.milesToGo != null && t.milesToGo > 0 && (
                  <div className="text-gray-700">
                    <span className="font-semibold">Due in {fmtMiles(t.milesToGo)} miles</span>
                    {t.dueAtMiles && <span className="text-gray-600"> • At {fmtMiles(t.dueAtMiles)} mi</span>}
                  </div>
                )}
                {t.dueAtDate && (
                  <div className="text-gray-600 text-xs mt-1">
                    Target date: {t.dueAtDate.toLocaleDateString()}
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* Action Buttons */}
          <div className="flex flex-col gap-2 ml-4">
            <button
              className="px-3 py-1.5 text-sm bg-blue-600 hover:bg-blue-700 text-white shadow-sm hover:shadow-md transition-all rounded-md font-medium"
              title="Add to repair order"
            >
              + Add to RO
            </button>
            <button
              className="px-3 py-1.5 text-sm border border-gray-300 bg-white text-gray-700 hover:bg-gray-50 rounded-md font-medium"
              onClick={() => navigator.clipboard.writeText(lineForClipboard)}
              title="Copy service details"
            >
              📋 Copy
            </button>
          </div>
        </div>
      </CardHeader>

      {/* Expandable Details */}
      <CardContent className="pt-0">
        <button
          className="text-sm text-blue-600 hover:text-blue-800 flex items-center gap-1 mb-2 transition-colors"
          onClick={() => setShowDetails(!showDetails)}
        >
          {showDetails ? "▼" : "▶"} {showDetails ? "Hide" : "Show"} service details
        </button>
        
        {showDetails && (
          <div className="bg-white/80 rounded-lg p-4 border border-gray-200 space-y-3 text-sm">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <div>
                <span className="font-medium text-gray-900">Maintenance Interval:</span>
                <div className="text-gray-700">
                  {t.intervalMiles ? `${fmtMiles(t.intervalMiles)} miles` : "Not specified"}
                  {t.intervalMiles && t.intervalMonths ? " or " : ""}
                  {t.intervalMonths ? `${t.intervalMonths} months` : ""}
                </div>
              </div>
              
              {t.last?.miles && (
                <div>
                  <span className="font-medium text-gray-900">Last Service:</span>
                  <div className="text-gray-700">
                    {fmtMiles(t.last.miles)} miles
                    {t.last?.date && <span className="text-gray-500"> on {t.last.date.toLocaleDateString()}</span>}
                  </div>
                </div>
              )}
            </div>
            
            {t.category && (
              <div>
                <span className="font-medium text-gray-900">Category:</span>
                <span className="text-gray-700 ml-2">{t.category}</span>
              </div>
            )}
            
            <div className="pt-2 border-t border-gray-200">
              <span className="font-medium text-gray-900">Recommendation Source:</span>
              <div className="text-gray-700 text-xs mt-1">
                {t.bump ? "Digital Vehicle Inspection (DVI) + " : ""}
                {(t.intervalMiles || t.intervalMonths) ? "OEM Schedule + " : ""}
                AI Analysis
              </div>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export default function PlanUI({
  buckets,
  counts,
  vehicleInfo,
  debugData,
}: {
  buckets: { overdue: TriagedItem[]; dueSoon: TriagedItem[]; upcoming: TriagedItem[] };
  counts: { overdue: number; soon: number; upcoming: number };
  vehicleInfo: {
    year?: number | null;
    make?: string | null;
    model?: string | null;
    vin: string;
    currentMiles: number | null;
    mpdBlended: number | null;
  };
  debugData?: any;
}) {
  const [activeView, setActiveView] = useState<"all" | "overdue" | "soon" | "upcoming">("all");
  const [viewMode, setViewMode] = useState<"advisor" | "customer">("advisor");

  const totalCounts = {
    o: counts.overdue,
    s: counts.soon,
    u: counts.upcoming,
    total: counts.overdue + counts.soon + counts.upcoming
  };

  const allItems = useMemo(() => [
    ...buckets.overdue.map(item => ({ ...item, severity: "overdue" as const })),
    ...buckets.dueSoon.map(item => ({ ...item, severity: "soon" as const })),
    ...buckets.upcoming.map(item => ({ ...item, severity: "upcoming" as const }))
  ], [buckets]);

  const filteredItems = useMemo(() => {
    switch (activeView) {
      case "overdue": return buckets.overdue.map(item => ({ ...item, severity: "overdue" as const }));
      case "soon": return buckets.dueSoon.map(item => ({ ...item, severity: "soon" as const }));
      case "upcoming": return buckets.upcoming.map(item => ({ ...item, severity: "upcoming" as const }));
      default: return allItems;
    }
  }, [activeView, allItems, buckets]);

  const vehicleDisplayName = [vehicleInfo.year, vehicleInfo.make, vehicleInfo.model]
    .filter(Boolean)
    .join(" ") || "Vehicle";

  return (
    <div className="min-h-screen bg-gradient-to-br from-gray-50 to-blue-50">
      {/* Modern Header */}
      <div className="bg-white/90 backdrop-blur-sm border-b border-gray-200 sticky top-0 z-20 shadow-sm">
        <div className="max-w-7xl mx-auto px-6 py-6">
          <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4">
            {/* Vehicle Info */}
            <div className="flex items-center gap-4">
              <div className="w-12 h-12 bg-gradient-to-br from-blue-500 to-purple-600 rounded-xl flex items-center justify-center text-white font-bold text-xl">
                🚗
              </div>
              <div>
                <h1 className="text-2xl font-bold text-gray-900">
                  {vehicleDisplayName} — Maintenance Plan
                </h1>
                <div className="flex items-center gap-4 text-sm text-gray-600">
                  <span className="font-medium">VIN: {vehicleInfo.vin}</span>
                  {vehicleInfo.currentMiles != null && (
                    <span>Current: <span className="font-semibold">{fmtMiles(vehicleInfo.currentMiles)} mi</span></span>
                  )}
                  {vehicleInfo.mpdBlended != null && (
                    <span>Avg: <span className="font-semibold">{vehicleInfo.mpdBlended.toFixed(1)} mi/day</span></span>
                  )}
                </div>
              </div>
            </div>

            {/* Action Buttons */}
            <div className="flex items-center gap-3">
              <button
                onClick={() => window.print()}
                className="px-3 py-1.5 text-sm border border-gray-300 bg-white hover:bg-gray-50 rounded-md font-medium"
              >
                🖨️ Print VHI
              </button>
              <button
                title="Share VHI report"
                className="px-3 py-1.5 text-sm border border-gray-300 bg-white hover:bg-gray-50 rounded-md font-medium"
              >
                📤 Share
              </button>
              
              {/* View Mode Toggle */}
              <div className="flex bg-gray-100 rounded-lg p-1">
                <button
                  onClick={() => setViewMode("advisor")}
                  className={`px-3 py-1.5 text-sm font-medium rounded-md transition-all ${
                    viewMode === "advisor" 
                      ? "bg-white text-blue-600 shadow-sm" 
                      : "text-gray-600 hover:text-gray-900"
                  }`}
                >
                  Advisor View
                </button>
                <button
                  onClick={() => setViewMode("customer")}
                  className={`px-3 py-1.5 text-sm font-medium rounded-md transition-all ${
                    viewMode === "customer" 
                      ? "bg-white text-blue-600 shadow-sm" 
                      : "text-gray-600 hover:text-gray-900"
                  }`}
                >
                  Customer View
                </button>
              </div>
            </div>
          </div>

          {/* Summary Stats */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mt-6">
            <div className="bg-gradient-to-r from-red-500 to-red-600 rounded-lg p-4 text-white">
              <div className="text-2xl font-bold">{totalCounts.o}</div>
              <div className="text-red-100">Overdue Items</div>
            </div>
            <div className="bg-gradient-to-r from-amber-500 to-amber-600 rounded-lg p-4 text-white">
              <div className="text-2xl font-bold">{totalCounts.s}</div>
              <div className="text-amber-100">Due Soon</div>
            </div>
            <div className="bg-gradient-to-r from-blue-500 to-blue-600 rounded-lg p-4 text-white">
              <div className="text-2xl font-bold">{totalCounts.u}</div>
              <div className="text-blue-100">Upcoming</div>
            </div>
            <div className="bg-gradient-to-r from-green-500 to-green-600 rounded-lg p-4 text-white">
              <div className="text-2xl font-bold">{totalCounts.total}</div>
              <div className="text-green-100">Total Services</div>
            </div>
          </div>
        </div>
      </div>

      {/* Filter Tabs */}
      <div className="max-w-7xl mx-auto px-6 py-6">
        <div className="flex flex-wrap gap-2 mb-6">
          {[
            { key: "all", label: `All Services (${totalCounts.total})`, color: "bg-gray-600" },
            { key: "overdue", label: `Overdue (${totalCounts.o})`, color: "bg-red-600" },
            { key: "soon", label: `Due Soon (${totalCounts.s})`, color: "bg-amber-600" },
            { key: "upcoming", label: `Upcoming (${totalCounts.u})`, color: "bg-blue-600" }
          ].map(({ key, label, color }) => (
            <button
              key={key}
              onClick={() => setActiveView(key as any)}
              className={`px-4 py-2 rounded-lg font-medium transition-all ${
                activeView === key
                  ? `${color} text-white shadow-lg scale-105`
                  : "bg-white text-gray-700 border border-gray-300 hover:border-gray-400 hover:bg-gray-50"
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        {/* Service Items */}
        <div className="space-y-4">
          {filteredItems.length === 0 ? (
            <div className="text-center py-12">
              <div className="text-6xl mb-4">🎉</div>
              <h3 className="text-xl font-semibold text-gray-900 mb-2">All Caught Up!</h3>
              <p className="text-gray-600">
                {activeView === "all" ? "No maintenance items found." : `No ${activeView} maintenance items.`}
              </p>
            </div>
          ) : (
            <>
              {/* AI Insight Banner */}
              {activeView === "all" && totalCounts.total > 0 && (
                <div className="bg-gradient-to-r from-purple-600 to-blue-600 rounded-xl p-6 text-white mb-6">
                  <div className="flex items-start gap-4">
                    <div className="text-3xl">🤖</div>
                    <div>
                      <h3 className="text-lg font-semibold mb-2">AI-Powered Recommendations</h3>
                      <p className="text-purple-100 text-sm">
                        Our AI has analyzed this vehicle's service history, mileage patterns, and manufacturer 
                        specifications to prioritize the most critical maintenance items. 
                        {totalCounts.o > 0 && ` ${totalCounts.o} items are overdue and should be addressed immediately.`}
                      </p>
                    </div>
                  </div>
                </div>
              )}

              {filteredItems.map((item) => (
                <ServiceCard 
                  key={item.key} 
                  t={item} 
                  severity={item.severity} 
                />
              ))}
            </>
          )}
        </div>

        {/* Debug Panel (only in advisor view) */}
        {viewMode === "advisor" && debugData && (
          <details className="mt-8 bg-white rounded-lg border border-gray-200">
            <summary className="cursor-pointer p-4 font-medium text-gray-700 hover:bg-gray-50 rounded-lg">
              Debug Information (Advisor Only)
            </summary>
            <div className="p-4 border-t border-gray-200">
              <pre className="text-xs bg-gray-50 p-3 rounded overflow-auto max-h-72 text-gray-700">
                {JSON.stringify(debugData, null, 2)}
              </pre>
            </div>
          </details>
        )}
      </div>
    </div>
  );
}