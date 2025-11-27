"use client";

import { useState } from "react";
import { CheckCircle, Pencil, X } from "lucide-react";

type Props = {
  shopId: number;
  currentLocationId: string;
  action: (formData: FormData) => Promise<void>;
};

export default function CarfaxAdminForm({ shopId, currentLocationId, action }: Props) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(currentLocationId);
  const [displayValue, setDisplayValue] = useState(currentLocationId);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    
    const trimmedValue = value.trim();
    const formData = new FormData();
    formData.set("shopId", String(shopId));
    formData.set("locationId", trimmedValue);
    
    await action(formData);
    
    setDisplayValue(trimmedValue);
    setSaving(false);
    setSaved(true);
    setEditing(false);
    setTimeout(() => setSaved(false), 2000);
  };

  if (!editing) {
    return (
      <div className="flex items-center gap-2">
        {displayValue && (
          <code className="text-xs bg-gray-100 px-2 py-1 rounded text-gray-700">
            {displayValue}
          </code>
        )}
        {saved && (
          <span className="flex items-center gap-1 text-xs text-green-600">
            <CheckCircle className="w-3 h-3" />
            Saved
          </span>
        )}
        <button
          onClick={() => {
            setValue(displayValue);
            setEditing(true);
          }}
          className="p-1.5 text-gray-500 hover:text-blue-600 hover:bg-blue-50 rounded transition-colors"
          title="Edit Location ID"
        >
          <Pencil className="w-4 h-4" />
        </button>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="flex items-center gap-2">
      <input
        type="text"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="Enter Location ID"
        className="w-40 text-sm border border-gray-300 rounded-lg px-3 py-1.5 focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
        autoFocus
      />
      <button
        type="submit"
        disabled={saving}
        className="px-3 py-1.5 text-sm font-medium bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50"
      >
        {saving ? "..." : "Save"}
      </button>
      <button
        type="button"
        onClick={() => {
          setEditing(false);
          setValue(displayValue);
        }}
        className="p-1.5 text-gray-500 hover:text-gray-700 hover:bg-gray-100 rounded transition-colors"
      >
        <X className="w-4 h-4" />
      </button>
    </form>
  );
}
