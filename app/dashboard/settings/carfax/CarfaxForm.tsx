// app/dashboard/settings/carfax/CarfaxForm.tsx
"use client";

import { useState } from "react";
import { CheckCircle } from "lucide-react";

type Props = {
  shopId: number;
  initial: { locationId: string };
  onSavedLabel?: string;
  action: (formData: FormData) => Promise<void>;
};

export default function CarfaxForm({ shopId, initial, action, onSavedLabel = "Saved!" }: Props) {
  const [loc, setLoc] = useState(initial.locationId || "");
  const [pending, setPending] = useState(false);
  const [done, setDone] = useState(false);

  return (
    <form
      action={async (fd) => {
        setPending(true);
        setDone(false);
        fd.set("shopId", String(shopId));
        await action(fd);
        setPending(false);
        setDone(true);
        setTimeout(() => setDone(false), 3000);
      }}
      className="space-y-4"
    >
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-2">
          Location ID
        </label>
        <input
          name="locationId"
          value={loc}
          onChange={(e) => setLoc(e.target.value)}
          className="w-full border border-gray-300 rounded-lg px-4 py-2.5 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
          placeholder="e.g. U4K2O3YEOX"
          autoComplete="off"
        />
        <p className="mt-1.5 text-xs text-gray-500">
          This is the unique identifier CARFAX assigned to your shop location.
        </p>
      </div>

      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={pending}
          className="px-4 py-2 text-sm font-medium rounded-lg bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50 transition-colors"
        >
          {pending ? "Saving..." : "Save Location ID"}
        </button>
        {done && (
          <span className="flex items-center gap-1.5 text-sm text-green-600 font-medium">
            <CheckCircle className="w-4 h-4" />
            {onSavedLabel}
          </span>
        )}
      </div>
    </form>
  );
}
