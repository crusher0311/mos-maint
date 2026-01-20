"use client";

import { DesignerElement } from "@/lib/keytag-designer-types";
import { Eye, EyeOff, Bold, Italic, AlignLeft, AlignCenter, AlignRight, Tag } from "lucide-react";

interface ElementPanelProps {
  element: DesignerElement;
  onUpdate: (updates: Partial<DesignerElement>) => void;
  textColor: string;
}

export function ElementPanel({ element, onUpdate, textColor }: ElementPanelProps) {
  return (
    <div className="p-4 space-y-4">
      <div className="flex items-center gap-2 pb-3 border-b">
        <Tag className="w-5 h-5 text-blue-600" />
        <h3 className="font-semibold text-gray-900">{element.label}</h3>
        <button
          onClick={() => onUpdate({ visible: !element.visible })}
          className={`ml-auto p-1.5 rounded ${element.visible ? "text-gray-600 hover:bg-gray-100" : "text-red-500 bg-red-50"}`}
          title={element.visible ? "Hide element" : "Show element"}
        >
          {element.visible ? <Eye className="w-4 h-4" /> : <EyeOff className="w-4 h-4" />}
        </button>
      </div>

      <div>
        <label className="block text-sm font-medium text-gray-700 mb-2">Position</label>
        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className="text-xs text-gray-500">X</label>
            <input
              type="number"
              value={Math.round(element.x)}
              onChange={(e) => onUpdate({ x: parseInt(e.target.value) || 0 })}
              className="w-full px-2 py-1 text-sm border rounded"
            />
          </div>
          <div>
            <label className="text-xs text-gray-500">Y</label>
            <input
              type="number"
              value={Math.round(element.y)}
              onChange={(e) => onUpdate({ y: parseInt(e.target.value) || 0 })}
              className="w-full px-2 py-1 text-sm border rounded"
            />
          </div>
        </div>
      </div>

      <div>
        <label className="block text-sm font-medium text-gray-700 mb-2">Size</label>
        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className="text-xs text-gray-500">Width</label>
            <input
              type="number"
              value={Math.round(element.width)}
              onChange={(e) => onUpdate({ width: parseInt(e.target.value) || 30 })}
              min={30}
              className="w-full px-2 py-1 text-sm border rounded"
            />
          </div>
          <div>
            <label className="text-xs text-gray-500">Height</label>
            <input
              type="number"
              value={Math.round(element.height)}
              onChange={(e) => onUpdate({ height: parseInt(e.target.value) || 15 })}
              min={15}
              className="w-full px-2 py-1 text-sm border rounded"
            />
          </div>
        </div>
      </div>

      <div>
        <label className="block text-sm font-medium text-gray-700 mb-2">Font Size</label>
        <input
          type="range"
          min={8}
          max={36}
          value={element.fontSize}
          onChange={(e) => onUpdate({ fontSize: parseInt(e.target.value) })}
          className="w-full"
        />
        <div className="flex justify-between text-xs text-gray-500 mt-1">
          <span>8px</span>
          <span className="font-medium text-gray-900">{element.fontSize}px</span>
          <span>36px</span>
        </div>
      </div>

      <div>
        <label className="block text-sm font-medium text-gray-700 mb-2">Font Style</label>
        <div className="flex gap-1">
          <button
            onClick={() => onUpdate({ fontWeight: element.fontWeight === "bold" ? "normal" : "bold" })}
            className={`flex-1 p-2 rounded border ${
              element.fontWeight === "bold"
                ? "bg-blue-100 border-blue-300 text-blue-700"
                : "border-gray-200 text-gray-600 hover:bg-gray-50"
            }`}
          >
            <Bold className="w-4 h-4 mx-auto" />
          </button>
          <button
            onClick={() => onUpdate({ fontStyle: element.fontStyle === "italic" ? "normal" : "italic" })}
            className={`flex-1 p-2 rounded border ${
              element.fontStyle === "italic"
                ? "bg-blue-100 border-blue-300 text-blue-700"
                : "border-gray-200 text-gray-600 hover:bg-gray-50"
            }`}
          >
            <Italic className="w-4 h-4 mx-auto" />
          </button>
        </div>
      </div>

      <div>
        <label className="block text-sm font-medium text-gray-700 mb-2">Alignment</label>
        <div className="flex gap-1">
          <button
            onClick={() => onUpdate({ textAlign: "left" })}
            className={`flex-1 p-2 rounded border ${
              element.textAlign === "left"
                ? "bg-blue-100 border-blue-300 text-blue-700"
                : "border-gray-200 text-gray-600 hover:bg-gray-50"
            }`}
          >
            <AlignLeft className="w-4 h-4 mx-auto" />
          </button>
          <button
            onClick={() => onUpdate({ textAlign: "center" })}
            className={`flex-1 p-2 rounded border ${
              element.textAlign === "center"
                ? "bg-blue-100 border-blue-300 text-blue-700"
                : "border-gray-200 text-gray-600 hover:bg-gray-50"
            }`}
          >
            <AlignCenter className="w-4 h-4 mx-auto" />
          </button>
          <button
            onClick={() => onUpdate({ textAlign: "right" })}
            className={`flex-1 p-2 rounded border ${
              element.textAlign === "right"
                ? "bg-blue-100 border-blue-300 text-blue-700"
                : "border-gray-200 text-gray-600 hover:bg-gray-50"
            }`}
          >
            <AlignRight className="w-4 h-4 mx-auto" />
          </button>
        </div>
      </div>

      <div>
        <label className="flex items-center gap-2 text-sm cursor-pointer">
          <input
            type="checkbox"
            checked={element.showLabel}
            onChange={(e) => onUpdate({ showLabel: e.target.checked })}
            className="rounded"
          />
          <span className="text-gray-700">Show label (e.g., "VIN:")</span>
        </label>
      </div>

      <div className="pt-3 border-t">
        <p className="text-xs text-gray-500">
          Preview shows sample data. Actual keytags will display real customer and vehicle information.
        </p>
      </div>
    </div>
  );
}
