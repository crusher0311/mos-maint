"use client";

import { DesignerLayout, DYMO_30252 } from "@/lib/keytag-designer-types";
import { Palette, LayoutGrid, Info } from "lucide-react";

interface ToolbarPanelProps {
  layout: DesignerLayout;
  onUpdateLayout: (updates: Partial<DesignerLayout>) => void;
}

export function ToolbarPanel({ layout, onUpdateLayout }: ToolbarPanelProps) {
  return (
    <div className="p-4 space-y-6">
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

      <div>
        <div className="flex items-center gap-2 pb-3 border-b mb-4">
          <Info className="w-5 h-5 text-blue-600" />
          <h3 className="font-semibold text-gray-900">Canvas Info</h3>
        </div>
        <div className="text-sm text-gray-600 space-y-1">
          <p><span className="font-medium">Label:</span> Dymo 30252</p>
          <p><span className="font-medium">Size:</span> {DYMO_30252.actualWidth}" × {DYMO_30252.actualHeight}"</p>
          <p><span className="font-medium">Resolution:</span> {DYMO_30252.dpi} DPI</p>
          <p><span className="font-medium">Output:</span> {DYMO_30252.renderWidth} × {DYMO_30252.renderHeight}px</p>
        </div>
      </div>

      <div className="p-3 bg-blue-50 rounded-lg border border-blue-100">
        <h4 className="text-sm font-medium text-blue-900 mb-2">Tips</h4>
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
