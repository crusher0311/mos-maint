"use client";

import React, { useState, useRef, useEffect } from "react";
import Link from "next/link";

export interface QuickSpecs {
  fuelTankCapacity?: string;
  maxTowingCapacity?: string;
  maxPayload?: string;
  frontTireDescription?: string;
  frontBrakeDiameter?: string;
  bedLength?: string;
}

export interface QuickSpecsDisplay {
  fuelTank?: boolean;
  maxTowing?: boolean;
  payload?: boolean;
  tires?: boolean;
  frontBrake?: boolean;
  bedLength?: boolean;
}

interface VinSpecsTooltipProps {
  vin: string;
  specs?: QuickSpecs;
  displayConfig?: QuickSpecsDisplay;
  className?: string;
}

const DEFAULT_DISPLAY: QuickSpecsDisplay = {
  fuelTank: true,
  maxTowing: true,
  payload: true,
  tires: true,
  frontBrake: false,
  bedLength: false,
};

export function VinSpecsTooltip({ vin, specs, displayConfig, className = "" }: VinSpecsTooltipProps) {
  const [isVisible, setIsVisible] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  
  const config = { ...DEFAULT_DISPLAY, ...displayConfig };

  const hasSpecs = specs && (
    (config.fuelTank && specs.fuelTankCapacity) ||
    (config.maxTowing && specs.maxTowingCapacity) ||
    (config.payload && specs.maxPayload) ||
    (config.tires && specs.frontTireDescription) ||
    (config.frontBrake && specs.frontBrakeDiameter) ||
    (config.bedLength && specs.bedLength)
  );

  // Close tooltip when clicking outside
  useEffect(() => {
    function handleClickOutside(event: MouseEvent | TouchEvent) {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setIsVisible(false);
      }
    }
    
    if (isVisible) {
      document.addEventListener("mousedown", handleClickOutside);
      document.addEventListener("touchstart", handleClickOutside);
    }
    
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("touchstart", handleClickOutside);
    };
  }, [isVisible]);

  const handleTouch = (e: React.TouchEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsVisible(prev => !prev);
  };

  return (
    <div 
      ref={containerRef}
      className="relative inline-block"
      onMouseEnter={() => setIsVisible(true)}
      onMouseLeave={() => setIsVisible(false)}
      onTouchStart={handleTouch}
    >
      <Link
        href={`/dashboard/vehicles/${vin}?tab=specs`}
        className={`text-xs bg-gray-100 px-1.5 sm:px-2 py-0.5 sm:py-1 rounded font-mono text-gray-700 hover:bg-blue-100 hover:text-blue-700 transition-colors cursor-pointer ${className}`}
      >
        {vin}
      </Link>
      
      {isVisible && (
        <div className="absolute z-50 left-0 top-full mt-1 w-64 bg-white border border-gray-200 rounded-lg shadow-lg p-3 text-left">
          <div className="text-xs font-semibold text-gray-500 uppercase mb-2">
            Quick Specs
          </div>
          
          {hasSpecs ? (
            <div className="space-y-2 text-sm">
              {config.fuelTank && specs.fuelTankCapacity && (
                <div className="flex justify-between">
                  <span className="text-gray-500">Fuel Tank:</span>
                  <span className="font-medium">{specs.fuelTankCapacity} gal</span>
                </div>
              )}
              {config.maxTowing && specs.maxTowingCapacity && (
                <div className="flex justify-between">
                  <span className="text-gray-500">Max Towing:</span>
                  <span className="font-medium">{Number(specs.maxTowingCapacity).toLocaleString()} lbs</span>
                </div>
              )}
              {config.payload && specs.maxPayload && (
                <div className="flex justify-between">
                  <span className="text-gray-500">Payload:</span>
                  <span className="font-medium">{Number(specs.maxPayload).toLocaleString()} lbs</span>
                </div>
              )}
              {config.tires && specs.frontTireDescription && (
                <div className="flex justify-between">
                  <span className="text-gray-500">Tires:</span>
                  <span className="font-medium text-xs">{specs.frontTireDescription}</span>
                </div>
              )}
              {config.frontBrake && specs.frontBrakeDiameter && (
                <div className="flex justify-between">
                  <span className="text-gray-500">Front Brake:</span>
                  <span className="font-medium">{specs.frontBrakeDiameter}"</span>
                </div>
              )}
              {config.bedLength && specs.bedLength && (
                <div className="flex justify-between">
                  <span className="text-gray-500">Bed Length:</span>
                  <span className="font-medium">{specs.bedLength}"</span>
                </div>
              )}
            </div>
          ) : (
            <div className="text-sm text-gray-500">
              No specs available for this VIN
            </div>
          )}
          
          <div className="mt-2 pt-2 border-t border-gray-100">
            <span className="text-xs text-blue-600">Click to view all specs →</span>
          </div>
        </div>
      )}
    </div>
  );
}
