"use client";

import { useState, useEffect } from "react";
import { Ghost, X, ArrowLeft, Shield } from "lucide-react";

interface GhostModeInfo {
  isGhostMode: boolean;
  adminEmail: string;
  shopName: string;
  shopId: number;
  impersonatingAs: string;
}

export function GhostModeBanner() {
  const [ghostInfo, setGhostInfo] = useState<GhostModeInfo | null>(null);
  const [exiting, setExiting] = useState(false);

  useEffect(() => {
    checkGhostMode();
  }, []);

  const checkGhostMode = async () => {
    try {
      const res = await fetch("/api/ghost-mode/status");
      const data = await res.json();
      if (data.isGhostMode) {
        setGhostInfo(data);
      }
    } catch (error) {
      console.error("Error checking ghost mode:", error);
    }
  };

  const exitGhostMode = async () => {
    setExiting(true);
    try {
      const res = await fetch("/api/ghost-mode/exit", { method: "POST" });
      if (res.ok) {
        window.location.href = "/platform-admin/shops";
      } else {
        alert("Failed to exit ghost mode");
        setExiting(false);
      }
    } catch (error) {
      console.error("Error exiting ghost mode:", error);
      alert("Failed to exit ghost mode");
      setExiting(false);
    }
  };

  if (!ghostInfo) return null;

  return (
    <div className="fixed top-0 left-0 right-0 z-[100] text-white shadow-lg" style={{ background: 'linear-gradient(to right, rgba(96, 99, 100, 0.95), rgba(96, 99, 100, 0.85), rgba(96, 99, 100, 0.95))' }}>
      <div className="max-w-7xl mx-auto px-4 py-2">
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-2 bg-white/20 rounded-full px-3 py-1">
              <Ghost className="w-4 h-4" />
              <span className="text-sm font-semibold">Ghost Mode</span>
            </div>
            <div className="hidden sm:flex items-center gap-2 text-sm">
              <span className="opacity-75">Viewing as</span>
              <span className="font-medium">{ghostInfo.impersonatingAs}</span>
              <span className="opacity-50">•</span>
              <span className="font-medium">{ghostInfo.shopName}</span>
            </div>
          </div>
          
          <div className="flex items-center gap-2">
            <button
              onClick={exitGhostMode}
              disabled={exiting}
              className="flex items-center gap-2 bg-white text-gray-700 hover:bg-gray-50 px-4 py-1.5 rounded-full text-sm font-medium transition-colors disabled:opacity-50"
            >
              {exiting ? (
                <>
                  <span className="animate-spin">⏳</span>
                  Exiting...
                </>
              ) : (
                <>
                  <ArrowLeft className="w-4 h-4" />
                  <span className="hidden sm:inline">Return to</span>
                  <Shield className="w-4 h-4" />
                  <span>Platform Admin</span>
                </>
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
