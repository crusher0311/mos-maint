"use client";

import { StickerLayout, STICKER_SIZES, getStickerSize, scaleLayoutToSize } from "@/lib/sticker-designer-types";
import { Undo2, Redo2, Grid3x3, RotateCcw } from "lucide-react";

interface StickerToolbarPanelProps {
  layout: StickerLayout;
  currentSize: string;
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
  onSizeChange: (size: string) => void;
  onToggleGrid: () => void;
  onGridSizeChange: (size: number) => void;
  onReset: () => void;
  onBackgroundColorChange: (color: string) => void;
}

export function StickerToolbarPanel({
  layout,
  currentSize,
  canUndo,
  canRedo,
  onUndo,
  onRedo,
  onSizeChange,
  onToggleGrid,
  onGridSizeChange,
  onReset,
  onBackgroundColorChange,
}: StickerToolbarPanelProps) {
  return (
    <div className="flex flex-wrap items-center gap-4 p-3 bg-white rounded-lg border border-gray-200 shadow-sm">
      <div className="flex items-center gap-2">
        <button
          onClick={onUndo}
          disabled={!canUndo}
          className={`p-2 rounded hover:bg-gray-100 ${!canUndo ? "opacity-40 cursor-not-allowed" : ""}`}
          title="Undo (Ctrl+Z)"
        >
          <Undo2 size={18} />
        </button>
        <button
          onClick={onRedo}
          disabled={!canRedo}
          className={`p-2 rounded hover:bg-gray-100 ${!canRedo ? "opacity-40 cursor-not-allowed" : ""}`}
          title="Redo (Ctrl+Shift+Z)"
        >
          <Redo2 size={18} />
        </button>
      </div>

      <div className="h-6 w-px bg-gray-300" />

      <div className="flex items-center gap-2">
        <label className="text-sm text-gray-600">Size:</label>
        <select
          value={currentSize}
          onChange={(e) => onSizeChange(e.target.value)}
          className="px-2 py-1 text-sm border rounded bg-white"
        >
          {STICKER_SIZES.map((size) => (
            <option key={size.value} value={size.value}>
              {size.label}
            </option>
          ))}
        </select>
      </div>

      <div className="h-6 w-px bg-gray-300" />

      <div className="flex items-center gap-2">
        <button
          onClick={onToggleGrid}
          className={`p-2 rounded ${layout.showGrid ? "bg-blue-100 text-blue-700" : "hover:bg-gray-100"}`}
          title="Toggle Grid"
        >
          <Grid3x3 size={18} />
        </button>
        {layout.showGrid && (
          <select
            value={layout.gridSize}
            onChange={(e) => onGridSizeChange(parseInt(e.target.value))}
            className="px-2 py-1 text-sm border rounded bg-white"
          >
            <option value={5}>5px</option>
            <option value={10}>10px</option>
            <option value={20}>20px</option>
          </select>
        )}
      </div>

      <div className="h-6 w-px bg-gray-300" />

      <div className="flex items-center gap-2">
        <label className="text-sm text-gray-600">Background:</label>
        <input
          type="color"
          value={layout.backgroundColor}
          onChange={(e) => onBackgroundColorChange(e.target.value)}
          className="w-8 h-8 rounded border cursor-pointer"
        />
      </div>

      <div className="h-6 w-px bg-gray-300" />

      <button
        onClick={onReset}
        className="flex items-center gap-1 px-3 py-1 text-sm text-gray-600 hover:bg-gray-100 rounded"
        title="Reset to Default"
      >
        <RotateCcw size={14} />
        Reset
      </button>
    </div>
  );
}
