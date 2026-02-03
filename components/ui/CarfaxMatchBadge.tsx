"use client";

import { useState } from "react";
import { X, Check, XCircle, MapPin, Calendar, Gauge } from "lucide-react";

type CarfaxMatch = {
  date: string;
  odometer: number | null;
  description: string;
  location: string | null;
  confidence: "high" | "medium";
};

type CarfaxMatchBadgeProps = {
  match: CarfaxMatch;
  deferredId: string;
  vin: string;
  serviceTitle: string;
  onRemedied?: () => void;
};

export function CarfaxMatchBadge({ match, deferredId, vin, serviceTitle, onRemedied }: CarfaxMatchBadgeProps) {
  const [showModal, setShowModal] = useState(false);
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState<"idle" | "success" | "error">("idle");

  // Normalize deferredId - strip protractor_ prefix if present for consistent storage
  const normalizedId = deferredId.startsWith("protractor_") 
    ? deferredId.slice("protractor_".length) 
    : deferredId;

  const handleRemedy = async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/deferred/remedy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          vin,
          deferredId: normalizedId,
          carfaxDate: match.date,
          carfaxDescription: match.description,
          carfaxLocation: match.location,
        }),
      });
      
      if (res.ok) {
        setStatus("success");
        setTimeout(() => {
          setShowModal(false);
          onRemedied?.();
          window.location.reload();
        }, 1000);
      } else {
        setStatus("error");
      }
    } catch {
      setStatus("error");
    } finally {
      setLoading(false);
    }
  };

  const formattedDate = match.date ? new Date(match.date).toLocaleDateString() : "Unknown date";
  const confidenceColor = match.confidence === "high" ? "bg-green-100 text-green-700 border-green-300" : "bg-yellow-100 text-yellow-700 border-yellow-300";

  return (
    <>
      <button
        onClick={() => setShowModal(true)}
        className="inline-flex items-center gap-1 rounded-full bg-orange-100 border border-orange-300 px-2 py-0.5 text-[11px] text-orange-700 hover:bg-orange-200 transition-colors cursor-pointer"
        title="Possible CARFAX match - click to review"
      >
        <img src="/badges/carfax.png" alt="CARFAX" className="h-3" />
        <span>Possible Match</span>
      </button>

      {showModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={() => setShowModal(false)}>
          <div 
            className="bg-white rounded-xl shadow-xl max-w-md w-full mx-4 overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between px-4 py-3 bg-gradient-to-r from-orange-500 to-orange-600 text-white">
              <div className="flex items-center gap-2">
                <img src="/badges/carfax.png" alt="CARFAX" className="h-5 bg-white rounded px-1" />
                <span className="font-semibold">Possible CARFAX Match</span>
              </div>
              <button onClick={() => setShowModal(false)} className="p-1 hover:bg-white/20 rounded">
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="p-4 space-y-4">
              <div>
                <div className="text-sm text-gray-500 mb-1">Deferred Service</div>
                <div className="font-medium text-gray-900">{serviceTitle}</div>
              </div>

              <div className="border-t pt-4">
                <div className="text-sm text-gray-500 mb-2 flex items-center gap-2">
                  CARFAX Record
                  <span className={`text-[10px] px-2 py-0.5 rounded-full border ${confidenceColor}`}>
                    {match.confidence === "high" ? "High confidence" : "Medium confidence"}
                  </span>
                </div>
                <div className="bg-gray-50 rounded-lg p-3 space-y-2">
                  <div className="font-medium text-gray-900">{match.description}</div>
                  <div className="flex flex-wrap gap-3 text-sm text-gray-600">
                    <span className="flex items-center gap-1">
                      <Calendar className="w-4 h-4" />
                      {formattedDate}
                    </span>
                    {match.odometer && (
                      <span className="flex items-center gap-1">
                        <Gauge className="w-4 h-4" />
                        {match.odometer.toLocaleString()} mi
                      </span>
                    )}
                    {match.location && (
                      <span className="flex items-center gap-1">
                        <MapPin className="w-4 h-4" />
                        {match.location}
                      </span>
                    )}
                  </div>
                </div>
              </div>

              <div className="text-sm text-gray-600 bg-blue-50 rounded-lg p-3">
                Was this service completed elsewhere? If so, you can mark it as remedied and it will be removed from the deferred list.
              </div>

              {status === "success" && (
                <div className="flex items-center gap-2 text-green-600 bg-green-50 rounded-lg p-3">
                  <Check className="w-5 h-5" />
                  <span>Marked as remedied! Refreshing...</span>
                </div>
              )}

              {status === "error" && (
                <div className="flex items-center gap-2 text-red-600 bg-red-50 rounded-lg p-3">
                  <XCircle className="w-5 h-5" />
                  <span>Failed to update. Please try again.</span>
                </div>
              )}

              <div className="flex gap-3 pt-2">
                <button
                  onClick={() => setShowModal(false)}
                  className="flex-1 px-4 py-2 border border-gray-300 rounded-lg text-gray-700 hover:bg-gray-50 transition-colors"
                  disabled={loading}
                >
                  Keep as Deferred
                </button>
                <button
                  onClick={handleRemedy}
                  disabled={loading || status === "success"}
                  className="flex-1 px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 transition-colors disabled:opacity-50 flex items-center justify-center gap-2"
                >
                  {loading ? (
                    <span className="animate-spin">⏳</span>
                  ) : (
                    <>
                      <Check className="w-4 h-4" />
                      Mark as Remedied
                    </>
                  )}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
