"use client";

import { useRef, useState, useCallback } from "react";
import { StickerElement, StickerLayout, STICKER_SAMPLE_DATA } from "@/lib/sticker-designer-types";
import { QrCode, Image as ImageIcon } from "lucide-react";

interface StickerContentData {
  phone?: string;
  tagline?: string;
  taglineLine2?: string;
  serviceLabel?: string;
  serviceDate?: string;
  serviceMileage?: string;
}

interface StickerDesignerCanvasProps {
  layout: StickerLayout;
  selectedId: string | null;
  onSelectElement: (id: string | null) => void;
  onUpdateElement: (id: string, updates: Partial<StickerElement>) => void;
  logoUrl?: string;
  qrUrl?: string;
  contentData?: StickerContentData;
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

export function StickerDesignerCanvas({
  layout,
  selectedId,
  onSelectElement,
  onUpdateElement,
  logoUrl,
  qrUrl,
  contentData,
}: StickerDesignerCanvasProps) {
  const canvasRef = useRef<HTMLDivElement>(null);
  const [dragState, setDragState] = useState<DragState | null>(null);
  const [alignmentGuides, setAlignmentGuides] = useState<AlignmentGuide[]>([]);

  const snapToGrid = useCallback((value: number) => {
    if (!layout.showGrid) return value;
    return Math.round(value / layout.gridSize) * layout.gridSize;
  }, [layout.showGrid, layout.gridSize]);

  const findAlignmentGuides = useCallback((element: StickerElement, newX: number, newY: number) => {
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
      if (Math.abs(elementCenterX - otherCenterX) < threshold) {
        guides.push({ type: "vertical", position: otherCenterX });
      }
      
      if (Math.abs(newY - other.y) < threshold) {
        guides.push({ type: "horizontal", position: other.y });
      }
      if (Math.abs(elementBottom - otherBottom) < threshold) {
        guides.push({ type: "horizontal", position: otherBottom });
      }
      if (Math.abs(elementCenterY - otherCenterY) < threshold) {
        guides.push({ type: "horizontal", position: otherCenterY });
      }
    });
    
    return guides;
  }, [layout.canvasWidth, layout.canvasHeight, layout.elements]);

  const handleMouseDown = (e: React.MouseEvent, element: StickerElement, type: "move" | "resize", corner?: "nw" | "ne" | "sw" | "se") => {
    e.stopPropagation();
    e.preventDefault();
    
    onSelectElement(element.id);
    
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return;
    
    setDragState({
      type,
      elementId: element.id,
      startX: e.clientX,
      startY: e.clientY,
      elementStartX: element.x,
      elementStartY: element.y,
      elementStartWidth: element.width,
      elementStartHeight: element.height,
      corner,
    });
  };

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    if (!dragState || !canvasRef.current) return;
    
    const element = layout.elements.find((el) => el.id === dragState.elementId);
    if (!element) return;
    
    const rect = canvasRef.current.getBoundingClientRect();
    const scale = rect.width / layout.canvasWidth;
    
    const deltaX = (e.clientX - dragState.startX) / scale;
    const deltaY = (e.clientY - dragState.startY) / scale;
    
    if (dragState.type === "move") {
      let newX = snapToGrid(dragState.elementStartX + deltaX);
      let newY = snapToGrid(dragState.elementStartY + deltaY);
      
      newX = Math.max(0, Math.min(newX, layout.canvasWidth - element.width));
      newY = Math.max(0, Math.min(newY, layout.canvasHeight - element.height));
      
      const guides = findAlignmentGuides(element, newX, newY);
      setAlignmentGuides(guides);
      
      onUpdateElement(element.id, { x: newX, y: newY });
    } else if (dragState.type === "resize") {
      let newWidth = element.width;
      let newHeight = element.height;
      let newX = element.x;
      let newY = element.y;
      
      switch (dragState.corner) {
        case "se":
          newWidth = snapToGrid(Math.max(30, dragState.elementStartWidth + deltaX));
          newHeight = snapToGrid(Math.max(15, dragState.elementStartHeight + deltaY));
          break;
        case "sw":
          newWidth = snapToGrid(Math.max(30, dragState.elementStartWidth - deltaX));
          newHeight = snapToGrid(Math.max(15, dragState.elementStartHeight + deltaY));
          newX = snapToGrid(dragState.elementStartX + (dragState.elementStartWidth - newWidth));
          break;
        case "ne":
          newWidth = snapToGrid(Math.max(30, dragState.elementStartWidth + deltaX));
          newHeight = snapToGrid(Math.max(15, dragState.elementStartHeight - deltaY));
          newY = snapToGrid(dragState.elementStartY + (dragState.elementStartHeight - newHeight));
          break;
        case "nw":
          newWidth = snapToGrid(Math.max(30, dragState.elementStartWidth - deltaX));
          newHeight = snapToGrid(Math.max(15, dragState.elementStartHeight - deltaY));
          newX = snapToGrid(dragState.elementStartX + (dragState.elementStartWidth - newWidth));
          newY = snapToGrid(dragState.elementStartY + (dragState.elementStartHeight - newHeight));
          break;
      }
      
      newX = Math.max(0, newX);
      newY = Math.max(0, newY);
      newWidth = Math.min(newWidth, layout.canvasWidth - newX);
      newHeight = Math.min(newHeight, layout.canvasHeight - newY);
      
      onUpdateElement(element.id, { x: newX, y: newY, width: newWidth, height: newHeight });
    }
  }, [dragState, layout, snapToGrid, findAlignmentGuides, onUpdateElement]);

  const handleMouseUp = () => {
    setDragState(null);
    setAlignmentGuides([]);
  };

  const handleCanvasClick = (e: React.MouseEvent) => {
    if (e.target === canvasRef.current) {
      onSelectElement(null);
    }
  };

  const renderElementContent = (element: StickerElement) => {
    const style: React.CSSProperties = {
      fontSize: `${element.fontSize}px`,
      fontWeight: element.fontWeight,
      fontStyle: element.fontStyle,
      textAlign: element.textAlign,
      color: element.color,
      width: "100%",
      height: "100%",
      display: "flex",
      alignItems: "center",
      justifyContent: element.textAlign === "center" ? "center" : element.textAlign === "right" ? "flex-end" : "flex-start",
      overflow: "hidden",
      whiteSpace: "nowrap",
      textOverflow: "ellipsis",
      lineHeight: 1.2,
    };

    switch (element.type) {
      case "logo":
        if (logoUrl) {
          return (
            <img 
              src={logoUrl} 
              alt="Logo" 
              style={{ 
                width: "100%", 
                height: "100%", 
                objectFit: element.imageFit || "contain",
                pointerEvents: "none",
              }} 
            />
          );
        }
        return (
          <div className="flex items-center justify-center w-full h-full bg-gray-100 text-gray-400 border border-dashed border-gray-300 rounded">
            <ImageIcon size={Math.min(element.width, element.height) * 0.4} />
          </div>
        );

      case "qrCode":
        if (qrUrl) {
          return (
            <img 
              src={qrUrl} 
              alt="QR Code" 
              style={{ 
                width: "100%", 
                height: "100%", 
                objectFit: "contain",
                pointerEvents: "none",
              }} 
            />
          );
        }
        return (
          <div className="flex items-center justify-center w-full h-full bg-gray-100 text-gray-400 border border-dashed border-gray-300 rounded">
            <QrCode size={Math.min(element.width, element.height) * 0.5} />
          </div>
        );

      case "serviceLabel":
        return <span style={style}>{element.content || contentData?.serviceLabel || STICKER_SAMPLE_DATA.serviceLabel}</span>;

      case "phone":
        return <span style={style}>{contentData?.phone || STICKER_SAMPLE_DATA.phone}</span>;

      case "tagline":
        return <span style={style}>{contentData?.tagline || STICKER_SAMPLE_DATA.tagline}</span>;

      case "taglineLine2":
        return <span style={style}>{contentData?.taglineLine2 || STICKER_SAMPLE_DATA.taglineLine2}</span>;

      case "serviceDate":
        return <span style={style}>{contentData?.serviceDate || STICKER_SAMPLE_DATA.serviceDate}</span>;

      case "serviceMileage":
        return <span style={style}>{contentData?.serviceMileage || STICKER_SAMPLE_DATA.serviceMileage}</span>;

      default:
        return <span style={style}>{element.label}</span>;
    }
  };

  const visibleElements = layout.elements.filter((el) => el.visible);
  
  // Scale factor for displaying the canvas larger while keeping internal coordinates
  const displayScale = 2;

  return (
    <div className="flex flex-col items-center">
      <div 
        style={{ 
          width: layout.canvasWidth * displayScale, 
          height: layout.canvasHeight * displayScale,
          position: 'relative',
        }}
      >
        <div
          ref={canvasRef}
          className="relative border-2 border-gray-300 rounded-lg shadow-lg cursor-crosshair select-none"
          style={{
            width: layout.canvasWidth,
            height: layout.canvasHeight,
            backgroundColor: layout.backgroundColor,
            fontFamily: 'Arial, Helvetica, sans-serif',
            backgroundImage: layout.showGrid
              ? `linear-gradient(to right, #e5e7eb 1px, transparent 1px), linear-gradient(to bottom, #e5e7eb 1px, transparent 1px)`
              : "none",
            backgroundSize: layout.showGrid ? `${layout.gridSize}px ${layout.gridSize}px` : "auto",
            transform: `scale(${displayScale})`,
            transformOrigin: 'top left',
          }}
          onClick={handleCanvasClick}
          onMouseMove={handleMouseMove}
          onMouseUp={handleMouseUp}
          onMouseLeave={handleMouseUp}
        >
        {alignmentGuides.map((guide, idx) => (
          <div
            key={idx}
            className="absolute bg-blue-500 pointer-events-none"
            style={
              guide.type === "vertical"
                ? { left: guide.position, top: 0, width: 1, height: "100%", opacity: 0.7 }
                : { left: 0, top: guide.position, width: "100%", height: 1, opacity: 0.7 }
            }
          />
        ))}

        {visibleElements.map((element) => {
          const isSelected = selectedId === element.id;
          
          return (
            <div
              key={element.id}
              className={`absolute cursor-move transition-shadow ${
                isSelected ? "ring-2 ring-blue-500 ring-offset-1" : "hover:ring-1 hover:ring-blue-300"
              }`}
              style={{
                left: element.x,
                top: element.y,
                width: element.width,
                height: element.height,
                backgroundColor: element.backgroundColor || "transparent",
              }}
              onMouseDown={(e) => handleMouseDown(e, element, "move")}
            >
              {renderElementContent(element)}
              
              {isSelected && (
                <>
                  {(["nw", "ne", "sw", "se"] as const).map((corner) => {
                    const positions: Record<string, React.CSSProperties> = {
                      nw: { left: -4, top: -4, cursor: "nw-resize" },
                      ne: { right: -4, top: -4, cursor: "ne-resize" },
                      sw: { left: -4, bottom: -4, cursor: "sw-resize" },
                      se: { right: -4, bottom: -4, cursor: "se-resize" },
                    };
                    
                    return (
                      <div
                        key={corner}
                        className="absolute w-2 h-2 bg-blue-500 border border-white rounded-sm"
                        style={positions[corner]}
                        onMouseDown={(e) => handleMouseDown(e, element, "resize", corner)}
                      />
                    );
                  })}
                </>
              )}
            </div>
          );
        })}
        </div>
      </div>
      
      <p className="text-xs text-gray-500 mt-2">
        {layout.canvasWidth} x {layout.canvasHeight} px (displayed at {displayScale}x)
      </p>
    </div>
  );
}
