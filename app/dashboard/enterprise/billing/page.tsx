"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { 
  ArrowLeft, 
  Building2, 
  CreditCard, 
  MapPin, 
  Users,
  TrendingUp,
  Check,
  AlertCircle,
  Loader2,
  ExternalLink,
  Receipt,
  Settings
} from "lucide-react";

interface LocationBilling {
  shopId: number;
  name: string;
  locationIdentifier: string | null;
  plan: string;
  planDisplay: string;
  status: string;
  vehicleCount: number;
  vinLimit: number | null;
  nextBillingDate: string | null;
  enabledFeatures: string[];
}

interface EnterpriseBilling {
  enterprise: {
    id: string;
    name: string;
    hasEnterpriseBilling: boolean;
    plan: string | null;
    status: string | null;
    stripeCustomerId: string | null;
    nextBillingDate: string | null;
  };
  summary: {
    totalLocations: number;
    activeLocations: number;
    totalVehicles: number;
  };
  locations: LocationBilling[];
}

export default function EnterpriseBillingPage() {
  const [data, setData] = useState<EnterpriseBilling | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    loadBillingData();
  }, []);

  const loadBillingData = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/enterprise/billing");
      const json = await res.json();
      
      if (!res.ok) {
        setError(json.error || "Failed to load billing data");
        return;
      }
      
      setData(json);
    } catch (err) {
      console.error("Error loading billing data:", err);
      setError("Failed to load billing data");
    } finally {
      setLoading(false);
    }
  };

  const getStatusColor = (status: string) => {
    switch (status) {
      case "active":
        return "bg-green-100 text-green-700";
      case "trial":
        return "bg-blue-100 text-blue-700";
      case "past_due":
        return "bg-amber-100 text-amber-700";
      case "canceled":
        return "bg-red-100 text-red-700";
      default:
        return "bg-gray-100 text-gray-700";
    }
  };

  const getPlanColor = (plan: string) => {
    switch (plan) {
      case "enterprise":
        return "bg-purple-100 text-purple-700";
      case "elite":
        return "bg-indigo-100 text-indigo-700";
      case "plus":
        return "bg-blue-100 text-blue-700";
      case "starter":
        return "bg-teal-100 text-teal-700";
      case "professional":
        return "bg-green-100 text-green-700";
      default:
        return "bg-gray-100 text-gray-700";
    }
  };

  if (loading) {
    return (
      <div className="flex-1 p-8">
        <div className="flex items-center justify-center h-64">
          <Loader2 className="w-8 h-8 animate-spin text-blue-600" />
        </div>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="flex-1 p-8">
        <div className="max-w-4xl mx-auto">
          <Link 
            href="/dashboard/enterprise" 
            className="inline-flex items-center gap-2 text-gray-600 hover:text-gray-900 mb-6"
          >
            <ArrowLeft className="w-4 h-4" />
            Back to Enterprise
          </Link>
          <div className="bg-red-50 border border-red-200 rounded-xl p-6 text-center">
            <AlertCircle className="w-12 h-12 text-red-400 mx-auto mb-3" />
            <h3 className="font-medium text-red-900 mb-1">Unable to Load Billing</h3>
            <p className="text-sm text-red-700">{error || "An error occurred"}</p>
            <button 
              onClick={loadBillingData}
              className="mt-4 px-4 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700"
            >
              Try Again
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 p-8 bg-gray-50 min-h-screen">
      <div className="max-w-6xl mx-auto">
        <Link 
          href="/dashboard/enterprise" 
          className="inline-flex items-center gap-2 text-gray-600 hover:text-gray-900 mb-6"
        >
          <ArrowLeft className="w-4 h-4" />
          Back to Enterprise
        </Link>

        <div className="flex items-center justify-between mb-8">
          <div className="flex items-center gap-4">
            <div className="w-12 h-12 bg-gradient-to-br from-blue-500 to-blue-600 rounded-xl flex items-center justify-center">
              <CreditCard className="w-6 h-6 text-white" />
            </div>
            <div>
              <h1 className="text-2xl font-bold text-gray-900">Enterprise Billing</h1>
              <p className="text-gray-500">{data.enterprise.name} - Manage billing across all locations</p>
            </div>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-8">
          <div className="bg-white rounded-xl border border-gray-200 p-6">
            <div className="flex items-center gap-3 mb-3">
              <div className="w-10 h-10 bg-blue-100 rounded-lg flex items-center justify-center">
                <MapPin className="w-5 h-5 text-blue-600" />
              </div>
              <div>
                <p className="text-sm text-gray-500">Total Locations</p>
                <p className="text-2xl font-bold text-gray-900">{data.summary.totalLocations}</p>
              </div>
            </div>
            <p className="text-sm text-gray-500">
              {data.summary.activeLocations} active
            </p>
          </div>

          <div className="bg-white rounded-xl border border-gray-200 p-6">
            <div className="flex items-center gap-3 mb-3">
              <div className="w-10 h-10 bg-green-100 rounded-lg flex items-center justify-center">
                <TrendingUp className="w-5 h-5 text-green-600" />
              </div>
              <div>
                <p className="text-sm text-gray-500">Total Vehicles</p>
                <p className="text-2xl font-bold text-gray-900">{data.summary.totalVehicles.toLocaleString()}</p>
              </div>
            </div>
            <p className="text-sm text-gray-500">
              Across all locations
            </p>
          </div>

          <div className="bg-white rounded-xl border border-gray-200 p-6">
            <div className="flex items-center gap-3 mb-3">
              <div className="w-10 h-10 bg-purple-100 rounded-lg flex items-center justify-center">
                <Building2 className="w-5 h-5 text-purple-600" />
              </div>
              <div>
                <p className="text-sm text-gray-500">Enterprise Plan</p>
                <p className="text-2xl font-bold text-gray-900">
                  {data.enterprise.hasEnterpriseBilling ? (data.enterprise.plan || "Enterprise") : "Per-Location"}
                </p>
              </div>
            </div>
            <p className="text-sm text-gray-500">
              {data.enterprise.hasEnterpriseBilling ? "Consolidated billing" : "Each location billed separately"}
            </p>
          </div>
        </div>

        <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
          <div className="px-6 py-4 border-b border-gray-200 flex items-center justify-between">
            <h2 className="font-semibold text-gray-900">Location Billing Details</h2>
            <span className="text-sm text-gray-500">{data.locations.length} locations</span>
          </div>

          <div className="divide-y divide-gray-100">
            {data.locations.map((location) => (
              <div key={location.shopId} className="px-6 py-4 hover:bg-gray-50 transition-colors">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-4">
                    <div className="w-10 h-10 bg-gray-100 rounded-lg flex items-center justify-center">
                      <MapPin className="w-5 h-5 text-gray-600" />
                    </div>
                    <div>
                      <h3 className="font-medium text-gray-900">{location.name}</h3>
                      {location.locationIdentifier && (
                        <p className="text-sm text-gray-500">{location.locationIdentifier}</p>
                      )}
                    </div>
                  </div>

                  <div className="flex items-center gap-6">
                    <div className="text-right">
                      <p className="text-sm text-gray-500">Vehicles</p>
                      <p className="font-medium text-gray-900">
                        {location.vehicleCount.toLocaleString()}
                        {location.vinLimit && (
                          <span className="text-gray-400"> / {location.vinLimit}</span>
                        )}
                      </p>
                    </div>

                    <div className="flex items-center gap-2">
                      <span className={`px-2.5 py-1 text-xs font-medium rounded-full ${getPlanColor(location.plan)}`}>
                        {location.planDisplay}
                      </span>
                      <span className={`px-2.5 py-1 text-xs font-medium rounded-full ${getStatusColor(location.status)}`}>
                        {location.status.charAt(0).toUpperCase() + location.status.slice(1)}
                      </span>
                    </div>

                    <div className="flex items-center gap-2">
                      {location.enabledFeatures.length > 0 && (
                        <span className="text-xs text-gray-500">
                          {location.enabledFeatures.length} features
                        </span>
                      )}
                    </div>
                  </div>
                </div>

                {location.nextBillingDate && (
                  <div className="mt-2 ml-14">
                    <p className="text-xs text-gray-500">
                      Next billing: {new Date(location.nextBillingDate).toLocaleDateString()}
                    </p>
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>

        <div className="mt-8 bg-gradient-to-br from-blue-50 to-indigo-50 rounded-xl border border-blue-200 p-6">
          <div className="flex items-start gap-4">
            <div className="w-12 h-12 bg-blue-100 rounded-xl flex items-center justify-center flex-shrink-0">
              <Receipt className="w-6 h-6 text-blue-600" />
            </div>
            <div className="flex-1">
              <h3 className="font-semibold text-gray-900 mb-1">Need Consolidated Billing?</h3>
              <p className="text-sm text-gray-600 mb-4">
                Contact us to set up enterprise-wide billing with a single invoice for all your locations, 
                volume discounts, and dedicated account management.
              </p>
              <Link
                href="/dashboard/support"
                className="inline-flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors text-sm font-medium"
              >
                <Settings className="w-4 h-4" />
                Contact Support
              </Link>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
