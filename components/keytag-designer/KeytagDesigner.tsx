"use client";

import { useState, useCallback, useRef, useEffect } from "react";
import {
  DesignerElement,
  DesignerLayout,
  DEFAULT_LAYOUT,
  SAMPLE_DATA,
  DYMO_30252,
} from "@/lib/keytag-designer-types";
import { DesignerCanvas } from "./DesignerCanvas";
import { ElementPanel } from "./ElementPanel";
import { ToolbarPanel } from "./ToolbarPanel";
import { Undo2, Redo2, Grid3X3, Save, Download, RotateCcw, Loader2 } from "lucide-react";

interface KeytagDesignerProps {
  initialLayout?: DesignerLayout;
  onSave: (layout: DesignerLayout) => Promise<void>;
  onDownload: (layout: DesignerLayout) => Promise<void>;
}

interface HistoryState {
  past: DesignerLayout[];
  present: DesignerLayout;
  future: DesignerLayout[];
}

export function KeytagDesigner({ initialLayout, onSave, onDownload }: KeytagDesignerProps) {
  const [history, setHistory] = useState<HistoryState>({
    past: [],
    present: initialLayout || DEFAULT_LAYOUT,
    future: [],
  });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const layout = history.present;

  const pushHistory = useCallback((newLayout: DesignerLayout) => {
    setHistory((prev) => ({
      past: [...prev.past.slice(-50), prev.present],
      present: newLayout,
      future: [],
    }));
  }, []);

  const updateLayout = useCallback((updates: Partial<DesignerLayout>) => {
    pushHistory({ ...layout, ...updates });
  }, [layout, pushHistory]);

  const updateElement = useCallback((id: string, updates: Partial<DesignerElement>) => {
    const newElements = layout.elements.map((el) =>
      el.id === id ? { ...el, ...updates } : el
    );
    pushHistory({ ...layout, elements: newElements });
  }, [layout, pushHistory]);

  const undo = useCallback(() => {
    setHistory((prev) => {
      if (prev.past.length === 0) return prev;
      const newPast = [...prev.past];
      const newPresent = newPast.pop()!;
      return {
        past: newPast,
        present: newPresent,
        future: [prev.present, ...prev.future],
      };
    });
  }, []);

  const redo = useCallback(() => {
    setHistory((prev) => {
      if (prev.future.length === 0) return prev;
      const newFuture = [...prev.future];
      const newPresent = newFuture.shift()!;
      return {
        past: [...prev.past, prev.present],
        present: newPresent,
        future: newFuture,
      };
    });
  }, []);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "z") {
        e.preventDefault();
        if (e.shiftKey) {
          redo();
        } else {
          undo();
        }
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [undo, redo]);

  const handleSave = async () => {
    setSaving(true);
    try {
      await onSave(layout);
    } finally {
      setSaving(false);
    }
  };

  const handleReset = () => {
    pushHistory(DEFAULT_LAYOUT);
    setSelectedId(null);
  };

  const selectedElement = layout.elements.find((el) => el.id === selectedId);

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between p-4 border-b bg-white">
        <div className="flex items-center gap-2">
          <button
            onClick={undo}
            disabled={history.past.length === 0}
            className="p-2 rounded hover:bg-gray-100 disabled:opacity-30 disabled:cursor-not-allowed"
            title="Undo (Ctrl+Z)"
          >
            <Undo2 className="w-5 h-5" />
          </button>
          <button
            onClick={redo}
            disabled={history.future.length === 0}
            className="p-2 rounded hover:bg-gray-100 disabled:opacity-30 disabled:cursor-not-allowed"
            title="Redo (Ctrl+Shift+Z)"
          >
            <Redo2 className="w-5 h-5" />
          </button>
          <div className="w-px h-6 bg-gray-300 mx-2" />
          <button
            onClick={() => updateLayout({ showGrid: !layout.showGrid })}
            className={`p-2 rounded ${layout.showGrid ? "bg-blue-100 text-blue-600" : "hover:bg-gray-100"}`}
            title="Toggle Grid"
          >
            <Grid3X3 className="w-5 h-5" />
          </button>
          <select
            value={layout.gridSize}
            onChange={(e) => updateLayout({ gridSize: parseInt(e.target.value) })}
            className="px-2 py-1 border rounded text-sm"
          >
            <option value="5">5px Grid</option>
            <option value="10">10px Grid</option>
            <option value="20">20px Grid</option>
          </select>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={handleReset}
            className="px-3 py-1.5 text-sm text-gray-600 hover:text-gray-800 flex items-center gap-1.5"
          >
            <RotateCcw className="w-4 h-4" />
            Reset
          </button>
          <button
            onClick={() => onDownload(layout)}
            className="px-3 py-1.5 text-sm bg-gray-100 hover:bg-gray-200 rounded flex items-center gap-1.5"
          >
            <Download className="w-4 h-4" />
            Download
          </button>
          <button
            onClick={handleSave}
            disabled={saving}
            className="px-4 py-1.5 bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50 flex items-center gap-1.5"
          >
            {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
            Save
          </button>
        </div>
      </div>

      <div className="flex flex-1 overflow-hidden">
        <div className="flex-1 p-6 bg-gray-100 overflow-auto flex items-center justify-center">
          <DesignerCanvas
            layout={layout}
            selectedId={selectedId}
            onSelectElement={setSelectedId}
            onUpdateElement={updateElement}
          />
        </div>
        <div className="w-72 bg-white border-l overflow-y-auto">
          {selectedElement ? (
            <ElementPanel
              element={selectedElement}
              onUpdate={(updates) => updateElement(selectedElement.id, updates)}
              textColor={layout.textColor}
            />
          ) : (
            <ToolbarPanel
              layout={layout}
              onUpdateLayout={updateLayout}
            />
          )}
        </div>
      </div>

      <div className="p-2 text-center text-xs text-gray-500 border-t bg-white">
        Canvas: {DYMO_30252.actualWidth}" × {DYMO_30252.actualHeight}" (Dymo 30252) | 
        Click element to select, drag to move, drag corners to resize
      </div>
    </div>
  );
}
