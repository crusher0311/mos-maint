"use client";

import { useState } from "react";
import { Plus, Loader2, Check, AlertCircle } from "lucide-react";

type DeferredItem = {
  key: string;
  title: string;
  protractorDeferredId?: string;
};

type Props = {
  items: DeferredItem[];
  workOrderGuid: string;
  vin: string;
};

export function AddAllDeferredButton({ items, workOrderGuid, vin }: Props) {
  const [status, setStatus] = useState<"idle" | "adding" | "done" | "error">("idle");
  const [progress, setProgress] = useState({ current: 0, total: 0 });
  const [error, setError] = useState<string | null>(null);

  const itemsWithDeferredId = items.filter(i => i.protractorDeferredId);

  if (itemsWithDeferredId.length === 0) return null;

  const handleAddAll = async () => {
    setStatus("adding");
    setProgress({ current: 0, total: itemsWithDeferredId.length });
    setError(null);

    let successCount = 0;

    for (let i = 0; i < itemsWithDeferredId.length; i++) {
      const item = itemsWithDeferredId[i];
      setProgress({ current: i + 1, total: itemsWithDeferredId.length });

      try {
        const res = await fetch("/api/jobs/add-deferred", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            workOrderGuid,
            serviceTitle: item.title,
            vin,
            protractorDeferredId: item.protractorDeferredId,
          }),
        });

        if (res.ok) {
          successCount++;
        }
      } catch (err) {
        console.error(`Failed to add ${item.title}:`, err);
      }
    }

    if (successCount === itemsWithDeferredId.length) {
      setStatus("done");
    } else if (successCount > 0) {
      setStatus("done");
    } else {
      setStatus("error");
      setError("Failed to add items");
    }
  };

  if (status === "done") {
    return (
      <span className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg bg-green-100 text-green-700 text-xs font-medium">
        <Check className="w-3 h-3" />
        Added {itemsWithDeferredId.length} items
      </span>
    );
  }

  if (status === "error") {
    return (
      <span className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg bg-red-100 text-red-700 text-xs font-medium">
        <AlertCircle className="w-3 h-3" />
        {error}
      </span>
    );
  }

  return (
    <button
      onClick={handleAddAll}
      disabled={status === "adding"}
      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-blue-600 text-white text-xs font-medium hover:bg-blue-700 transition-colors disabled:opacity-50"
    >
      {status === "adding" ? (
        <>
          <Loader2 className="w-3 h-3 animate-spin" />
          Adding {progress.current}/{progress.total}...
        </>
      ) : (
        <>
          <Plus className="w-3 h-3" />
          Add All ({itemsWithDeferredId.length})
        </>
      )}
    </button>
  );
}
