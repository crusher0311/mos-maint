"use client";

import { useState } from "react";
import { ExternalLink } from "lucide-react";

export function ShareReportButton({ vin }: { vin: string }) {
  const [shareUrl, setShareUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);

  const handleShare = async () => {
    setLoading(true);
    setCopied(false);
    try {
      const res = await fetch(`/api/report/${vin}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({}),
      });
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.error || "Failed to generate share link");
      }
      const data = await res.json();
      setShareUrl(data.shareUrl);
      try {
        await navigator.clipboard.writeText(data.shareUrl);
        setCopied(true);
        setTimeout(() => setCopied(false), 3000);
      } catch {}
    } catch (err: any) {
      setShareUrl(null);
      alert(err.message || "Failed to generate share link. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="relative print:hidden">
      <button
        onClick={handleShare}
        disabled={loading}
        className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-green-600 text-white rounded-lg hover:bg-green-700 transition-colors text-sm font-medium disabled:opacity-50"
      >
        <ExternalLink className="w-4 h-4" />
        {loading ? "Generating..." : copied ? "Link Copied!" : "Share Report"}
      </button>
      {shareUrl && !loading && (
        <div className="absolute right-0 top-full mt-2 w-80 bg-white border border-gray-200 rounded-lg shadow-lg p-3 z-50">
          <p className="text-xs text-gray-500 mb-1">Customer report link (expires in 7 days):</p>
          <div className="flex items-center gap-2">
            <input
              type="text"
              readOnly
              value={shareUrl}
              className="flex-1 text-xs bg-gray-50 border border-gray-200 rounded px-2 py-1.5 text-gray-700"
              onClick={(e) => (e.target as HTMLInputElement).select()}
            />
            <button
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(shareUrl);
                  setCopied(true);
                  setTimeout(() => setCopied(false), 3000);
                } catch {}
              }}
              className="px-2 py-1.5 bg-blue-600 text-white rounded text-xs hover:bg-blue-700 whitespace-nowrap"
            >
              {copied ? "Copied!" : "Copy"}
            </button>
          </div>
          <button
            onClick={() => setShareUrl(null)}
            className="mt-2 text-xs text-gray-400 hover:text-gray-600"
          >
            Dismiss
          </button>
        </div>
      )}
    </div>
  );
}
