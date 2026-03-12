"use client";

interface ModernPlanUIProps {
  vehicleInfo: {
    year?: number | null;
    make?: string | null;
    model?: string | null;
    vin: string;
    currentMiles: number | null;
    mpdBlended: number | null;
  };
  totalCounts: {
    o: number;
    s: number;
    u: number;
    total: number;
  };
  debugData: any;
}

function fmtMiles(m?: number | null) {
  if (m === 0) return "0";
  if (m == null) return "";
  return m.toLocaleString();
}

export default function ModernPlanUI({ vehicleInfo, totalCounts, debugData }: ModernPlanUIProps) {
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
            <div className="mt-4 text-sm text-gray-500">
              Debug: {JSON.stringify(debugData, null, 2)}
            </div>
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

        {/* Debug Panel */}
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
      </div>
    </div>
  );
}