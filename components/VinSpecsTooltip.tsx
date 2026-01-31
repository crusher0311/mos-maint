"use client";

import { useState } from "react";
import Link from "next/link";

export interface QuickSpecs {
  fuelTankCapacity?: string;
  maxTowingCapacity?: string;
  maxPayload?: string;
  frontTireDescription?: string;
  frontBrakeDiameter?: string;
  bedLength?: string;
}

interface VinSpecsTooltipProps {
  vin: string;
  specs?: QuickSpecs;
  className?: string;
}

export function VinSpecsTooltip({ vin, specs, className = "" }: VinSpecsTooltipProps) {
  const [isHovered, setIsHovered] = useState(false);

  const hasSpecs = specs && (
    specs.fuelTankCapacity ||
    specs.maxTowingCapacity ||
    specs.frontTireDescription
  );

  return (
    <div 
      className="relative inline-block"
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
    >
      <Link
        href={`/dashboard/vehicles/${vin}?tab=specs`}
        className={`text-xs bg-gray-100 px-1.5 sm:px-2 py-0.5 sm:py-1 rounded font-mono text-gray-700 hover:bg-blue-100 hover:text-blue-700 transition-colors cursor-pointer ${className}`}
      >
        {vin}
      </Link>
      
      {isHovered && (
        <div className="absolute z-50 left-0 top-full mt-1 w-64 bg-white border border-gray-200 rounded-lg shadow-lg p-3 text-left">
          <div className="text-xs font-semibold text-gray-500 uppercase mb-2">
            Quick Specs
          </div>
          
          {hasSpecs ? (
            <div className="space-y-2 text-sm">
              {specs.fuelTankCapacity && (
                <div className="flex justify-between">
                  <span className="text-gray-500">Fuel Tank:</span>
                  <span className="font-medium">{specs.fuelTankCapacity} gal</span>
                </div>
              )}
              {specs.maxTowingCapacity && (
                <div className="flex justify-between">
                  <span className="text-gray-500">Max Towing:</span>
                  <span className="font-medium">{Number(specs.maxTowingCapacity).toLocaleString()} lbs</span>
                </div>
              )}
              {specs.maxPayload && (
                <div className="flex justify-between">
                  <span className="text-gray-500">Payload:</span>
                  <span className="font-medium">{Number(specs.maxPayload).toLocaleString()} lbs</span>
                </div>
              )}
              {specs.frontTireDescription && (
                <div className="flex justify-between">
                  <span className="text-gray-500">Tires:</span>
                  <span className="font-medium text-xs">{specs.frontTireDescription}</span>
                </div>
              )}
              {specs.frontBrakeDiameter && (
                <div className="flex justify-between">
                  <span className="text-gray-500">Front Brake:</span>
                  <span className="font-medium">{specs.frontBrakeDiameter}"</span>
                </div>
              )}
              {specs.bedLength && (
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
