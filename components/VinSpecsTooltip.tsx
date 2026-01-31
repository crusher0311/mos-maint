"use client";

import { useState, useRef, useEffect } from "react";
import Link from "next/link";

interface VehicleSpecsGrouped {
  weightsAndCapacities: {
    fuelTankCapacity?: string;
    baseTowingCapacity?: string;
    maxTowingCapacity?: string;
    maxPayload?: string;
    curbWeight?: string;
    gvwr?: string;
  };
  wheelsAndTires: {
    frontTireDescription?: string;
    tireType?: string;
  };
  brakes: {
    frontBrakeDiameter?: string;
    rearBrakeDiameter?: string;
  };
  dimensions: {
    groundClearance?: string;
  };
  truckSpecs: {
    bedLength?: string;
  };
}

interface VinSpecsTooltipProps {
  vin: string;
  className?: string;
}

export function VinSpecsTooltip({ vin, className = "" }: VinSpecsTooltipProps) {
  const [isHovered, setIsHovered] = useState(false);
  const [specs, setSpecs] = useState<VehicleSpecsGrouped | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fetchedRef = useRef(false);

  const fetchSpecs = async () => {
    if (fetchedRef.current || loading) return;
    fetchedRef.current = true;
    setLoading(true);
    try {
      const res = await fetch(`/api/vehicles/${vin}/specs`);
      const data = await res.json();
      if (data.ok) {
        setSpecs(data.grouped);
      } else {
        setError(true);
      }
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  };

  const handleMouseEnter = () => {
    timeoutRef.current = setTimeout(() => {
      setIsHovered(true);
      if (!fetchedRef.current) {
        fetchSpecs();
      }
    }, 300);
  };

  const handleMouseLeave = () => {
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
    }
    setIsHovered(false);
  };

  useEffect(() => {
    return () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
      }
    };
  }, []);

  const hasSpecs = specs && (
    specs.weightsAndCapacities.fuelTankCapacity ||
    specs.weightsAndCapacities.maxTowingCapacity ||
    specs.wheelsAndTires.frontTireDescription
  );

  return (
    <div 
      className="relative inline-block"
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
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
          
          {loading && (
            <div className="flex items-center gap-2 text-sm text-gray-500">
              <div className="animate-spin w-4 h-4 border-2 border-blue-600 border-t-transparent rounded-full"></div>
              Loading...
            </div>
          )}
          
          {error && !loading && (
            <div className="text-sm text-gray-500">
              Specs not available
            </div>
          )}
          
          {!loading && !error && hasSpecs && (
            <div className="space-y-2 text-sm">
              {specs.weightsAndCapacities.fuelTankCapacity && (
                <div className="flex justify-between">
                  <span className="text-gray-500">Fuel Tank:</span>
                  <span className="font-medium">{specs.weightsAndCapacities.fuelTankCapacity} gal</span>
                </div>
              )}
              {specs.weightsAndCapacities.maxTowingCapacity && (
                <div className="flex justify-between">
                  <span className="text-gray-500">Max Towing:</span>
                  <span className="font-medium">{Number(specs.weightsAndCapacities.maxTowingCapacity).toLocaleString()} lbs</span>
                </div>
              )}
              {specs.weightsAndCapacities.maxPayload && (
                <div className="flex justify-between">
                  <span className="text-gray-500">Payload:</span>
                  <span className="font-medium">{Number(specs.weightsAndCapacities.maxPayload).toLocaleString()} lbs</span>
                </div>
              )}
              {specs.wheelsAndTires.frontTireDescription && (
                <div className="flex justify-between">
                  <span className="text-gray-500">Tires:</span>
                  <span className="font-medium text-xs">{specs.wheelsAndTires.frontTireDescription}</span>
                </div>
              )}
              {specs.brakes.frontBrakeDiameter && (
                <div className="flex justify-between">
                  <span className="text-gray-500">Front Brake:</span>
                  <span className="font-medium">{specs.brakes.frontBrakeDiameter}"</span>
                </div>
              )}
              {specs.truckSpecs?.bedLength && (
                <div className="flex justify-between">
                  <span className="text-gray-500">Bed Length:</span>
                  <span className="font-medium">{specs.truckSpecs.bedLength}"</span>
                </div>
              )}
            </div>
          )}
          
          {!loading && !error && !hasSpecs && (
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
