"use client";

import { useState, useEffect, useRef } from "react";
import { Plus, Loader2, Check, AlertCircle, ChevronDown, X } from "lucide-react";

type CannedJobOption = {
  id: string;
  title: string;
};

type Props = {
  vin: string;
  serviceKey: string;
  cannedJobOptions: CannedJobOption[];
};

export function AddToROButton({ vin, serviceKey, cannedJobOptions }: Props) {
  const [status, setStatus] = useState<"idle" | "loading" | "success" | "error" | "needsRO">("idle");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [showDropdown, setShowDropdown] = useState(false);
  const [appliedJobTitle, setAppliedJobTitle] = useState<string | null>(null);
  const [manualRONumber, setManualRONumber] = useState("");
  const [pendingJob, setPendingJob] = useState<CannedJobOption | null>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setShowDropdown(false);
        if (status === "needsRO") {
          setStatus("idle");
          setPendingJob(null);
        }
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [status]);

  useEffect(() => {
    if (status === "needsRO" && inputRef.current) {
      inputRef.current.focus();
    }
  }, [status]);

  async function handleApply(cannedJobId: string, cannedJobTitle: string, workOrderId?: string) {
    if (status === "loading" || status === "success") return;

    setStatus("loading");
    setErrorMsg(null);
    setShowDropdown(false);

    try {
      const body: Record<string, string> = { vin, cannedJobId };
      if (workOrderId) {
        body.workOrderId = workOrderId;
      }

      const res = await fetch("/api/protractor/apply-canned-job", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(body),
      });

      const data = await res.json();

      if (res.ok && data.success) {
        setStatus("success");
        setAppliedJobTitle(cannedJobTitle);
        setManualRONumber("");
        setPendingJob(null);
      } else if (data.requiresManualEntry) {
        setStatus("needsRO");
        setPendingJob({ id: cannedJobId, title: cannedJobTitle });
        setErrorMsg(null);
      } else {
        setStatus("error");
        setErrorMsg(data.error || "Failed to add to RO");
      }
    } catch (err: unknown) {
      setStatus("error");
      setErrorMsg(err instanceof Error ? err.message : "Network error");
    }
  }

  function handleSubmitManualRO() {
    if (!pendingJob || !manualRONumber.trim()) return;
    handleApply(pendingJob.id, pendingJob.title, manualRONumber.trim());
  }

  if (!cannedJobOptions || cannedJobOptions.length === 0) {
    return null;
  }

  if (status === "success") {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-1 rounded-full bg-green-100 text-green-700 text-xs font-medium">
        <Check className="w-3 h-3" />
        Added{appliedJobTitle ? `: ${appliedJobTitle}` : ""}
      </span>
    );
  }

  if (status === "needsRO") {
    return (
      <div className="relative" ref={dropdownRef}>
        <div className="absolute bottom-full left-0 mb-1 w-64 bg-white border border-gray-200 rounded-lg shadow-lg z-50 p-3">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs text-gray-600 font-medium">Enter RO Number</span>
            <button
              onClick={() => {
                setStatus("idle");
                setPendingJob(null);
                setManualRONumber("");
              }}
              className="text-gray-400 hover:text-gray-600"
            >
              <X className="w-3 h-3" />
            </button>
          </div>
          <div className="flex gap-2">
            <input
              ref={inputRef}
              type="text"
              value={manualRONumber}
              onChange={(e) => setManualRONumber(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleSubmitManualRO();
              }}
              placeholder="e.g. 12345"
              className="flex-1 px-2 py-1 text-sm border border-gray-300 rounded focus:outline-none focus:ring-1 focus:ring-blue-500"
            />
            <button
              onClick={handleSubmitManualRO}
              disabled={!manualRONumber.trim()}
              className="px-3 py-1 bg-blue-600 text-white text-sm rounded hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Add
            </button>
          </div>
          <p className="text-xs text-gray-500 mt-2">
            Adding: {pendingJob?.title}
          </p>
        </div>
        <span className="inline-flex items-center gap-1 px-2 py-1 rounded-full bg-yellow-100 text-yellow-700 text-xs font-medium">
          Enter RO #
        </span>
      </div>
    );
  }

  if (status === "error") {
    return (
      <span
        className="inline-flex items-center gap-1 px-2 py-1 rounded-full bg-red-100 text-red-700 text-xs font-medium cursor-pointer"
        title={errorMsg || "Error"}
        onClick={() => {
          setStatus("idle");
          setErrorMsg(null);
        }}
      >
        <AlertCircle className="w-3 h-3" />
        Retry
      </span>
    );
  }

  if (cannedJobOptions.length === 1) {
    const job = cannedJobOptions[0];
    return (
      <button
        onClick={() => handleApply(job.id, job.title)}
        disabled={status === "loading"}
        className="inline-flex items-center gap-1 px-2 py-1 rounded-full bg-blue-600 text-white text-xs font-medium hover:bg-blue-700 transition-colors disabled:opacity-50"
        title={`Add "${job.title}" to work order`}
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

  return (
    <div className="relative" ref={dropdownRef}>
      <button
        onClick={() => setShowDropdown(!showDropdown)}
        disabled={status === "loading"}
        className="inline-flex items-center gap-1 px-2 py-1 rounded-full bg-blue-600 text-white text-xs font-medium hover:bg-blue-700 transition-colors disabled:opacity-50"
      >
        {status === "loading" ? (
          <Loader2 className="w-3 h-3 animate-spin" />
        ) : (
          <Plus className="w-3 h-3" />
        )}
        Add to RO
        <ChevronDown className="w-3 h-3" />
      </button>

      {showDropdown && (
        <div className="absolute top-full left-0 mt-1 w-64 bg-white border border-gray-200 rounded-lg shadow-lg z-50">
          <div className="p-2 border-b border-gray-100">
            <span className="text-xs text-gray-500 font-medium">Select service package to apply:</span>
          </div>
          <div className="max-h-48 overflow-y-auto">
            {cannedJobOptions.map((job) => (
              <button
                key={job.id}
                onClick={() => handleApply(job.id, job.title)}
                className="w-full text-left px-3 py-2 text-sm text-gray-700 hover:bg-blue-50 hover:text-blue-700 transition-colors"
              >
                {job.title}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
