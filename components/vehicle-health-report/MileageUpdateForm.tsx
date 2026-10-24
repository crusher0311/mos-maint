"use client";

import React, { useId, useRef, useState } from "react";

interface MileageUpdateFormProps {
  distanceUnit: "miles" | "kilometers";
  onUpdateMileage: (mileage: number) => Promise<void>;
}

export default function MileageUpdateForm({ distanceUnit, onUpdateMileage }: MileageUpdateFormProps) {
  const inputId = useId();
  const submitting = useRef(false);
  const [mileage, setMileage] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting.current) return;
    setError("");
    setStatus("");
    const value = Number(mileage);
    if (!/^\d+$/.test(mileage.trim()) || !Number.isInteger(value) || value < 101 || value > 999999) {
      setError("Enter a whole number between 101 and 999,999.");
      return;
    }
    submitting.current = true;
    setBusy(true);
    setStatus("Updating mileage and refreshing your report…");
    try {
      await onUpdateMileage(value);
      setStatus("Mileage updated. Your report has been refreshed.");
    } catch (err) {
      setStatus("");
      setError(err instanceof Error ? err.message : "Unable to update mileage. Please try again.");
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} noValidate aria-busy={busy} className="mt-3 print:hidden">
      <label htmlFor={inputId} className="block text-xs font-semibold text-gray-700">
        Update your mileage (optional)
      </label>
      <p id={`${inputId}-help`} className="text-xs text-gray-500 mt-1">
        Enter your current odometer reading in {distanceUnit}.
      </p>
      <div className="flex flex-col sm:flex-row gap-2 mt-2">
        <input
          id={inputId}
          type="number"
          inputMode="numeric"
          min={101}
          max={999999}
          step={1}
          value={mileage}
          disabled={busy}
          aria-invalid={!!error}
          aria-describedby={`${inputId}-help${error ? ` ${inputId}-error` : ""}`}
          onChange={(event) => {
            setMileage(event.target.value);
            setError("");
            setStatus("");
          }}
          className="w-full sm:w-44 rounded-md border border-gray-300 px-3 py-2 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-[#1e3a5f] disabled:opacity-60"
        />
        <button
          type="submit"
          disabled={busy || !mileage.trim()}
          className="rounded-md bg-[#1e3a5f] px-4 py-2 text-sm font-semibold text-white hover:bg-[#2a4f7a] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#1e3a5f] disabled:opacity-60 disabled:cursor-not-allowed"
        >
          {busy ? "Updating…" : "Update mileage"}
        </button>
      </div>
      {error && <p id={`${inputId}-error`} role="alert" className="mt-2 text-xs text-red-700">{error}</p>}
      <p role="status" aria-live="polite" aria-atomic="true" className="mt-2 text-xs text-gray-600">{status}</p>
    </form>
  );
}
