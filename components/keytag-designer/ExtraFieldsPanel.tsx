"use client";

import { Plus } from "lucide-react";
import type { DesignerElement, DesignerLayout } from "@/lib/keytag-designer-types";

export function ExtraFieldsPanel({ layout, onAdd }: {
  layout: DesignerLayout;
  onAdd: (element: DesignerElement) => void;
}) {
  const customCount = layout.elements.filter(element => element.type === "custom").length;
  const add = (type: "vehicleColor" | "licensePlate" | "custom") => {
    if (type === "custom" ? customCount >= 3 : layout.elements.some(element => element.type === type)) return;
    const width = Math.min(180, layout.canvasWidth);
    const height = Math.min(22, layout.canvasHeight);
    onAdd({
      id: type === "custom" ? `custom_${crypto.randomUUID()}` : type,
      type,
      label: type === "vehicleColor" ? "Color" : type === "licensePlate" ? "License Plate" : "Custom Field",
      x: Math.min(10, Math.max(0, layout.canvasWidth - width)),
      y: Math.max(0, Math.min(layout.canvasHeight - height, 20 + layout.elements.length * 15)),
      width, height, fontSize: 12, fontWeight: "normal", fontStyle: "normal",
      textAlign: "left", showLabel: true, visible: true,
    });
  };
  return (
    <div className="mt-4 space-y-2 border-t pt-3">
      <p className="text-xs text-gray-500">Optional print details. Hidden custom fields still count toward the limit of three.</p>
      {(["vehicleColor", "licensePlate", "custom"] as const).map(type => (
        <button key={type} type="button" onClick={() => add(type)}
          disabled={type === "custom" ? customCount >= 3 : layout.elements.some(element => element.type === type)}
          className="flex w-full items-center gap-2 rounded border px-3 py-2 text-left text-sm text-gray-700 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-40">
          <Plus className="h-4 w-4" />
          {type === "vehicleColor" ? "Vehicle color" : type === "licensePlate" ? "License plate" : `Custom field (${customCount}/3)`}
        </button>
      ))}
    </div>
  );
}
