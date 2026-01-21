"use client";

import { useState } from "react";
import { StickerElement } from "@/lib/sticker-designer-types";
import { ChevronDown, ChevronRight, Eye, EyeOff, Type, Image as ImageIcon, QrCode } from "lucide-react";

interface StickerElementPanelProps {
  elements: StickerElement[];
  selectedId: string | null;
  onSelectElement: (id: string) => void;
  onUpdateElement: (id: string, updates: Partial<StickerElement>) => void;
}

export function StickerElementPanel({
  elements,
  selectedId,
  onSelectElement,
  onUpdateElement,
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
              <div className="flex items-center gap-2">
                {getElementIcon(element.type)}
                <span className={!element.visible ? "text-gray-400" : ""}>{element.label}</span>
              </div>
              <button
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
                      className={`px-3 py-1 text-sm border rounded ${selectedElement.fontWeight === "bold" ? "bg-blue-100 border-blue-300" : ""}`}
                      onClick={() => onUpdateElement(selectedElement.id, { fontWeight: selectedElement.fontWeight === "bold" ? "normal" : "bold" })}
                    >
                      <strong>B</strong>
                    </button>
                    <button
                      className={`px-3 py-1 text-sm border rounded ${selectedElement.fontStyle === "italic" ? "bg-blue-100 border-blue-300" : ""}`}
                      onClick={() => onUpdateElement(selectedElement.id, { fontStyle: selectedElement.fontStyle === "italic" ? "normal" : "italic" })}
                    >
                      <em>I</em>
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
                        value={selectedElement.color}
                        onChange={(e) => onUpdateElement(selectedElement.id, { color: e.target.value })}
                        className="w-8 h-8 rounded border cursor-pointer"
                      />
                      <input
                        type="text"
                        value={selectedElement.color}
                        onChange={(e) => onUpdateElement(selectedElement.id, { color: e.target.value })}
                        className="flex-1 px-2 py-1 text-sm border rounded"
                      />
                    </div>
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

              {selectedElement.type === "serviceLabel" && (
                <div>
                  <label className="block text-xs text-gray-500 mb-1">Label Text</label>
                  <input
                    type="text"
                    value={selectedElement.content || ""}
                    onChange={(e) => onUpdateElement(selectedElement.id, { content: e.target.value })}
                    placeholder="Next Oil Service"
                    className="w-full px-2 py-1 text-sm border rounded"
                  />
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
