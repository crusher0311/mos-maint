"use client";

import { useState, useRef, useEffect } from "react";
import { HelpCircle } from "lucide-react";

interface TooltipProps {
  content: string;
  children?: React.ReactNode;
  position?: "top" | "bottom" | "left" | "right";
  showIcon?: boolean;
  iconSize?: number;
}

export function Tooltip({ 
  content, 
  children, 
  position = "top",
  showIcon = true,
  iconSize = 16
}: TooltipProps) {
  const [isVisible, setIsVisible] = useState(false);
  const [coords, setCoords] = useState({ top: 0, left: 0 });
  const triggerRef = useRef<HTMLSpanElement>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (isVisible && triggerRef.current && tooltipRef.current) {
      const triggerRect = triggerRef.current.getBoundingClientRect();
      const tooltipRect = tooltipRef.current.getBoundingClientRect();
      
      let top = 0;
      let left = 0;

      switch (position) {
        case "top":
          top = -tooltipRect.height - 8;
          left = (triggerRect.width - tooltipRect.width) / 2;
          break;
        case "bottom":
          top = triggerRect.height + 8;
          left = (triggerRect.width - tooltipRect.width) / 2;
          break;
        case "left":
          top = (triggerRect.height - tooltipRect.height) / 2;
          left = -tooltipRect.width - 8;
          break;
        case "right":
          top = (triggerRect.height - tooltipRect.height) / 2;
          left = triggerRect.width + 8;
          break;
      }

      setCoords({ top, left });
    }
  }, [isVisible, position]);

  return (
    <span
      ref={triggerRef}
      className="relative inline-flex items-center"
      onMouseEnter={() => setIsVisible(true)}
      onMouseLeave={() => setIsVisible(false)}
    >
      {children || (
        showIcon && (
          <HelpCircle 
            className="text-gray-400 hover:text-gray-600 cursor-help transition-colors" 
            style={{ width: iconSize, height: iconSize }}
          />
        )
      )}
      {isVisible && (
        <div
          ref={tooltipRef}
          className="absolute z-50 px-3 py-2 text-sm text-white bg-gray-900 rounded-lg shadow-lg whitespace-normal max-w-xs"
          style={{ top: coords.top, left: coords.left }}
        >
          {content}
          <div 
            className={`absolute w-2 h-2 bg-gray-900 transform rotate-45 ${
              position === "top" ? "bottom-[-4px] left-1/2 -translate-x-1/2" :
              position === "bottom" ? "top-[-4px] left-1/2 -translate-x-1/2" :
              position === "left" ? "right-[-4px] top-1/2 -translate-y-1/2" :
              "left-[-4px] top-1/2 -translate-y-1/2"
            }`}
          />
        </div>
      )}
    </span>
  );
}

interface TooltipLabelProps {
  label: string;
  tooltip: string;
  required?: boolean;
  className?: string;
}

export function TooltipLabel({ label, tooltip, required, className = "" }: TooltipLabelProps) {
  return (
    <label className={`flex items-center gap-1.5 text-sm font-medium text-gray-700 ${className}`}>
      {label}
      {required && <span className="text-red-500">*</span>}
      <Tooltip content={tooltip} position="right" iconSize={14} />
    </label>
  );
}
