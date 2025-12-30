"use client";

import { useState, useEffect } from "react";
import JobLookup from "@/components/JobLookup";
import { Search, Car, FileText, AlertCircle } from "lucide-react";

type OpenWorkOrder = {
  workOrderId: string;
  workOrderNumber: number;
  vehicle: {
    vin?: string;
    year?: number;
    make?: string;
    model?: string;
    engine?: string;
  };
  status: string;
};

export default function JobLookupClient() {
  const [openWorkOrders, setOpenWorkOrders] = useState<OpenWorkOrder[]>([]);
  const [selectedWO, setSelectedWO] = useState<OpenWorkOrder | null>(null);
  const [loading, setLoading] = useState(true);
  const [stats, setStats] = useState<{ jobsIndexed: number; partsIndexed: number } | null>(null);

  useEffect(() => {
    fetchOpenWorkOrders();
    fetchStats();
  }, []);

  const fetchOpenWorkOrders = async () => {
    try {
      const res = await fetch("/api/jobs/open-work-orders");
      const data = await res.json();
      
      if (data.ok && data.workOrders) {
        const wos: OpenWorkOrder[] = data.workOrders.map((wo: any) => ({
          workOrderId: wo.workOrderId,
          workOrderNumber: wo.workOrderNumber || 0,
          vehicle: {
            vin: wo.vehicle?.vin,
            year: wo.vehicle?.year,
            make: wo.vehicle?.make,
            model: wo.vehicle?.model,
            engine: wo.vehicle?.engine,
          },
          status: wo.status || "Open",
        }));
        setOpenWorkOrders(wos);
      }
    } catch (err) {
      console.error("Failed to fetch work orders:", err);
    } finally {
      setLoading(false);
    }
  };

  const fetchStats = async () => {
    try {
      const res = await fetch("/api/jobs/stats");
      const data = await res.json();
      if (data.ok) {
        setStats({
          jobsIndexed: data.jobsIndexed || 0,
          partsIndexed: data.partsIndexed || 0,
        });
      }
    } catch (err) {
      console.error("Failed to fetch stats:", err);
    }
  };

  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
      <div className="lg:col-span-2">
        <div className="bg-white rounded-lg shadow p-6">
          <JobLookup
            currentVehicle={selectedWO?.vehicle}
            workOrderGuid={selectedWO?.workOrderId}
            onJobAdded={() => {
              fetchOpenWorkOrders();
            }}
          />
        </div>
      </div>

      <div className="space-y-6">
        <div className="bg-white rounded-lg shadow p-6">
          <h3 className="font-medium text-gray-900 mb-4 flex items-center gap-2">
            <FileText className="w-5 h-5 text-gray-400" />
            Select Work Order
          </h3>

          {loading ? (
            <div className="text-center py-4 text-gray-500">Loading...</div>
          ) : openWorkOrders.length === 0 ? (
            <div className="text-center py-4">
              <AlertCircle className="w-8 h-8 mx-auto mb-2 text-gray-300" />
              <p className="text-sm text-gray-500">No open work orders found</p>
              <p className="text-xs text-gray-400 mt-1">Sync Protractor to see open ROs</p>
            </div>
          ) : (
            <div className="space-y-2 max-h-96 overflow-y-auto">
              {openWorkOrders.map((wo) => (
                <button
                  key={wo.workOrderId}
                  onClick={() => setSelectedWO(wo)}
                  className={`w-full text-left p-3 rounded-lg border transition-colors ${
                    selectedWO?.workOrderId === wo.workOrderId
                      ? "border-blue-500 bg-blue-50"
                      : "border-gray-200 hover:border-gray-300 hover:bg-gray-50"
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <Car className="w-4 h-4 text-gray-400" />
                    <span className="font-medium text-gray-900">
                      RO #{wo.workOrderNumber}
                    </span>
                  </div>
                  <div className="mt-1 text-sm text-gray-500">
                    {wo.vehicle.year} {wo.vehicle.make} {wo.vehicle.model}
                  </div>
                  {wo.vehicle.engine && (
                    <div className="text-xs text-gray-400">{wo.vehicle.engine}</div>
                  )}
                </button>
              ))}
            </div>
          )}
        </div>

        {stats && (
          <div className="bg-white rounded-lg shadow p-6">
            <h3 className="font-medium text-gray-900 mb-4 flex items-center gap-2">
              <Search className="w-5 h-5 text-gray-400" />
              Index Stats
            </h3>
            <div className="space-y-3">
              <div className="flex justify-between">
                <span className="text-gray-600">Jobs Indexed</span>
                <span className="font-medium text-gray-900">{stats.jobsIndexed.toLocaleString()}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-600">Parts Tracked</span>
                <span className="font-medium text-gray-900">{stats.partsIndexed.toLocaleString()}</span>
              </div>
            </div>
            <p className="mt-4 text-xs text-gray-400">
              Job index is updated automatically when you sync Protractor data.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
