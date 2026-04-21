"use client";

import { useEffect, useRef, useState } from "react";
import { DesignerLayout, DesignerElement } from "@/lib/keytag-designer-types";
import {
  PAPER_SIZE_PRESETS,
  resolvePaperSize,
  SUPPORTED_DPI_OPTIONS,
  type PaperSizeConfig,
} from "@/lib/keytag-paper-sizes";
import { Palette, LayoutGrid, Info, Layers, Eye, EyeOff, Printer } from "lucide-react";

interface ToolbarPanelProps {
  layout: DesignerLayout;
  onUpdateLayout: (updates: Partial<DesignerLayout>) => void;
  onUpdateElement: (id: string, updates: Partial<DesignerElement>) => void;
  onSelectElement: (id: string) => void;
  onChangePaperSize: (next: PaperSizeConfig) => void;
}

type CustomCfg = NonNullable<PaperSizeConfig["custom"]>;

const DEFAULT_CUSTOM: CustomCfg = { width: 3.5, height: 1.125, units: "in", dpi: 300 };

export function ToolbarPanel({
  layout,
  onUpdateLayout,
  onUpdateElement,
  onSelectElement,
  onChangePaperSize,
}: ToolbarPanelProps) {
  const resolved = resolvePaperSize(layout.paperSize);
  const currentId = layout.paperSize?.presetId || resolved.id;
  const isCustom = currentId === "custom";

  // Remember the last custom config the user authored so toggling preset → custom restores it.
  const lastCustomRef = useRef<CustomCfg>(layout.paperSize?.custom || DEFAULT_CUSTOM);
  useEffect(() => {
    if (layout.paperSize?.custom) {
      lastCustomRef.current = layout.paperSize.custom;
    }
  }, [layout.paperSize?.custom]);

  // Local draft state so width/height edits do not commit (and rescale) on every keystroke.
  const committedCustom = layout.paperSize?.custom || lastCustomRef.current;
  const [draftWidth, setDraftWidth] = useState<string>(String(committedCustom.width));
  const [draftHeight, setDraftHeight] = useState<string>(String(committedCustom.height));

  // Re-sync drafts when committed custom values change from outside (e.g., undo, preset switch back to custom).
  useEffect(() => {
    setDraftWidth(String(committedCustom.width));
    setDraftHeight(String(committedCustom.height));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [committedCustom.width, committedCustom.height, currentId]);

  const onPresetChange = (newId: string) => {
    if (newId === "custom") {
      onChangePaperSize({ presetId: "custom", custom: lastCustomRef.current });
    } else {
      // Preserve the user's last custom config alongside the preset selection.
      onChangePaperSize({ presetId: newId, custom: lastCustomRef.current });
    }
  };

  const commitCustom = (patch: Partial<CustomCfg>) => {
    const base: CustomCfg = layout.paperSize?.custom || lastCustomRef.current;
    const next: CustomCfg = { ...base, ...patch };
    lastCustomRef.current = next;
    onChangePaperSize({ presetId: "custom", custom: next });
  };

  const commitDraftDimensions = () => {
    const w = parseFloat(draftWidth);
    const h = parseFloat(draftHeight);
    if (!Number.isFinite(w) || !Number.isFinite(h)) return;
    const base = layout.paperSize?.custom || lastCustomRef.current;
    if (w === base.width && h === base.height) return;
    commitCustom({ width: w, height: h });
  };

  const onUnitsChange = (newUnits: "in" | "mm") => {
    const base = layout.paperSize?.custom || lastCustomRef.current;
    if (base.units === newUnits) return;
    // Convert numeric values so the physical size stays the same.
    const factor = base.units === "in" && newUnits === "mm" ? 25.4 : 1 / 25.4;
    const w = +(base.width * factor).toFixed(3);
    const h = +(base.height * factor).toFixed(3);
    commitCustom({ units: newUnits, width: w, height: h });
  };

  return (
    <div className="p-4 space-y-6">
      <div>
        <div className="flex items-center gap-2 pb-3 border-b mb-4">
          <Printer className="w-5 h-5 text-blue-600" />
          <h3 className="font-semibold text-gray-900">Paper / Label Size</h3>
        </div>
        <div className="space-y-3">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Preset</label>
            <select
              value={currentId}
              onChange={(e) => onPresetChange(e.target.value)}
              className="w-full px-2 py-1 text-sm border rounded"
            >
              {PAPER_SIZE_PRESETS.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
              <option value="custom">Custom…</option>
            </select>
          </div>

          {isCustom && (
            <div className="space-y-2 p-3 bg-gray-50 rounded border border-gray-200">
              <div className="flex gap-2">
                <div className="flex-1">
                  <label className="block text-xs font-medium text-gray-600 mb-1">Width</label>
                  <input
                    type="number"
                    min="0.25"
                    step="0.05"
                    value={draftWidth}
                    onChange={(e) => setDraftWidth(e.target.value)}
                    onBlur={commitDraftDimensions}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.currentTarget.blur();
                      }
                    }}
                    className="w-full px-2 py-1 text-sm border rounded"
                  />
                </div>
                <div className="flex-1">
                  <label className="block text-xs font-medium text-gray-600 mb-1">Height</label>
                  <input
                    type="number"
                    min="0.25"
                    step="0.05"
                    value={draftHeight}
                    onChange={(e) => setDraftHeight(e.target.value)}
                    onBlur={commitDraftDimensions}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.currentTarget.blur();
                      }
                    }}
                    className="w-full px-2 py-1 text-sm border rounded"
                  />
                </div>
              </div>
              <div className="flex gap-2">
                <div className="flex-1">
                  <label className="block text-xs font-medium text-gray-600 mb-1">Units</label>
                  <select
                    value={committedCustom.units}
                    onChange={(e) => onUnitsChange(e.target.value as "in" | "mm")}
                    className="w-full px-2 py-1 text-sm border rounded"
                  >
                    <option value="in">Inches</option>
                    <option value="mm">Millimeters</option>
                  </select>
                </div>
                <div className="flex-1">
                  <label className="block text-xs font-medium text-gray-600 mb-1">DPI</label>
                  <select
                    value={committedCustom.dpi}
                    onChange={(e) => commitCustom({ dpi: parseInt(e.target.value, 10) })}
                    className="w-full px-2 py-1 text-sm border rounded"
                  >
                    {SUPPORTED_DPI_OPTIONS.map((d) => (
                      <option key={d} value={d}>
                        {d}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
              <p className="text-[11px] text-gray-500">
                Width &amp; height commit on Tab / Enter / blur to avoid rescaling on every keystroke.
              </p>
            </div>
          )}

          <div className="text-xs text-gray-500 pt-1">
            <p>
              <span className="font-medium">{resolved.widthIn.toFixed(3)}"</span> ×{" "}
              <span className="font-medium">{resolved.heightIn.toFixed(3)}"</span> · {resolved.dpi} DPI ·
              output {resolved.renderWidth}×{resolved.renderHeight}px
            </p>
          </div>
          <p className="text-[11px] text-amber-700 bg-amber-50 border border-amber-100 rounded p-2">
            Changing paper size automatically rescales all elements proportionally.
          </p>
        </div>
      </div>

      <div>
        <div className="flex items-center gap-2 pb-3 border-b mb-4">
          <Layers className="w-5 h-5 text-blue-600" />
          <h3 className="font-semibold text-gray-900">Elements</h3>
        </div>
        <div className="space-y-1">
          {layout.elements.map((el) => (
            <div
              key={el.id}
              className="flex items-center justify-between p-2 rounded hover:bg-gray-50 group"
            >
              <button
                onClick={() => {
                  if (!el.visible) {
                    onUpdateElement(el.id, { visible: true });
                  }
                  onSelectElement(el.id);
                }}
                className="text-sm text-gray-700 hover:text-blue-600 text-left flex-1"
              >
                {el.label}
              </button>
              <button
                onClick={() => onUpdateElement(el.id, { visible: !el.visible })}
                className={`p-1 rounded ${
                  el.visible
                    ? "text-gray-400 hover:text-gray-600 hover:bg-gray-100"
                    : "text-red-400 bg-red-50 hover:bg-red-100"
                }`}
                title={el.visible ? "Hide element" : "Show element"}
              >
                {el.visible ? <Eye className="w-4 h-4" /> : <EyeOff className="w-4 h-4" />}
              </button>
            </div>
          ))}
        </div>
      </div>

      <div>
        <div className="flex items-center gap-2 pb-3 border-b mb-4">
          <Palette className="w-5 h-5 text-blue-600" />
          <h3 className="font-semibold text-gray-900">Colors</h3>
        </div>
        <div className="space-y-3">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Text Color</label>
            <div className="flex items-center gap-2">
              <input
                type="color"
                value={layout.textColor}
                onChange={(e) => onUpdateLayout({ textColor: e.target.value })}
                className="w-10 h-10 rounded border cursor-pointer"
              />
              <input
                type="text"
                value={layout.textColor}
                onChange={(e) => onUpdateLayout({ textColor: e.target.value })}
                className="flex-1 px-2 py-1 text-sm border rounded"
              />
            </div>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Background</label>
            <div className="flex items-center gap-2">
              <input
                type="color"
                value={layout.backgroundColor}
                onChange={(e) => onUpdateLayout({ backgroundColor: e.target.value })}
                className="w-10 h-10 rounded border cursor-pointer"
              />
              <input
                type="text"
                value={layout.backgroundColor}
                onChange={(e) => onUpdateLayout({ backgroundColor: e.target.value })}
                className="flex-1 px-2 py-1 text-sm border rounded"
              />
            </div>
          </div>
        </div>
      </div>

      <div>
        <div className="flex items-center gap-2 pb-3 border-b mb-4">
          <LayoutGrid className="w-5 h-5 text-blue-600" />
          <h3 className="font-semibold text-gray-900">Grid Settings</h3>
        </div>
        <div className="space-y-3">
          <label className="flex items-center gap-2 text-sm cursor-pointer">
            <input
              type="checkbox"
              checked={layout.showGrid}
              onChange={(e) => onUpdateLayout({ showGrid: e.target.checked })}
              className="rounded"
            />
            <span className="text-gray-700">Show Grid</span>
          </label>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Grid Size</label>
            <select
              value={layout.gridSize}
              onChange={(e) => onUpdateLayout({ gridSize: parseInt(e.target.value) })}
              className="w-full px-2 py-1 text-sm border rounded"
            >
              <option value="5">5 pixels</option>
              <option value="10">10 pixels</option>
              <option value="20">20 pixels</option>
            </select>
          </div>
        </div>
      </div>

      <div className="p-3 bg-blue-50 rounded-lg border border-blue-100">
        <h4 className="text-sm font-medium text-blue-900 mb-2 flex items-center gap-1.5">
          <Info className="w-4 h-4" /> Tips
        </h4>
        <ul className="text-xs text-blue-700 space-y-1">
          <li>• Click an element to select it</li>
          <li>• Drag elements to move them</li>
          <li>• Drag corners to resize</li>
          <li>• Use Ctrl+Z to undo</li>
          <li>• Use Ctrl+Shift+Z to redo</li>
          <li>• Enable grid for precise placement</li>
        </ul>
      </div>
    </div>
  );
}
