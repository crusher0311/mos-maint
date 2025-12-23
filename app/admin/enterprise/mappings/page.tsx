"use client";

import React, { useState, useEffect, Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { ArrowLeft, RefreshCw, Save, Check, AlertCircle } from "lucide-react";
import Link from "next/link";

interface CannedJob {
  id: string;
  name: string;
  code?: string;
}

function MappingsContent() {
  const searchParams = useSearchParams();
  const enterpriseId = searchParams.get("id");
  
  const [enterprise, setEnterprise] = useState<any>(null);
  const [mappings, setMappings] = useState<Record<string, string>>({});
  const [originalMappings, setOriginalMappings] = useState<Record<string, string>>({});
  const [availableJobs, setAvailableJobs] = useState<CannedJob[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [applyToAll, setApplyToAll] = useState(true);

  const commonServices = [
    { key: "oil_change", label: "Oil Change" },
    { key: "tire_rotation", label: "Tire Rotation" },
    { key: "brake_inspection", label: "Brake Inspection" },
    { key: "brake_pads_front", label: "Brake Pads (Front)" },
    { key: "brake_pads_rear", label: "Brake Pads (Rear)" },
    { key: "air_filter", label: "Air Filter" },
    { key: "cabin_filter", label: "Cabin Air Filter" },
    { key: "transmission_service", label: "Transmission Service" },
    { key: "coolant_flush", label: "Coolant Flush" },
    { key: "brake_fluid_flush", label: "Brake Fluid Flush" },
    { key: "power_steering_flush", label: "Power Steering Flush" },
    { key: "spark_plugs", label: "Spark Plugs" },
    { key: "battery_replacement", label: "Battery Replacement" },
    { key: "alignment", label: "Wheel Alignment" },
    { key: "timing_belt", label: "Timing Belt" },
    { key: "serpentine_belt", label: "Serpentine Belt" },
    { key: "fuel_filter", label: "Fuel Filter" },
    { key: "differential_service", label: "Differential Service" },
    { key: "wiper_blades", label: "Wiper Blades" },
    { key: "fuel_injection_service", label: "Fuel Injection Service" },
  ];

  useEffect(() => {
    if (enterpriseId) {
      loadData();
    }
  }, [enterpriseId]);

  const loadData = async () => {
    setLoading(true);
    try {
      const [entRes, mappingsRes] = await Promise.all([
        fetch(`/api/enterprise?id=${enterpriseId}`),
        fetch(`/api/enterprise/mappings?enterpriseId=${enterpriseId}`)
      ]);
      
      const entData = await entRes.json();
      const mappingsData = await mappingsRes.json();
      
      setEnterprise(entData.enterprise);
      setMappings(mappingsData.mappings || {});
      setOriginalMappings(mappingsData.mappings || {});
      
      if (entData.enterprise?.shopIds?.length > 0) {
        const jobsRes = await fetch(`/api/protractor/canned-jobs?shopId=${entData.enterprise.shopIds[0]}`);
        if (jobsRes.ok) {
          const jobsData = await jobsRes.json();
          setAvailableJobs(jobsData.cannedJobs || []);
        }
      }
    } catch (err) {
      console.error("Error loading data:", err);
    } finally {
      setLoading(false);
    }
  };

  const handleMappingChange = (serviceKey: string, jobId: string) => {
    setMappings(prev => ({
      ...prev,
      [serviceKey]: jobId
    }));
    setSaved(false);
  };

  const saveMappings = async () => {
    if (!enterpriseId) return;
    setSaving(true);
    
    try {
      const res = await fetch("/api/enterprise/mappings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          enterpriseId,
          mappings,
          applyToAllShops: applyToAll
        })
      });
      
      if (res.ok) {
        setOriginalMappings(mappings);
        setSaved(true);
        setTimeout(() => setSaved(false), 3000);
      }
    } catch (err) {
      console.error("Error saving mappings:", err);
    } finally {
      setSaving(false);
    }
  };

  const hasChanges = JSON.stringify(mappings) !== JSON.stringify(originalMappings);

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <RefreshCw className="w-8 h-8 animate-spin text-blue-600" />
      </div>
    );
  }

  if (!enterprise) {
    return (
      <div className="min-h-screen bg-gray-50 p-8">
        <div className="max-w-2xl mx-auto text-center">
          <p className="text-gray-600">Enterprise not found</p>
          <Link href="/admin/enterprise" className="text-blue-600 hover:underline mt-4 inline-block">
            Back to Enterprise Dashboard
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="bg-white border-b border-gray-200 sticky top-0 z-10">
        <div className="max-w-5xl mx-auto px-6 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-4">
              <Link href="/admin/enterprise" className="p-2 hover:bg-gray-100 rounded-lg">
                <ArrowLeft className="w-5 h-5 text-gray-600" />
              </Link>
              <div>
                <h1 className="text-xl font-bold text-gray-900">Shared Canned Job Mappings</h1>
                <p className="text-sm text-gray-500">{enterprise.name} - {enterprise.shopIds?.length || 0} locations</p>
              </div>
            </div>
            
            <div className="flex items-center gap-4">
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={applyToAll}
                  onChange={(e) => setApplyToAll(e.target.checked)}
                  className="rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                />
                Apply to all shops
              </label>
              
              <button
                onClick={saveMappings}
                disabled={saving || !hasChanges}
                className="inline-flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {saving ? (
                  <RefreshCw className="w-4 h-4 animate-spin" />
                ) : saved ? (
                  <Check className="w-4 h-4" />
                ) : (
                  <Save className="w-4 h-4" />
                )}
                {saved ? "Saved" : "Save Mappings"}
              </button>
            </div>
          </div>
        </div>
      </div>

      <div className="max-w-5xl mx-auto px-6 py-8">
        {availableJobs.length === 0 ? (
          <div className="bg-yellow-50 border border-yellow-200 rounded-xl p-6">
            <div className="flex items-start gap-3">
              <AlertCircle className="w-5 h-5 text-yellow-600 mt-0.5" />
              <div>
                <p className="font-medium text-yellow-800">No Canned Jobs Found</p>
                <p className="text-sm text-yellow-700 mt-1">
                  Connect Protractor to at least one shop in this enterprise to load available canned jobs.
                </p>
              </div>
            </div>
          </div>
        ) : (
          <div className="bg-white rounded-xl border border-gray-200">
            <div className="px-6 py-4 border-b border-gray-200">
              <p className="text-sm text-gray-600">
                Map common maintenance services to your shop&apos;s canned jobs. These mappings will be shared across all {enterprise.shopIds?.length || 0} locations.
              </p>
            </div>
            
            <div className="divide-y divide-gray-200">
              {commonServices.map((service) => (
                <div key={service.key} className="px-6 py-4 flex items-center justify-between">
                  <div>
                    <p className="font-medium text-gray-900">{service.label}</p>
                    <p className="text-sm text-gray-500">{service.key}</p>
                  </div>
                  <select
                    value={mappings[service.key] || ""}
                    onChange={(e) => handleMappingChange(service.key, e.target.value)}
                    className="w-64 px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500"
                  >
                    <option value="">Not mapped</option>
                    {availableJobs.map((job) => (
                      <option key={job.id} value={job.id}>
                        {job.name} {job.code ? `(${job.code})` : ""}
                      </option>
                    ))}
                  </select>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export default function MappingsPage() {
  return (
    <Suspense fallback={
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <RefreshCw className="w-8 h-8 animate-spin text-blue-600" />
      </div>
    }>
      <MappingsContent />
    </Suspense>
  );
}
