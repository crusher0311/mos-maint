"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { useRouter } from "next/navigation";
import { 
  ClipboardList, 
  Search, 
  X, 
  Clock, 
  Car,
  Loader2,
  ArrowRight,
  RefreshCw,
  Zap
} from "lucide-react";
import { queueMultiplePrefetch, queuePrefetch, isPrefetched } from "@/lib/plan-prefetch";

interface Vehicle {
  displayVin: string;
  displayName: string;
  displayVehicle: string;
  dviDone?: boolean;
  displayStatus?: string;
}

interface RecentPlan {
  vin: string;
  customerName: string;
  vehicle: string;
  accessedAt: number;
}

const RECENT_PLANS_KEY = "mos-recent-plans";
const MAX_RECENT_PLANS = 5;
const CACHE_TTL = 5 * 60 * 1000;

let vehicleCache: { data: Vehicle[]; fetchedAt: number } | null = null;

export function PlanLauncher() {
  const router = useRouter();
  const [isOpen, setIsOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [allVehicles, setAllVehicles] = useState<Vehicle[]>([]);
  const [filteredVehicles, setFilteredVehicles] = useState<Vehicle[]>([]);
  const [isLoadingCache, setIsLoadingCache] = useState(false);
  const [recentPlans, setRecentPlans] = useState<RecentPlan[]>([]);
  const [cacheStatus, setCacheStatus] = useState<"stale" | "loading" | "ready">("stale");
  const inputRef = useRef<HTMLInputElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  const loadVehicleCache = useCallback(async (force = false) => {
    const now = Date.now();
    if (!force && vehicleCache && (now - vehicleCache.fetchedAt) < CACHE_TTL) {
      setAllVehicles(vehicleCache.data);
      setCacheStatus("ready");
      return;
    }

    setCacheStatus("loading");
    setIsLoadingCache(true);
    try {
      const response = await fetch("/api/dashboard/data");
      if (response.ok) {
        const data = await response.json();
        const vehicles = data.rows || [];
        vehicleCache = { data: vehicles, fetchedAt: now };
        setAllVehicles(vehicles);
        setCacheStatus("ready");

        const vehiclesToPrefetch = vehicles.map((v: Vehicle) => ({
          vin: v.displayVin,
          inProgress: !v.dviDone,
        }));
        queueMultiplePrefetch(vehiclesToPrefetch, 10);
      }
    } catch (error) {
      console.error("Failed to load vehicle cache:", error);
      setCacheStatus("stale");
    } finally {
      setIsLoadingCache(false);
    }
  }, []);

  useEffect(() => {
    const stored = localStorage.getItem(RECENT_PLANS_KEY);
    if (stored) {
      try {
        setRecentPlans(JSON.parse(stored));
      } catch (e) {
        console.error("Failed to parse recent plans:", e);
      }
    }
  }, []);

  useEffect(() => {
    if (isOpen) {
      loadVehicleCache();
      if (inputRef.current) {
        inputRef.current.focus();
      }
    }
  }, [isOpen, loadVehicleCache]);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };

    if (isOpen) {
      document.addEventListener("mousedown", handleClickOutside);
    }
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [isOpen]);

  useEffect(() => {
    if (!searchQuery || searchQuery.length < 2) {
      setFilteredVehicles([]);
      return;
    }

    const query = searchQuery.toLowerCase();
    const filtered = allVehicles.filter((row: Vehicle) => {
      return (
        row.displayVin?.toLowerCase().includes(query) ||
        row.displayName?.toLowerCase().includes(query) ||
        row.displayVehicle?.toLowerCase().includes(query)
      );
    });
    setFilteredVehicles(filtered.slice(0, 8));
  }, [searchQuery, allVehicles]);

  const addToRecent = (vehicle: Vehicle) => {
    const newRecent: RecentPlan = {
      vin: vehicle.displayVin,
      customerName: vehicle.displayName || "Unknown Customer",
      vehicle: vehicle.displayVehicle || "Unknown Vehicle",
      accessedAt: Date.now(),
    };

    const filtered = recentPlans.filter((p) => p.vin !== vehicle.displayVin);
    const updated = [newRecent, ...filtered].slice(0, MAX_RECENT_PLANS);
    
    setRecentPlans(updated);
    localStorage.setItem(RECENT_PLANS_KEY, JSON.stringify(updated));
  };

  const navigateToPlan = (vehicle: Vehicle | RecentPlan) => {
    const vin = "displayVin" in vehicle ? vehicle.displayVin : vehicle.vin;
    
    if ("displayVin" in vehicle) {
      addToRecent(vehicle);
    } else {
      const updated = recentPlans.map((p) =>
        p.vin === vin ? { ...p, accessedAt: Date.now() } : p
      );
      const sorted = updated.sort((a, b) => b.accessedAt - a.accessedAt);
      setRecentPlans(sorted);
      localStorage.setItem(RECENT_PLANS_KEY, JSON.stringify(sorted));
    }

    setIsOpen(false);
    setSearchQuery("");
    router.push(`/dashboard/vehicles/${vin}/plan`);
  };

  const handleVehicleHover = (vin: string) => {
    if (!isPrefetched(vin)) {
      queuePrefetch(vin, "high");
    }
  };

  return (
    <div className="relative" ref={panelRef}>
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors bg-blue-600 text-white hover:bg-blue-700"
      >
        <ClipboardList className="w-5 h-5" />
        <span>Open Plan</span>
        <ArrowRight className="w-4 h-4 ml-auto" />
      </button>

      {isOpen && (
        <div className="absolute left-full top-0 ml-2 w-80 bg-white rounded-lg shadow-xl border border-gray-200 z-50 overflow-hidden">
          <div className="p-3 border-b border-gray-100">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
              <input
                ref={inputRef}
                type="text"
                placeholder="Search by VIN, customer, or vehicle..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full pl-10 pr-8 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
              />
              {searchQuery && (
                <button
                  onClick={() => setSearchQuery("")}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
                >
                  <X className="w-4 h-4" />
                </button>
              )}
            </div>
          </div>

          <div className="max-h-80 overflow-y-auto">
            {isLoadingCache && searchQuery ? (
              <div className="p-4 text-center text-gray-500">
                <Loader2 className="w-5 h-5 animate-spin mx-auto mb-2" />
                <p className="text-sm">Loading vehicles...</p>
              </div>
            ) : searchQuery && filteredVehicles.length > 0 ? (
              <div className="p-2">
                <p className="px-2 py-1 text-xs font-medium text-gray-500 uppercase">
                  Search Results
                </p>
                {filteredVehicles.map((vehicle) => (
                  <button
                    key={vehicle.displayVin}
                    onClick={() => navigateToPlan(vehicle)}
                    onMouseEnter={() => handleVehicleHover(vehicle.displayVin)}
                    className="w-full flex items-start gap-3 p-2 rounded-lg hover:bg-blue-50 transition-colors text-left group"
                  >
                    <div className="w-8 h-8 rounded-full bg-blue-100 flex items-center justify-center flex-shrink-0">
                      <Car className="w-4 h-4 text-blue-600" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-gray-900 truncate group-hover:text-blue-600">
                        {vehicle.displayName || "Unknown Customer"}
                      </p>
                      <p className="text-xs text-gray-500 truncate">
                        {vehicle.displayVehicle}
                      </p>
                      <p className="text-xs text-gray-400 font-mono">
                        {vehicle.displayVin}
                      </p>
                    </div>
                    {isPrefetched(vehicle.displayVin) && (
                      <Zap className="w-4 h-4 text-green-500 flex-shrink-0" title="Data cached" />
                    )}
                  </button>
                ))}
              </div>
            ) : searchQuery && filteredVehicles.length === 0 && cacheStatus === "ready" ? (
              <div className="p-4 text-center text-gray-500">
                <p className="text-sm">No vehicles found</p>
              </div>
            ) : recentPlans.length > 0 ? (
              <div className="p-2">
                <p className="px-2 py-1 text-xs font-medium text-gray-500 uppercase flex items-center gap-1">
                  <Clock className="w-3 h-3" />
                  Recent Plans
                </p>
                {recentPlans.map((plan) => (
                  <button
                    key={plan.vin}
                    onClick={() => navigateToPlan(plan)}
                    onMouseEnter={() => handleVehicleHover(plan.vin)}
                    className="w-full flex items-start gap-3 p-2 rounded-lg hover:bg-blue-50 transition-colors text-left group"
                  >
                    <div className="w-8 h-8 rounded-full bg-gray-100 flex items-center justify-center flex-shrink-0">
                      <Car className="w-4 h-4 text-gray-600" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-gray-900 truncate group-hover:text-blue-600">
                        {plan.customerName}
                      </p>
                      <p className="text-xs text-gray-500 truncate">
                        {plan.vehicle}
                      </p>
                      <p className="text-xs text-gray-400 font-mono">
                        {plan.vin}
                      </p>
                    </div>
                    {isPrefetched(plan.vin) && (
                      <Zap className="w-4 h-4 text-green-500 flex-shrink-0" title="Data cached" />
                    )}
                  </button>
                ))}
              </div>
            ) : (
              <div className="p-4 text-center text-gray-500">
                <ClipboardList className="w-8 h-8 mx-auto mb-2 text-gray-300" />
                <p className="text-sm">Search for a vehicle to view its plan</p>
                <p className="text-xs text-gray-400 mt-1">
                  Your recent plans will appear here
                </p>
              </div>
            )}
          </div>

          <div className="p-2 border-t border-gray-100 bg-gray-50 flex items-center justify-between">
            <p className="text-xs text-gray-400">
              Hover to prefetch for faster loading
            </p>
            <button
              onClick={() => loadVehicleCache(true)}
              disabled={isLoadingCache}
              className="text-xs text-blue-500 hover:text-blue-600 flex items-center gap-1 disabled:opacity-50"
            >
              <RefreshCw className={`w-3 h-3 ${isLoadingCache ? 'animate-spin' : ''}`} />
              Refresh
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
