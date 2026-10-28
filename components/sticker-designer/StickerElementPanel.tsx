"use client";

import { useState } from "react";
import { StickerTextColorInput } from "./StickerTextColorInput";
import { StickerElement, MAX_STICKER_ELEMENTS, MAX_CUSTOM_TEXT_ELEMENTS, MAX_STICKER_TEXT_LENGTH, MAX_STICKER_BORDER_WIDTH } from "@/lib/sticker-designer-types";
import { ChevronDown, ChevronRight, Eye, EyeOff, Type, Image as ImageIcon, QrCode, Plus, Trash2 } from "lucide-react";

interface StickerElementPanelProps {
  elements: StickerElement[];
  selectedId: string | null;
  onSelectElement: (id: string) => void;
  onUpdateElement: (id: string, updates: Partial<StickerElement>) => void;
  onAddText: () => void;
  onAddViscosity?: () => void;
  onRemoveText: (id: string) => void;
}

export function StickerElementPanel({
  elements,
  selectedId,
  onSelectElement,
  onUpdateElement,
  onAddText,
  onAddViscosity,
  onRemoveText,
}: StickerElementPanelProps) {
  const [expandedSections, setExpandedSections] = useState<Record<string, boolean>>({
    elements: true,
    styling: true,
    advanced: false,
  });

  const toggleSection = (section: string) => {
    setExpandedSections((prev) => ({ ...prev, [section]: !prev[section] }));
  };

  const selectedElement = elements.find((el) => el.id === selectedId);
  const customCount = elements.filter((element) => element.type === "text").length;
  const addDisabled = customCount >= MAX_CUSTOM_TEXT_ELEMENTS || elements.length >= MAX_STICKER_ELEMENTS;
  const colorValue = (value: string | undefined, fallback = "#000000") =>
    value && /^#[0-9a-f]{6}$/i.test(value) ? value : fallback;

  const getElementIcon = (type: string) => {
    switch (type) {
      case "logo":
        return <ImageIcon size={14} />;
      case "qrCode":
        return <QrCode size={14} />;
      default:
        return <Type size={14} />;
    }
  };

  return (
    <div className="w-72 bg-white rounded-lg border border-gray-200 shadow-sm overflow-hidden">
      <div
        className="flex items-center justify-between px-3 py-2 bg-gray-50 border-b cursor-pointer hover:bg-gray-100"
        onClick={() => toggleSection("elements")}
      >
        <h3 className="text-sm font-medium text-gray-700">Elements</h3>
        {expandedSections.elements ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
      </div>

      <div className="px-3 py-2 border-b space-y-1">
        <button type="button" onClick={onAddViscosity}
          disabled={elements.length >= MAX_STICKER_ELEMENTS || elements.some(e => e.type === "oilViscosity")}
          className="w-full px-2 py-1 text-xs border rounded disabled:opacity-50">Add Oil viscosity</button>
        <button
          type="button"
          onClick={onAddText}
          disabled={addDisabled}
          className="w-full flex items-center justify-center gap-2 px-2 py-1 text-xs border rounded hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <Plus size={14} /> Add custom text
        </button>
        <p className="text-xs text-gray-500" role="status">
          {customCount}/{MAX_CUSTOM_TEXT_ELEMENTS} custom · {elements.length}/{MAX_STICKER_ELEMENTS} total
          {addDisabled && " — element limit reached"}
        </p>
      </div>
      
      {expandedSections.elements && (
        <div className="p-2 border-b max-h-48 overflow-y-auto">
          {elements.map((element) => (
            <div
              key={element.id}
              className={`flex items-center justify-between p-2 rounded cursor-pointer text-sm ${
                selectedId === element.id ? "bg-blue-50 text-blue-700" : "hover:bg-gray-50"
              }`}
              onClick={() => onSelectElement(element.id)}
            >
              <div className="flex items-center gap-2 min-w-0">
                {getElementIcon(element.type)}
                <span className={`truncate ${!element.visible ? "text-gray-400" : ""}`} title={element.type === "text" ? element.content : element.label}>{element.type === "text" ? element.content || "Custom Text" : element.label}</span>
              </div>
              <button
                type="button"
                aria-label={`${element.visible ? "Hide" : "Show"} ${element.label}`}
                className="p-1 hover:bg-gray-200 rounded"
                onClick={(e) => {
                  e.stopPropagation();
                  onUpdateElement(element.id, { visible: !element.visible });
                }}
              >
                {element.visible ? <Eye size={14} /> : <EyeOff size={14} className="text-gray-400" />}
              </button>
            </div>
          ))}
        </div>
      )}

      {selectedElement && (
        <>
          <div
            className="flex items-center justify-between px-3 py-2 bg-gray-50 border-b cursor-pointer hover:bg-gray-100"
            onClick={() => toggleSection("styling")}
          >
            <h3 className="text-sm font-medium text-gray-700">Styling: {selectedElement.label}</h3>
            {expandedSections.styling ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
          </div>
          
          {expandedSections.styling && (
            <div className="p-3 space-y-3 border-b">
              {selectedElement.type === "oilViscosity" && <div className="text-xs text-gray-500">
                Filled per print, never saved as a shop default. Move this element into a free area of your layout.
                <button type="button" className="block text-red-700 underline" onClick={() => onRemoveText(selectedElement.id)}>Remove Oil viscosity</button>
              </div>}
              {selectedElement.type !== "logo" && selectedElement.type !== "qrCode" && (
                <>
                  <div>
                    <label className="block text-xs text-gray-500 mb-1">Font Size</label>
                    <input
                      type="range"
                      min={8}
                      max={36}
                      value={selectedElement.fontSize}
                      onChange={(e) => onUpdateElement(selectedElement.id, { fontSize: parseInt(e.target.value) })}
                      className="w-full"
                    />
                    <span className="text-xs text-gray-500">{selectedElement.fontSize}px</span>
                  </div>
                  
                  <div className="flex gap-2">
                    <button
                      type="button"
                      aria-label="Bold"
                      aria-pressed={selectedElement.fontWeight === "bold"}
                      className={`px-3 py-1 text-sm border rounded ${selectedElement.fontWeight === "bold" ? "bg-blue-100 border-blue-300" : ""}`}
                      onClick={() => onUpdateElement(selectedElement.id, { fontWeight: selectedElement.fontWeight === "bold" ? "normal" : "bold" })}
                    >
                      <strong>B</strong>
                    </button>
                    <button
                      type="button"
                      aria-label="Italic"
                      aria-pressed={selectedElement.fontStyle === "italic"}
                      className={`px-3 py-1 text-sm border rounded ${selectedElement.fontStyle === "italic" ? "bg-blue-100 border-blue-300" : ""}`}
                      onClick={() => onUpdateElement(selectedElement.id, { fontStyle: selectedElement.fontStyle === "italic" ? "normal" : "italic" })}
                    >
                      <em>I</em>
                    </button>
                    <button
                      type="button"
                      aria-label="Underline"
                      aria-pressed={!!selectedElement.underline}
                      className={`px-3 py-1 text-sm border rounded ${selectedElement.underline ? "bg-blue-100 border-blue-300" : ""}`}
                      onClick={() => onUpdateElement(selectedElement.id, { underline: !selectedElement.underline })}
                    >
                      <span className="underline">U</span>
                    </button>
                  </div>
                  
                  <div>
                    <label className="block text-xs text-gray-500 mb-1">Text Align</label>
                    <div className="flex gap-1">
                      {(["left", "center", "right"] as const).map((align) => (
                        <button
                          key={align}
                          className={`flex-1 px-2 py-1 text-xs border rounded capitalize ${selectedElement.textAlign === align ? "bg-blue-100 border-blue-300" : ""}`}
                          onClick={() => onUpdateElement(selectedElement.id, { textAlign: align })}
                        >
                          {align}
                        </button>
                      ))}
                    </div>
                  </div>
                  
                  <div>
                    <label className="block text-xs text-gray-500 mb-1">Text Color</label>
                    <div className="flex items-center gap-2">
                      <input
                        type="color"
                        aria-label="Text color"
                        value={colorValue(selectedElement.color)}
                        onChange={(e) => onUpdateElement(selectedElement.id, { color: e.target.value })}
                        className="w-8 h-8 rounded border cursor-pointer"
                      />
                      <StickerTextColorInput
                        key={selectedElement.id}
                        value={selectedElement.color}
                        onChange={(color) => onUpdateElement(selectedElement.id, { color })}
                      />
                    </div>
                  </div>
                </>
              )}

              {selectedElement.type !== "logo" && selectedElement.type !== "qrCode" && (
              <>
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <label className="flex items-center gap-2 text-xs text-gray-600">
                    <input
                      type="checkbox"
                      checked={!!selectedElement.backgroundColor && selectedElement.backgroundColor !== "transparent"}
                      onChange={(e) => onUpdateElement(selectedElement.id, { backgroundColor: e.target.checked ? "#ffffff" : undefined })}
                    />
                    Background
                  </label>
                  {selectedElement.backgroundColor && selectedElement.backgroundColor !== "transparent" && (
                    <button type="button" className="text-xs text-blue-700 hover:underline" onClick={() => onUpdateElement(selectedElement.id, { backgroundColor: undefined })}>Clear background</button>
                  )}
                </div>
                {selectedElement.backgroundColor && selectedElement.backgroundColor !== "transparent" && (
                  <input type="color" aria-label="Background color" value={colorValue(selectedElement.backgroundColor, "#ffffff")} onChange={(e) => onUpdateElement(selectedElement.id, { backgroundColor: e.target.value })} className="w-8 h-8 rounded border cursor-pointer" />
                )}
              </div>

              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <label className="flex items-center gap-2 text-xs text-gray-600">
                    <input
                      type="checkbox"
                      checked={!!selectedElement.borderColor && selectedElement.borderColor !== "transparent" && (selectedElement.borderWidth ?? 0) > 0}
                      onChange={(e) => onUpdateElement(selectedElement.id, e.target.checked ? { borderColor: "#000000", borderWidth: 1 } : { borderColor: undefined, borderWidth: undefined })}
                    />
                    Border
                  </label>
                  {selectedElement.borderColor && (selectedElement.borderWidth ?? 0) > 0 && (
                    <button type="button" className="text-xs text-blue-700 hover:underline" onClick={() => onUpdateElement(selectedElement.id, { borderColor: undefined, borderWidth: undefined })}>Clear border</button>
                  )}
                </div>
                {selectedElement.borderColor && selectedElement.borderColor !== "transparent" && (selectedElement.borderWidth ?? 0) > 0 && (
                  <div className="flex items-center gap-2">
                    <input type="color" aria-label="Border color" value={colorValue(selectedElement.borderColor)} onChange={(e) => onUpdateElement(selectedElement.id, { borderColor: e.target.value })} className="w-8 h-8 rounded border cursor-pointer" />
                    <label className="flex-1 text-xs text-gray-500">
                      Thickness (px)
                      <input
                        type="number"
                        aria-label="Border thickness"
                        min={0.5}
                        max={MAX_STICKER_BORDER_WIDTH}
                        step={0.5}
                        value={selectedElement.borderWidth}
                        onChange={(e) => {
                          if (!e.target.value) return;
                          const value = Number(e.target.value);
                          if (Number.isFinite(value)) onUpdateElement(selectedElement.id, { borderWidth: Math.min(MAX_STICKER_BORDER_WIDTH, Math.max(0.5, Math.round(value * 2) / 2)) });
                        }}
                        className="w-full px-2 py-1 text-sm border rounded"
                      />
                    </label>
                  </div>
                )}
              </div>
              </>
              )}

              {selectedElement.type === "logo" && (
                <div>
                  <label className="block text-xs text-gray-500 mb-1">Image Fit</label>
                  <div className="flex gap-1">
                    {(["contain", "cover"] as const).map((fit) => (
                      <button
                        key={fit}
                        className={`flex-1 px-2 py-1 text-xs border rounded capitalize ${selectedElement.imageFit === fit ? "bg-blue-100 border-blue-300" : ""}`}
                        onClick={() => onUpdateElement(selectedElement.id, { imageFit: fit })}
                      >
                        {fit}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {selectedElement.type === "text" && (
                <div>
                  <label htmlFor="sticker-element-content" className="block text-xs text-gray-500 mb-1">Custom Text</label>
                  <input
                    id="sticker-element-content"
                    type="text"
                    maxLength={MAX_STICKER_TEXT_LENGTH}
                    value={selectedElement.content || ""}
                    onChange={(e) => onUpdateElement(selectedElement.id, { content: e.target.value.replace(/[\r\n\u2028\u2029]/g, " ").slice(0, MAX_STICKER_TEXT_LENGTH) })}
                    placeholder="Enter text"
                    className="w-full px-2 py-1 text-sm border rounded"
                  />
                  <p className="text-xs text-gray-500 mt-1">{(selectedElement.content || "").length}/{MAX_STICKER_TEXT_LENGTH} characters · single line</p>
                  {selectedElement.type === "text" && (
                    <button type="button" className="flex items-center gap-1 mt-2 text-xs text-red-700 hover:underline" onClick={() => {
                      if (window.confirm("Remove this custom text? You can undo this change.")) onRemoveText(selectedElement.id);
                    }}>
                      <Trash2 size={13} /> Remove custom text
                    </button>
                  )}
                </div>
              )}
            </div>
          )}

          <div
            className="flex items-center justify-between px-3 py-2 bg-gray-50 cursor-pointer hover:bg-gray-100"
            onClick={() => toggleSection("advanced")}
          >
            <h3 className="text-sm font-medium text-gray-700">Position & Size</h3>
            {expandedSections.advanced ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
          </div>
          
          {expandedSections.advanced && (
            <div className="p-3 grid grid-cols-2 gap-2">
              <div>
                <label className="block text-xs text-gray-500">X</label>
                <input
                  type="number"
                  value={selectedElement.x}
                  onChange={(e) => onUpdateElement(selectedElement.id, { x: parseInt(e.target.value) || 0 })}
                  className="w-full px-2 py-1 text-sm border rounded"
                />
              </div>
              <div>
                <label className="block text-xs text-gray-500">Y</label>
                <input
                  type="number"
                  value={selectedElement.y}
                  onChange={(e) => onUpdateElement(selectedElement.id, { y: parseInt(e.target.value) || 0 })}
                  className="w-full px-2 py-1 text-sm border rounded"
                />
              </div>
              <div>
                <label className="block text-xs text-gray-500">Width</label>
                <input
                  type="number"
                  value={selectedElement.width}
                  onChange={(e) => onUpdateElement(selectedElement.id, { width: parseInt(e.target.value) || 30 })}
                  className="w-full px-2 py-1 text-sm border rounded"
                />
              </div>
              <div>
                <label className="block text-xs text-gray-500">Height</label>
                <input
                  type="number"
                  value={selectedElement.height}
                  onChange={(e) => onUpdateElement(selectedElement.id, { height: parseInt(e.target.value) || 15 })}
                  className="w-full px-2 py-1 text-sm border rounded"
                />
              </div>
            </div>
          )}
        </>
      )}

      {!selectedElement && (
        <div className="p-4 text-center text-sm text-gray-500">
          Select an element to edit its properties
        </div>
      )}
    </div>
  );
}
