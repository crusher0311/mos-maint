"use client";

import { useState } from "react";
import Link from "next/link";
import { 
  ArrowLeft, 
  Car, 
  FileText, 
  History, 
  CheckCircle, 
  AlertCircle,
  Clock,
  User,
  Gauge,
  Calendar,
  ExternalLink,
  ChevronDown,
  Edit2
} from "lucide-react";

interface VehicleDetailClientProps {
  vehicle: any;
  ownerName: string;
  ros: any[];
  resolvedMiles: number | null;
  dvi: any;
  carfax: any;
  localOe: any;
  mpd: any;
  latestRoNumber: string | null;
  cfg: { configured: boolean };
  carfaxCfg: { configured: boolean };
}

type TabId = "attributes" | "recs" | "history";

export default function VehicleDetailClient({
  vehicle,
  ownerName,
  ros,
  resolvedMiles,
  dvi,
  carfax,
  localOe,
  mpd,
  latestRoNumber,
  cfg,
  carfaxCfg
}: VehicleDetailClientProps) {
  const [activeTab, setActiveTab] = useState<TabId>("attributes");
  const [expandedCategories, setExpandedCategories] = useState<Set<string>>(new Set());

  const toggleCategory = (cat: string) => {
    const next = new Set(expandedCategories);
    if (next.has(cat)) {
      next.delete(cat);
    } else {
      next.add(cat);
    }
    setExpandedCategories(next);
  };

  const miles = resolvedMiles ?? vehicle.lastMileage ?? vehicle.odometer ?? null;
  const vehicleTitle = [vehicle.year, vehicle.make, vehicle.model].filter(Boolean).join(" ") || "Vehicle";

  const tabs = [
    { id: "attributes" as TabId, label: "Attributes" },
    { id: "recs" as TabId, label: "Recs" },
    { id: "history" as TabId, label: "History" }
  ];

  const oemByCategory = localOe?.items?.reduce((acc: any, item: any) => {
    const cat = item.category || "Other";
    if (!acc[cat]) acc[cat] = [];
    acc[cat].push(item);
    return acc;
  }, {}) || {};

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <header className="bg-white border-b border-gray-200 px-6 py-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-4">
            <Link 
              href="/dashboard" 
              className="p-2 text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded-lg transition-colors"
            >
              <ArrowLeft className="w-5 h-5" />
            </Link>
            <div>
              <h1 className="text-xl font-semibold text-gray-900">
                {ownerName ? `${ownerName}'s ${vehicleTitle}` : vehicleTitle}
              </h1>
              <div className="flex items-center gap-2 mt-1">
                <Gauge className="w-4 h-4 text-blue-600" />
                <span className="text-sm text-gray-600">
                  {miles ? `${miles.toLocaleString()} miles` : "Mileage unknown"}
                </span>
                <button className="p-1 text-gray-400 hover:text-gray-600">
                  <Edit2 className="w-3 h-3" />
                </button>
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Link
              href={`/dashboard/vehicles/${vehicle.vin}/plan`}
              className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors text-sm font-medium"
            >
              View Plan
            </Link>
          </div>
        </div>
      </header>

      <div className="flex-1 overflow-auto p-6">
        <div className="max-w-4xl mx-auto">
          <div className="border-b border-gray-200 mb-6">
            <nav className="flex gap-6">
              {tabs.map((tab) => (
                <button
                  key={tab.id}
                  onClick={() => setActiveTab(tab.id)}
                  className={`py-3 text-sm font-medium border-b-2 transition-colors ${
                    activeTab === tab.id
                      ? 'border-blue-600 text-blue-600'
                      : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
                  }`}
                >
                  {tab.label}
                </button>
              ))}
            </nav>
          </div>

          {activeTab === "attributes" && (
            <div className="space-y-6">
              <div className="bg-white rounded-xl border border-gray-200 p-6">
                <div className="grid grid-cols-2 gap-4 text-sm">
                  <div>
                    <span className="text-gray-500">VIN</span>
                    <div className="font-mono text-gray-900 flex items-center gap-2">
                      {vehicle.vin}
                      <button className="p-1 text-gray-400 hover:text-gray-600">
                        <Edit2 className="w-3 h-3" />
                      </button>
                    </div>
                  </div>
                  {vehicle.license && (
                    <div>
                      <span className="text-gray-500">License Plate</span>
                      <div className="text-gray-900">{vehicle.license}</div>
                    </div>
                  )}
                  <div>
                    <span className="text-gray-500">Year/Make/Model</span>
                    <div className="text-gray-900">{vehicleTitle}</div>
                  </div>
                  <div>
                    <span className="text-gray-500">Last Updated</span>
                    <div className="text-gray-900">
                      {vehicle.updatedAt ? new Date(vehicle.updatedAt).toLocaleDateString() : "—"}
                    </div>
                  </div>
                </div>
              </div>

              <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
                <div className="px-6 py-4 border-b border-gray-200 flex items-center justify-between">
                  <h3 className="font-semibold text-gray-900">Status</h3>
                  <select className="text-sm border border-gray-300 rounded-lg px-3 py-1.5 focus:ring-2 focus:ring-blue-500 focus:border-blue-500">
                    <option>Needing review</option>
                    <option>In progress</option>
                    <option>Completed</option>
                  </select>
                </div>

                {Object.entries(oemByCategory).map(([category, items]: [string, any]) => (
                  <div key={category} className="border-b border-gray-200 last:border-b-0">
                    <button
                      onClick={() => toggleCategory(category)}
                      className="w-full px-6 py-4 flex items-center justify-between hover:bg-gray-50 transition-colors"
                    >
                      <div className="flex items-center gap-2">
                        <span className="font-medium text-gray-900">{category}</span>
                        <span className="text-xs bg-blue-100 text-blue-700 px-2 py-0.5 rounded-full font-medium">
                          OEM
                        </span>
                      </div>
                      <ChevronDown className={`w-5 h-5 text-gray-400 transition-transform ${
                        expandedCategories.has(category) ? 'rotate-180' : ''
                      }`} />
                    </button>
                    {expandedCategories.has(category) && (
                      <div className="px-6 pb-4 space-y-2">
                        {items.map((item: any, idx: number) => (
                          <div key={idx} className="flex items-center justify-between py-2 border-b border-gray-100 last:border-b-0">
                            <div className="flex-1">
                              <span className="text-sm text-gray-700">{item.name}</span>
                              {(item.miles || item.months) && (
                                <div className="text-xs text-gray-500 mt-0.5">
                                  {item.miles && <span>Every {item.miles.toLocaleString()} mi</span>}
                                  {item.miles && item.months && <span> · </span>}
                                  {item.months && <span>Every {item.months} mo</span>}
                                </div>
                              )}
                            </div>
                            <div className="flex items-center gap-3">
                              <input 
                                type="checkbox" 
                                className="w-5 h-5 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                              />
                              <button className="p-1 text-gray-400 hover:text-gray-600">
                                <User className="w-4 h-4" />
                              </button>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                ))}

                {Object.keys(oemByCategory).length === 0 && (
                  <div className="px-6 py-8 text-center text-gray-500">
                    No OEM maintenance items found for this vehicle.
                  </div>
                )}
              </div>
            </div>
          )}

          {activeTab === "recs" && (
            <div className="space-y-6">
              {dvi?.ok && Array.isArray(dvi.categories) && dvi.categories.length > 0 ? (
                <div className="space-y-4">
                  {dvi.categories.map((cat: any, i: number) => (
                    <div key={i} className="bg-white rounded-xl border border-gray-200 overflow-hidden">
                      <div className="px-6 py-4 border-b border-gray-200 bg-gray-50">
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-2">
                            <h3 className="font-medium text-gray-900">{cat.name || "Category"}</h3>
                            <span className="text-xs bg-orange-100 text-orange-700 px-2 py-0.5 rounded-full font-medium">
                              DVI
                            </span>
                          </div>
                          {cat.video && (
                            <span className="text-xs bg-blue-100 text-blue-700 px-2 py-1 rounded-full">
                              Has Video
                            </span>
                          )}
                        </div>
                      </div>
                      <div className="divide-y divide-gray-100">
                        {Array.isArray(cat.items) && cat.items.map((item: any, j: number) => (
                          <div key={j} className="px-6 py-3 flex items-center justify-between">
                            <div className="flex items-center gap-3">
                              {item.status === "2" ? (
                                <CheckCircle className="w-5 h-5 text-green-500" />
                              ) : item.status === "1" ? (
                                <AlertCircle className="w-5 h-5 text-yellow-500" />
                              ) : item.status === "0" ? (
                                <AlertCircle className="w-5 h-5 text-red-500" />
                              ) : (
                                <Clock className="w-5 h-5 text-gray-400" />
                              )}
                              <span className="text-sm text-gray-700">{item.name}</span>
                            </div>
                            {item.notes && (
                              <span className="text-xs text-gray-500 max-w-xs truncate">
                                {item.notes}
                              </span>
                            )}
                          </div>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="bg-white rounded-xl border border-gray-200 p-8 text-center">
                  <div className="w-12 h-12 bg-gray-100 rounded-full flex items-center justify-center mx-auto mb-4">
                    <FileText className="w-6 h-6 text-gray-400" />
                  </div>
                  <h3 className="font-medium text-gray-900 mb-2">No DVI Inspection</h3>
                  <p className="text-sm text-gray-500 mb-4">
                    {!cfg.configured 
                      ? "AutoFlow is not connected. Connect it to view DVI results."
                      : !latestRoNumber
                      ? "No repair orders found for this vehicle."
                      : dvi?.ok
                      ? "No inspection was performed for the latest repair order."
                      : dvi?.error || "Unable to load DVI results."}
                  </p>
                  {!cfg.configured && (
                    <Link
                      href="/dashboard/settings/autoflow"
                      className="text-sm text-blue-600 hover:text-blue-700 font-medium"
                    >
                      Connect AutoFlow
                    </Link>
                  )}
                </div>
              )}
            </div>
          )}

          {activeTab === "history" && (
            <div className="space-y-6">
              <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
                <div className="px-6 py-4 border-b border-gray-200 flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <h3 className="font-semibold text-gray-900">Repair Orders</h3>
                    <span className="text-xs bg-green-100 text-green-700 px-2 py-0.5 rounded-full font-medium">
                      Shop
                    </span>
                  </div>
                  {ros.length > 0 && (
                    <span className="text-xs text-gray-500">{ros.length} records</span>
                  )}
                </div>
                {ros.length > 0 ? (
                  <div className="divide-y divide-gray-200">
                    {ros.map((ro: any, i: number) => (
                      <div key={i} className="px-6 py-4 flex items-center justify-between">
                        <div>
                          <div className="font-medium text-gray-900">RO #{ro.roNumber}</div>
                          <div className="text-sm text-gray-500">
                            {ro.updatedAt ? new Date(ro.updatedAt).toLocaleDateString() : "—"}
                          </div>
                        </div>
                        <div className="flex items-center gap-4">
                          <span className="text-sm text-gray-600">
                            {ro.mileage ? `${ro.mileage.toLocaleString()} mi` : "—"}
                          </span>
                          <span className={`text-xs px-2 py-1 rounded-full ${
                            ro.status?.toLowerCase().includes('close')
                              ? 'bg-green-100 text-green-700'
                              : 'bg-gray-100 text-gray-700'
                          }`}>
                            {ro.status || "Unknown"}
                          </span>
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="px-6 py-8 text-center text-gray-500">
                    No repair orders found for this vehicle.
                  </div>
                )}
              </div>

              {carfax?.ok && Array.isArray(carfax.serviceRecords) && carfax.serviceRecords.length > 0 && (
                <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
                  <div className="px-6 py-4 border-b border-gray-200 flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <h3 className="font-semibold text-gray-900">Service History</h3>
                      <span className="text-xs bg-purple-100 text-purple-700 px-2 py-0.5 rounded-full font-medium">
                        CARFAX
                      </span>
                    </div>
                    <span className="text-xs text-gray-500">
                      {carfax.serviceRecords.length} records
                    </span>
                  </div>
                  <div className="divide-y divide-gray-200">
                    {carfax.serviceRecords.map((record: any, i: number) => (
                      <div key={i} className="px-6 py-3 flex items-start justify-between">
                        <div className="flex-1">
                          <div className="text-sm text-gray-900">{record.description || "Service"}</div>
                          <div className="text-xs text-gray-500">{record.date}</div>
                        </div>
                        {record.odometer && (
                          <span className="text-sm text-gray-600">
                            {record.odometer.toLocaleString()} mi
                          </span>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {(!carfax?.ok || !carfax.serviceRecords?.length) && (
                <div className="bg-white rounded-xl border border-gray-200 p-8 text-center">
                  <div className="w-12 h-12 bg-gray-100 rounded-full flex items-center justify-center mx-auto mb-4">
                    <History className="w-6 h-6 text-gray-400" />
                  </div>
                  <h3 className="font-medium text-gray-900 mb-2">No CARFAX History</h3>
                  <p className="text-sm text-gray-500 mb-4">
                    {!carfaxCfg.configured 
                      ? "CARFAX is not connected. Connect it to view service history."
                      : "No service records found in CARFAX."}
                  </p>
                  {!carfaxCfg.configured && (
                    <Link
                      href="/dashboard/settings/carfax"
                      className="text-sm text-blue-600 hover:text-blue-700 font-medium"
                    >
                      Connect CARFAX
                    </Link>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
