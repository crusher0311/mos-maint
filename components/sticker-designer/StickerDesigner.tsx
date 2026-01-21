"use client";

import { useState, useCallback, useEffect } from "react";
import { 
  StickerLayout, 
  StickerElement, 
  createDefaultLayout, 
  scaleLayoutToSize,
  getStickerSize,
  DEFAULT_STICKER_SIZE 
} from "@/lib/sticker-designer-types";
import { StickerDesignerCanvas } from "./StickerDesignerCanvas";
import { StickerElementPanel } from "./StickerElementPanel";
import { StickerToolbarPanel } from "./StickerToolbarPanel";

interface StickerContentData {
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
  contentData?: StickerContentData;
  onChange?: (layout: StickerLayout, size: string) => void;
}

interface HistoryState {
  layout: StickerLayout;
  size: string;
}

export function StickerDesigner({
  initialLayout,
  initialSize = DEFAULT_STICKER_SIZE,
  logoUrl,
  qrUrl,
  contentData,
  onChange,
}: StickerDesignerProps) {
  const [currentSize, setCurrentSize] = useState(initialSize);
  const [layout, setLayout] = useState<StickerLayout>(() => {
    if (initialLayout) {
      return initialLayout;
    }
    return createDefaultLayout(initialSize);
  });
  
  const [history, setHistory] = useState<HistoryState[]>([{ layout, size: currentSize }]);
  const [historyIndex, setHistoryIndex] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const canUndo = historyIndex > 0;
  const canRedo = historyIndex < history.length - 1;

  const pushHistory = useCallback((newLayout: StickerLayout, newSize: string) => {
    setHistory((prev) => {
      const newHistory = prev.slice(0, historyIndex + 1);
      newHistory.push({ layout: newLayout, size: newSize });
      if (newHistory.length > 50) {
        newHistory.shift();
        return newHistory;
      }
      return newHistory;
    });
    setHistoryIndex((prev) => Math.min(prev + 1, 49));
  }, [historyIndex]);

  const handleUndo = useCallback(() => {
    if (canUndo) {
      const prevState = history[historyIndex - 1];
      setHistoryIndex(historyIndex - 1);
      setLayout(prevState.layout);
      setCurrentSize(prevState.size);
      onChange?.(prevState.layout, prevState.size);
    }
  }, [canUndo, history, historyIndex, onChange]);

  const handleRedo = useCallback(() => {
    if (canRedo) {
      const nextState = history[historyIndex + 1];
      setHistoryIndex(historyIndex + 1);
      setLayout(nextState.layout);
      setCurrentSize(nextState.size);
      onChange?.(nextState.layout, nextState.size);
    }
  }, [canRedo, history, historyIndex, onChange]);

  const handleUpdateElement = useCallback((id: string, updates: Partial<StickerElement>) => {
    setLayout((prev) => {
      const newLayout = {
        ...prev,
        elements: prev.elements.map((el) =>
          el.id === id ? { ...el, ...updates } : el
        ),
      };
      pushHistory(newLayout, currentSize);
      onChange?.(newLayout, currentSize);
      return newLayout;
    });
  }, [currentSize, pushHistory, onChange]);

  const handleSizeChange = useCallback((newSize: string) => {
    const scaledLayout = scaleLayoutToSize(layout, newSize);
    setCurrentSize(newSize);
    setLayout(scaledLayout);
    pushHistory(scaledLayout, newSize);
    onChange?.(scaledLayout, newSize);
  }, [layout, pushHistory, onChange]);

  const handleToggleGrid = useCallback(() => {
    setLayout((prev) => {
      const newLayout = { ...prev, showGrid: !prev.showGrid };
      onChange?.(newLayout, currentSize);
      return newLayout;
    });
  }, [currentSize, onChange]);

  const handleGridSizeChange = useCallback((gridSize: number) => {
    setLayout((prev) => {
      const newLayout = { ...prev, gridSize };
      onChange?.(newLayout, currentSize);
      return newLayout;
    });
  }, [currentSize, onChange]);

  const handleBackgroundColorChange = useCallback((color: string) => {
    setLayout((prev) => {
      const newLayout = { ...prev, backgroundColor: color };
      pushHistory(newLayout, currentSize);
      onChange?.(newLayout, currentSize);
      return newLayout;
    });
  }, [currentSize, pushHistory, onChange]);

  const handleReset = useCallback(() => {
    const newLayout = createDefaultLayout(currentSize);
    setLayout(newLayout);
    setSelectedId(null);
    pushHistory(newLayout, currentSize);
    onChange?.(newLayout, currentSize);
  }, [currentSize, pushHistory, onChange]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "z") {
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
            layout={layout}
            selectedId={selectedId}
            onSelectElement={setSelectedId}
            onUpdateElement={handleUpdateElement}
            logoUrl={logoUrl}
            qrUrl={qrUrl}
            contentData={contentData}
          />
        </div>
        
        <div className="flex-shrink-0">
          <StickerElementPanel
            elements={layout.elements}
            selectedId={selectedId}
            onSelectElement={setSelectedId}
            onUpdateElement={handleUpdateElement}
          />
        </div>
      </div>
    </div>
  );
}
