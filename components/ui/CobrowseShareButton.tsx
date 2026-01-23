"use client";

import { useState, useEffect } from "react";
import { Monitor, X, Copy, Check, Loader2 } from "lucide-react";

declare global {
  interface Window {
    CobrowseIO: any;
  }
}

interface CobrowseShareButtonProps {
  ticketId?: string;
  userEmail?: string;
  shopId?: string;
}

export function CobrowseShareButton({ ticketId, userEmail, shopId }: CobrowseShareButtonProps) {
  const [isLoading, setIsLoading] = useState(true);
  const [sessionCode, setSessionCode] = useState<string | null>(null);
  const [isSharing, setIsSharing] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const loadCobrowse = async () => {
      try {
        const res = await fetch("/api/cobrowse/config");
        const data = await res.json();
        
        if (!data.licenseKey) {
          setError("Remote support not configured");
          setIsLoading(false);
          return;
        }

        if (typeof window !== "undefined" && !window.CobrowseIO) {
          const script = document.createElement("script");
          script.src = "https://js.cobrowse.io/CobrowseIO.js";
          script.async = true;
          script.crossOrigin = "anonymous";
          
          script.onload = () => {
            window.CobrowseIO.license = data.licenseKey;
            window.CobrowseIO.customData = {
              user_email: userEmail || "unknown",
              ticket_id: ticketId || "none",
              shop_id: shopId || "none"
            };
            window.CobrowseIO.start();
            setIsLoading(false);
          };
          
          script.onerror = () => {
            setError("Failed to load screen sharing");
            setIsLoading(false);
          };
          
          document.head.appendChild(script);
        } else if (window.CobrowseIO) {
          window.CobrowseIO.customData = {
            user_email: userEmail || "unknown",
            ticket_id: ticketId || "none",
            shop_id: shopId || "none"
          };
          setIsLoading(false);
        }
      } catch (err) {
        setError("Failed to initialize");
        setIsLoading(false);
      }
    };

    loadCobrowse();
  }, [ticketId, userEmail, shopId]);

  const startSession = async () => {
    if (!window.CobrowseIO) return;
    
    try {
      const code = await window.CobrowseIO.createSessionCode();
      setSessionCode(code);
      setIsSharing(true);
    } catch (err) {
      setError("Failed to start session");
    }
  };

  const endSession = () => {
    if (window.CobrowseIO?.currentSession) {
      window.CobrowseIO.currentSession.end();
    }
    setSessionCode(null);
    setIsSharing(false);
  };

  const copyCode = () => {
    if (sessionCode) {
      navigator.clipboard.writeText(sessionCode);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  if (error) {
    return (
      <div className="text-sm text-gray-500 flex items-center gap-2">
        <Monitor className="w-4 h-4" />
        <span>{error}</span>
      </div>
    );
  }

  if (isLoading) {
    return (
      <button disabled className="flex items-center gap-2 px-4 py-2 bg-gray-100 text-gray-400 rounded-lg text-sm">
        <Loader2 className="w-4 h-4 animate-spin" />
        Loading...
      </button>
    );
  }

  if (isSharing && sessionCode) {
    return (
      <div className="bg-green-50 border border-green-200 rounded-lg p-4">
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-2 text-green-700">
            <Monitor className="w-5 h-5" />
            <span className="font-medium">Screen Sharing Ready</span>
          </div>
          <button
            onClick={endSession}
            className="p-1 text-green-600 hover:text-green-800 hover:bg-green-100 rounded"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
        <p className="text-sm text-green-600 mb-3">
          Share this code with the support team:
        </p>
        <div className="flex items-center gap-2">
          <div className="flex-1 bg-white border border-green-300 rounded px-4 py-2 text-center">
            <span className="text-2xl font-mono font-bold tracking-wider text-green-800">
              {sessionCode}
            </span>
          </div>
          <button
            onClick={copyCode}
            className="p-2 bg-green-600 text-white rounded hover:bg-green-700 transition-colors"
          >
            {copied ? <Check className="w-5 h-5" /> : <Copy className="w-5 h-5" />}
          </button>
        </div>
        <p className="text-xs text-green-600 mt-2">
          The admin will be able to see your screen once they enter this code.
        </p>
      </div>
    );
  }

  return (
    <button
      onClick={startSession}
      className="flex items-center gap-2 px-4 py-2 bg-purple-600 text-white rounded-lg hover:bg-purple-700 transition-colors text-sm font-medium"
    >
      <Monitor className="w-4 h-4" />
      Share My Screen
    </button>
  );
}
