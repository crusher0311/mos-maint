"use client";

import { useState } from "react";
import { Plus, Loader2, Check, AlertCircle } from "lucide-react";

type Props = {
  vin: string;
  serviceKey: string;
  cannedJobId: string;
  cannedJobTitle: string;
};

export function AddToROButton({ vin, serviceKey, cannedJobId, cannedJobTitle }: Props) {
  const [status, setStatus] = useState<"idle" | "loading" | "success" | "error">("idle");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  async function handleClick() {
    if (status === "loading" || status === "success") return;

    setStatus("loading");
    setErrorMsg(null);

    try {
      const res = await fetch("/api/protractor/apply-canned-job", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ vin, cannedJobId }),
      });

      const data = await res.json();

      if (res.ok && data.success) {
        setStatus("success");
      } else {
        setStatus("error");
        setErrorMsg(data.error || "Failed to add to RO");
      }
    } catch (err: any) {
      setStatus("error");
      setErrorMsg(err.message || "Network error");
    }
  }

  if (status === "success") {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-1 rounded-full bg-green-100 text-green-700 text-xs font-medium">
        <Check className="w-3 h-3" />
        Added
      </span>
    );
  }

  if (status === "error") {
    return (
      <span
        className="inline-flex items-center gap-1 px-2 py-1 rounded-full bg-red-100 text-red-700 text-xs font-medium cursor-pointer"
        title={errorMsg || "Error"}
        onClick={handleClick}
      >
        <AlertCircle className="w-3 h-3" />
        Retry
      </span>
    );
  }

  return (
    <button
      onClick={handleClick}
      disabled={status === "loading"}
      className="inline-flex items-center gap-1 px-2 py-1 rounded-full bg-blue-600 text-white text-xs font-medium hover:bg-blue-700 transition-colors disabled:opacity-50"
      title={`Add "${cannedJobTitle}" to work order`}
    >
      {status === "loading" ? (
        <Loader2 className="w-3 h-3 animate-spin" />
      ) : (
        <Plus className="w-3 h-3" />
      )}
      Add to RO
    </button>
  );
}
