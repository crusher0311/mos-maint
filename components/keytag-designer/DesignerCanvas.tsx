"use client";

import { useRef, useState, useCallback } from "react";
import { DesignerElement, DesignerLayout, SAMPLE_DATA, DYMO_30252 } from "@/lib/keytag-designer-types";

interface DesignerCanvasProps {
  layout: DesignerLayout;
  selectedId: string | null;
  onSelectElement: (id: string | null) => void;
  onUpdateElement: (id: string, updates: Partial<DesignerElement>) => void;
}

interface DragState {
  type: "move" | "resize";
  elementId: string;
  startX: number;
  startY: number;
  elementStartX: number;
  elementStartY: number;
  elementStartWidth: number;
  elementStartHeight: number;
  corner?: "nw" | "ne" | "sw" | "se";
}

interface AlignmentGuide {
  type: "horizontal" | "vertical";
  position: number;
}

export function DesignerCanvas({
  layout,
  selectedId,
  onSelectElement,
  onUpdateElement,
}: DesignerCanvasProps) {
  const canvasRef = useRef<HTMLDivElement>(null);
  const [dragState, setDragState] = useState<DragState | null>(null);
  const [alignmentGuides, setAlignmentGuides] = useState<AlignmentGuide[]>([]);

  const snapToGrid = useCallback((value: number) => {
    if (!layout.showGrid) return value;
    return Math.round(value / layout.gridSize) * layout.gridSize;
  }, [layout.showGrid, layout.gridSize]);

  const findAlignmentGuides = useCallback((element: DesignerElement, newX: number, newY: number) => {
    const guides: AlignmentGuide[] = [];
    const threshold = 5;
    
    const elementCenterX = newX + element.width / 2;
    const elementCenterY = newY + element.height / 2;
    const elementRight = newX + element.width;
    const elementBottom = newY + element.height;
    
    const canvasCenterX = layout.canvasWidth / 2;
    const canvasCenterY = layout.canvasHeight / 2;
    if (Math.abs(elementCenterX - canvasCenterX) < threshold) {
      guides.push({ type: "vertical", position: canvasCenterX });
    }
    if (Math.abs(elementCenterY - canvasCenterY) < threshold) {
      guides.push({ type: "horizontal", position: canvasCenterY });
    }
    
    layout.elements.forEach((other) => {
      if (other.id === element.id || !other.visible) return;
      
      const otherCenterX = other.x + other.width / 2;
      const otherCenterY = other.y + other.height / 2;
      const otherRight = other.x + other.width;
      const otherBottom = other.y + other.height;
      
      if (Math.abs(newX - other.x) < threshold) {
        guides.push({ type: "vertical", position: other.x });
      }
      if (Math.abs(elementRight - otherRight) < threshold) {
        guides.push({ type: "vertical", position: otherRight });
      }
      if (Math.abs(newX - otherRight) < threshold) {
        guides.push({ type: "vertical", position: otherRight });
      }
      if (Math.abs(elementRight - other.x) < threshold) {
        guides.push({ type: "vertical", position: other.x });
      }
      if (Math.abs(elementCenterX - otherCenterX) < threshold) {
        guides.push({ type: "vertical", position: otherCenterX });
      }
      
      if (Math.abs(newY - other.y) < threshold) {
        guides.push({ type: "horizontal", position: other.y });
      }
      if (Math.abs(elementBottom - otherBottom) < threshold) {
        guides.push({ type: "horizontal", position: otherBottom });
      }
      if (Math.abs(newY - otherBottom) < threshold) {
        guides.push({ type: "horizontal", position: otherBottom });
      }
      if (Math.abs(elementBottom - other.y) < threshold) {
        guides.push({ type: "horizontal", position: other.y });
      }
      if (Math.abs(elementCenterY - otherCenterY) < threshold) {
        guides.push({ type: "horizontal", position: otherCenterY });
      }
    });
    
    return guides;
  }, [layout.canvasWidth, layout.canvasHeight, layout.elements]);

  const handleMouseDown = useCallback((
    e: React.MouseEvent,
    elementId: string,
    type: "move" | "resize",
    corner?: "nw" | "ne" | "sw" | "se"
  ) => {
    e.stopPropagation();
    const element = layout.elements.find((el) => el.id === elementId);
    if (!element) return;
    
    onSelectElement(elementId);
    
    setDragState({
      type,
      elementId,
      startX: e.clientX,
      startY: e.clientY,
      elementStartX: element.x,
      elementStartY: element.y,
      elementStartWidth: element.width,
      elementStartHeight: element.height,
      corner,
    });
  }, [layout.elements, onSelectElement]);

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    if (!dragState || !canvasRef.current) return;
    
    const rect = canvasRef.current.getBoundingClientRect();
    const scale = rect.width / layout.canvasWidth;
    
    const deltaX = (e.clientX - dragState.startX) / scale;
    const deltaY = (e.clientY - dragState.startY) / scale;
    
    const element = layout.elements.find((el) => el.id === dragState.elementId);
    if (!element) return;
    
    if (dragState.type === "move") {
      let newX = snapToGrid(dragState.elementStartX + deltaX);
      let newY = snapToGrid(dragState.elementStartY + deltaY);
      
      newX = Math.max(0, Math.min(newX, layout.canvasWidth - element.width));
      newY = Math.max(0, Math.min(newY, layout.canvasHeight - element.height));
      
      const guides = findAlignmentGuides(element, newX, newY);
      setAlignmentGuides(guides);
      
      onUpdateElement(dragState.elementId, { x: newX, y: newY });
    } else if (dragState.type === "resize") {
      let newX = dragState.elementStartX;
      let newY = dragState.elementStartY;
      let newWidth = dragState.elementStartWidth;
      let newHeight = dragState.elementStartHeight;
      
      switch (dragState.corner) {
        case "se":
          newWidth = snapToGrid(Math.max(30, dragState.elementStartWidth + deltaX));
          newHeight = snapToGrid(Math.max(15, dragState.elementStartHeight + deltaY));
          break;
        case "sw":
          newX = snapToGrid(dragState.elementStartX + deltaX);
          newWidth = snapToGrid(Math.max(30, dragState.elementStartWidth - deltaX));
          newHeight = snapToGrid(Math.max(15, dragState.elementStartHeight + deltaY));
          break;
        case "ne":
          newY = snapToGrid(dragState.elementStartY + deltaY);
          newWidth = snapToGrid(Math.max(30, dragState.elementStartWidth + deltaX));
          newHeight = snapToGrid(Math.max(15, dragState.elementStartHeight - deltaY));
          break;
        case "nw":
          newX = snapToGrid(dragState.elementStartX + deltaX);
          newY = snapToGrid(dragState.elementStartY + deltaY);
          newWidth = snapToGrid(Math.max(30, dragState.elementStartWidth - deltaX));
          newHeight = snapToGrid(Math.max(15, dragState.elementStartHeight - deltaY));
          break;
      }
      
      newX = Math.max(0, Math.min(newX, layout.canvasWidth - 30));
      newY = Math.max(0, Math.min(newY, layout.canvasHeight - 15));
      
      onUpdateElement(dragState.elementId, {
        x: newX,
        y: newY,
        width: newWidth,
        height: newHeight,
      });
    }
  }, [dragState, layout, snapToGrid, findAlignmentGuides, onUpdateElement]);

  const handleMouseUp = useCallback(() => {
    setDragState(null);
    setAlignmentGuides([]);
  }, []);

  const handleCanvasClick = useCallback((e: React.MouseEvent) => {
    if (e.target === canvasRef.current) {
      onSelectElement(null);
    }
  }, [onSelectElement]);

  return (
    <div
      ref={canvasRef}
      className="relative bg-white shadow-lg border border-gray-300"
      style={{
        width: DYMO_30252.width * 1.5,
        height: DYMO_30252.height * 1.5,
        backgroundColor: layout.backgroundColor,
      }}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      onMouseLeave={handleMouseUp}
      onClick={handleCanvasClick}
    >
      {layout.showGrid && (
        <svg
          className="absolute inset-0 pointer-events-none"
          width="100%"
          height="100%"
        >
          <defs>
            <pattern
              id="grid"
              width={layout.gridSize * 1.5}
              height={layout.gridSize * 1.5}
              patternUnits="userSpaceOnUse"
            >
              <path
                d={`M ${layout.gridSize * 1.5} 0 L 0 0 0 ${layout.gridSize * 1.5}`}
                fill="none"
                stroke="#e5e7eb"
                strokeWidth="0.5"
              />
            </pattern>
          </defs>
          <rect width="100%" height="100%" fill="url(#grid)" />
        </svg>
      )}

      {alignmentGuides.map((guide, i) => (
        <div
          key={i}
          className="absolute bg-blue-500 pointer-events-none"
          style={
            guide.type === "vertical"
              ? { left: guide.position * 1.5, top: 0, width: 1, height: "100%" }
              : { top: guide.position * 1.5, left: 0, height: 1, width: "100%" }
          }
        />
      ))}

      {layout.elements.filter((el) => el.visible).map((element) => {
        const isSelected = element.id === selectedId;
        const value = SAMPLE_DATA[element.type] || element.label;
        
        const labelWeight = element.labelFontWeight || element.fontWeight;
        const labelStyle = element.labelFontStyle || element.fontStyle;
        const valueWeight = element.valueFontWeight || 'normal';
        const valueStyle = element.valueFontStyle || 'normal';

        return (
          <div
            key={element.id}
            className={`absolute cursor-move select-none ${
              isSelected ? "ring-2 ring-blue-500 ring-offset-1" : "hover:ring-2 hover:ring-blue-300"
            }`}
            style={{
              left: element.x * 1.5,
              top: element.y * 1.5,
              width: element.width * 1.5,
              height: element.height * 1.5,
              fontSize: element.fontSize * 1.5,
              textAlign: element.textAlign,
              color: layout.textColor,
              display: "flex",
              alignItems: "center",
              justifyContent:
                element.textAlign === "center"
                  ? "center"
                  : element.textAlign === "right"
                  ? "flex-end"
                  : "flex-start",
              padding: "0 4px",
              overflow: "hidden",
              whiteSpace: "nowrap",
              textOverflow: "ellipsis",
              backgroundColor: isSelected ? "rgba(59, 130, 246, 0.05)" : "transparent",
            }}
            onMouseDown={(e) => handleMouseDown(e, element.id, "move")}
          >
            {element.showLabel ? (
              <>
                <span style={{ fontWeight: labelWeight, fontStyle: labelStyle }}>{element.label}: </span>
                <span style={{ fontWeight: valueWeight, fontStyle: valueStyle }}>{value}</span>
              </>
            ) : (
              <span style={{ fontWeight: element.fontWeight, fontStyle: element.fontStyle }}>{value}</span>
            )}

            {isSelected && (
              <>
                <div
                  className="absolute w-3 h-3 bg-blue-500 rounded-full cursor-nw-resize"
                  style={{ top: -6, left: -6 }}
                  onMouseDown={(e) => handleMouseDown(e, element.id, "resize", "nw")}
                />
                <div
                  className="absolute w-3 h-3 bg-blue-500 rounded-full cursor-ne-resize"
                  style={{ top: -6, right: -6 }}
                  onMouseDown={(e) => handleMouseDown(e, element.id, "resize", "ne")}
                />
                <div
                  className="absolute w-3 h-3 bg-blue-500 rounded-full cursor-sw-resize"
                  style={{ bottom: -6, left: -6 }}
                  onMouseDown={(e) => handleMouseDown(e, element.id, "resize", "sw")}
                />
                <div
                  className="absolute w-3 h-3 bg-blue-500 rounded-full cursor-se-resize"
                  style={{ bottom: -6, right: -6 }}
                  onMouseDown={(e) => handleMouseDown(e, element.id, "resize", "se")}
                />
              </>
            )}
          </div>
        );
      })}
    </div>
  );
}
