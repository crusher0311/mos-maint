"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import { 
  StickerLayout, 
  StickerElement, 
  createDefaultLayout, 
  scaleLayoutToSize,
  DEFAULT_STICKER_SIZE,
  MAX_STICKER_ELEMENTS,
  MAX_CUSTOM_TEXT_ELEMENTS,
  MAX_STICKER_TEXT_LENGTH,
  MAX_STICKER_BORDER_WIDTH,
} from "@/lib/sticker-designer-types";
import { StickerDesignerCanvas } from "./StickerDesignerCanvas";
import { StickerElementPanel } from "./StickerElementPanel";
import { StickerToolbarPanel } from "./StickerToolbarPanel";

interface StickerContentData {
  oilViscosity?: string;
  phone?: string;
  tagline?: string;
  taglineLine2?: string;
  serviceLabel?: string;
  serviceDate?: string;
  serviceMileage?: string;
}

interface StickerDesignerProps {
  initialLayout?: StickerLayout;
  initialSize?: string;
  logoUrl?: string;
  qrUrl?: string;
  showQRCode?: boolean;
  contentData?: StickerContentData;
  onChange?: (layout: StickerLayout, size: string) => void;
}

interface HistoryState {
  layout: StickerLayout;
  size: string;
  selectedId: string | null;
}

export function StickerDesigner({
  initialLayout,
  initialSize = DEFAULT_STICKER_SIZE,
  logoUrl,
  qrUrl,
  showQRCode = true,
  contentData,
  onChange,
}: StickerDesignerProps) {
  const [editor, setEditor] = useState(() => {
    const initial: HistoryState = {
      layout: initialLayout || createDefaultLayout(initialSize),
      size: initialSize,
      selectedId: null,
    };
    return { current: initial, history: [initial], index: 0 };
  });
  // Event handlers read the latest snapshot even when React batches several edits.
  // Notifications never run inside state updaters (which Strict Mode can replay).
  const editorRef = useRef(editor);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const { layout, size: currentSize, selectedId } = editor.current;
  const canUndo = editor.index > 0;
  const canRedo = editor.index < editor.history.length - 1;

  const commit = useCallback((current: HistoryState, record = true, notify = true) => {
    const previous = editorRef.current;
    let history = previous.history.slice();
    let index = previous.index;
    if (record) {
      history = [...history.slice(0, index + 1), current].slice(-50);
      index = history.length - 1;
    } else {
      history[index] = current;
    }
    const next = { current, history, index };
    editorRef.current = next;
    setEditor(next);
    if (notify) onChangeRef.current?.(current.layout, current.size);
  }, []);

  const navigateHistory = useCallback((direction: number) => {
    const previous = editorRef.current;
    const index = previous.index + direction;
    if (index < 0 || index >= previous.history.length) return;
    const current = previous.history[index];
    const next = { ...previous, current, index };
    editorRef.current = next;
    setEditor(next);
    onChangeRef.current?.(current.layout, current.size);
  }, []);
  const handleUndo = useCallback(() => navigateHistory(-1), [navigateHistory]);
  const handleRedo = useCallback(() => navigateHistory(1), [navigateHistory]);
  const handleSelectElement = useCallback((id: string | null) => {
    const current = editorRef.current.current;
    if (id !== null && !current.layout.elements.some((element) => element.id === id)) return;
    commit({ ...current, selectedId: id }, false, false);
  }, [commit]);

  const handleUpdateElement = useCallback((id: string, updates: Partial<StickerElement>) => {
    const current = editorRef.current.current;
    const element = current.layout.elements.find((item) => item.id === id);
    if (!element) return;
    const safeUpdates = { ...updates };
    if (typeof safeUpdates.content === "string") {
      safeUpdates.content = safeUpdates.content.replace(/[\r\n\u2028\u2029]/g, " ").slice(0, MAX_STICKER_TEXT_LENGTH);
    }
    if (typeof safeUpdates.borderWidth === "number") {
      if (!Number.isFinite(safeUpdates.borderWidth)) return;
      safeUpdates.borderWidth = Math.min(MAX_STICKER_BORDER_WIDTH, Math.max(0.5, Math.round(safeUpdates.borderWidth * 2) / 2));
    }
    if (Object.entries(safeUpdates).every(([key, value]) => element[key as keyof StickerElement] === value)) return;
    commit({
      ...current,
      layout: { ...current.layout, elements: current.layout.elements.map((item) => item.id === id ? { ...item, ...safeUpdates } : item) },
    });
  }, [commit]);

  const handleAddText = useCallback(() => {
    const current = editorRef.current.current;
    const { elements, canvasWidth, canvasHeight } = current.layout;
    if (elements.length >= MAX_STICKER_ELEMENTS || elements.filter((element) => element.type === "text").length >= MAX_CUSTOM_TEXT_ELEMENTS) return;
    const id = `custom-text-${crypto.randomUUID()}`;
    const width = Math.min(120, canvasWidth);
    const height = Math.min(20, canvasHeight);
    const element: StickerElement = {
      id, type: "text", label: "Custom Text", content: "Custom text",
      x: Math.max(0, Math.round((canvasWidth - width) / 2)),
      y: Math.max(0, Math.round((canvasHeight - height) / 2)),
      width, height, fontSize: 12, fontWeight: "normal", fontStyle: "normal",
      textAlign: "center", color: "#000000", visible: true,
    };
    commit({ ...current, selectedId: id, layout: { ...current.layout, elements: [...elements, element] } });
  }, [commit]);

  const handleAddViscosity = useCallback(() => {
    const current = editorRef.current.current;
    if (current.layout.elements.length >= MAX_STICKER_ELEMENTS || current.layout.elements.some(e => e.type === "oilViscosity")) return;
    const element: StickerElement = {
      id: `viscosity-${crypto.randomUUID()}`, type: "oilViscosity", label: "Oil viscosity",
      x: 5, y: 85, width: Math.min(130, current.layout.canvasWidth - 10), height: 20,
      fontSize: 12, fontWeight: "bold", fontStyle: "normal", textAlign: "left", color: "#000000", visible: true,
    };
    commit({ ...current, selectedId: element.id, layout: { ...current.layout, elements: [...current.layout.elements, element] } });
  }, [commit]);

  const handleRemoveText = useCallback((id: string) => {
    const current = editorRef.current.current;
    const element = current.layout.elements.find((item) => item.id === id);
    if (element?.type !== "text" && element?.type !== "oilViscosity") return;
    commit({
      ...current,
      selectedId: current.selectedId === id ? null : current.selectedId,
      layout: { ...current.layout, elements: current.layout.elements.filter((item) => item.id !== id) },
    });
  }, [commit]);

  const handleSizeChange = useCallback((newSize: string) => {
    const current = editorRef.current.current;
    if (newSize === current.size) return;
    commit({ ...current, size: newSize, layout: scaleLayoutToSize(current.layout, newSize) });
  }, [commit]);

  const handleToggleGrid = useCallback(() => {
    const current = editorRef.current.current;
    commit({ ...current, layout: { ...current.layout, showGrid: !current.layout.showGrid } }, false);
  }, [commit]);

  const handleGridSizeChange = useCallback((gridSize: number) => {
    const current = editorRef.current.current;
    commit({ ...current, layout: { ...current.layout, gridSize } }, false);
  }, [commit]);

  const handleBackgroundColorChange = useCallback((color: string) => {
    const current = editorRef.current.current;
    if (color === current.layout.backgroundColor) return;
    commit({ ...current, layout: { ...current.layout, backgroundColor: color } });
  }, [commit]);

  const handleReset = useCallback(() => {
    const current = editorRef.current.current;
    commit({ ...current, layout: createDefaultLayout(current.size), selectedId: null });
  }, [commit]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const target = e.target;
      if (target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
        if (e.shiftKey) {
          e.preventDefault();
          handleRedo();
        } else {
          e.preventDefault();
          handleUndo();
        }
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [handleUndo, handleRedo]);

  return (
    <div className="space-y-4">
      <StickerToolbarPanel
        layout={layout}
        currentSize={currentSize}
        canUndo={canUndo}
        canRedo={canRedo}
        onUndo={handleUndo}
        onRedo={handleRedo}
        onSizeChange={handleSizeChange}
        onToggleGrid={handleToggleGrid}
        onGridSizeChange={handleGridSizeChange}
        onReset={handleReset}
        onBackgroundColorChange={handleBackgroundColorChange}
      />
      
      <div className="flex gap-6 items-start">
        <div className="flex-shrink-0">
          <StickerDesignerCanvas
            size={currentSize}
            layout={layout}
            selectedId={selectedId}
            onSelectElement={handleSelectElement}
            onUpdateElement={handleUpdateElement}
            logoUrl={logoUrl}
            qrUrl={qrUrl}
            showQRCode={showQRCode}
            contentData={contentData}
          />
        </div>
        
        <div className="flex-shrink-0">
          <StickerElementPanel
            elements={layout.elements}
            selectedId={selectedId}
            onSelectElement={handleSelectElement}
            onUpdateElement={handleUpdateElement}
            onAddText={handleAddText}
            onAddViscosity={handleAddViscosity}
            onRemoveText={handleRemoveText}
          />
        </div>
      </div>
    </div>
  );
}
