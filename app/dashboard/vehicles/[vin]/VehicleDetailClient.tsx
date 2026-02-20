"use client";

import { useState, useCallback, useEffect } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
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
  Edit2,
  XCircle,
  Ban
} from "lucide-react";

interface DeclinedService {
  serviceKey: string;
  serviceName: string;
  mileage?: number | null;
  reason?: string | null;
  declinedAt: string;
}

interface TekmetricInspectionItem {
  name: string;
  status: string;
  notes?: string;
  source: 'tekmetric';
}

interface TekmetricDvi {
  ok: boolean;
  source: 'tekmetric';
  inspections: TekmetricInspectionItem[];
  items: TekmetricInspectionItem[];
}

interface ProtractorInspectionItem {
  name: string;
  status: string;
  notes?: string;
  severity?: string;
  source: 'protractor';
}

interface ProtractorDvi {
  ok: boolean;
  source: 'protractor';
  inspections: any[];
  items: ProtractorInspectionItem[];
}

interface RepairOrderSummary {
  roNumber: string;
  status?: string;
  mileage?: number;
  updatedAt?: string;
  createdAt?: string;
}

interface DviCategory {
  name?: string;
  video?: string;
  videoNotes?: string;
  items?: Array<{
    name: string;
    status: string;
    notes?: string;
    videos?: string[];
    pictures?: string[];
  }>;
}

interface DviResult {
  ok: boolean;
  categories?: DviCategory[];
  error?: string;
}

interface CarfaxResult {
  ok: boolean;
  serviceRecords?: Array<{
    date?: string;
    odometer?: number;
    description?: string;
    source?: string;
  }>;
  error?: string;
}

interface OemItem {
  name: string;
  category?: string;
  miles?: number;
  months?: number;
}

interface LocalOeData {
  items?: OemItem[];
}

interface MpdData {
  mpdFromToday?: number | null;
  mpdFromTwo?: number | null;
  mpdBlended?: number | null;
}

interface VehicleDetailClientProps {
  vehicle: {
    vin: string;
    year?: number;
    make?: string;
    model?: string;
    license?: string;
    lastMileage?: number;
    odometer?: number;
    updatedAt?: string;
    hasComponents?: Record<string, boolean>;
    declinedServices?: DeclinedService[];
  };
  ownerName: string;
  ros: RepairOrderSummary[];
  resolvedMiles: number | null;
  mileageEstimated?: boolean;
  mileageEstimateDetails?: {
    confidence: string;
    dataPoints: number;
    lastRecordedMileage: number;
    lastRecordedDate: string;
    milesPerDay: number;
  } | null;
  dvi: DviResult;
  tekmetricDvi?: TekmetricDvi | null;
  protractorDvi?: ProtractorDvi | null;
  carfax: CarfaxResult;
  localOe: LocalOeData;
  mpd: MpdData;
  latestRoNumber: string | null;
  cfg: { configured: boolean };
  carfaxCfg: { configured: boolean };
  tekmetricConnected?: boolean;
  protractorConnected?: boolean;
}

type TabId = "oe" | "dvi" | "carfax" | "specs";

interface VehicleInfoDecoded {
  year?: string;
  make?: string;
  model?: string;
  trim?: string;
  style?: string;
  engine?: string;
  engineSize?: string;
  engineCylinders?: string;
  transmission?: string;
  transType?: string;
  driveType?: string;
  fuelType?: string;
  bodyType?: string;
  doors?: string;
  wheelbase?: string;
  brakeSystem?: string;
  countryOfMfr?: string;
}

interface VehicleSpecsGrouped {
  weightsAndCapacities: {
    fuelTankCapacity?: string;
    baseTowingCapacity?: string;
    maxTowingCapacity?: string;
    maxPayload?: string;
    curbWeight?: string;
    gvwr?: string;
    gcwr?: string;
    tonnage?: string;
  };
  wheelsAndTires: {
    frontTireDescription?: string;
    rearTireDescription?: string;
    frontWheelDiameter?: string;
    rearWheelDiameter?: string;
    frontWheelSize?: string;
    rearWheelSize?: string;
    tireType?: string;
  };
  brakes: {
    frontBrakeDiameter?: string;
    rearBrakeDiameter?: string;
  };
  dimensions: {
    length?: string;
    width?: string;
    height?: string;
    wheelbase?: string;
    groundClearance?: string;
    frontTrackWidth?: string;
    rearTrackWidth?: string;
  };
  truckSpecs: {
    bedLength?: string;
  };
  seating: {
    maxSeating?: string;
    standardSeating?: string;
  };
  interior: {
    cargoVolume?: string;
    passengerVolume?: string;
  };
}

export default function VehicleDetailClient({
  vehicle,
  ownerName,
  ros,
  resolvedMiles,
  mileageEstimated = false,
  mileageEstimateDetails = null,
  dvi,
  tekmetricDvi,
  protractorDvi,
  carfax,
  localOe,
  mpd,
  latestRoNumber,
  cfg,
  carfaxCfg,
  tekmetricConnected = false,
  protractorConnected = false
}: VehicleDetailClientProps) {
  const searchParams = useSearchParams();
  const tabParam = searchParams.get("tab") as TabId | null;
  const [activeTab, setActiveTab] = useState<TabId>(tabParam && ["oe", "dvi", "carfax", "specs"].includes(tabParam) ? tabParam : "oe");
  const [specsData, setSpecsData] = useState<VehicleSpecsGrouped | null>(null);
  const [vehicleInfo, setVehicleInfo] = useState<VehicleInfoDecoded | null>(null);
  const [specsLoading, setSpecsLoading] = useState(false);

  useEffect(() => {
    if (tabParam && ["oe", "dvi", "carfax", "specs"].includes(tabParam)) {
      setActiveTab(tabParam);
    }
  }, [tabParam]);

  useEffect(() => {
    if (activeTab === "specs" && !specsData && !specsLoading) {
      setSpecsLoading(true);
      fetch(`/api/vehicles/${vehicle.vin}/specs`)
        .then(res => res.json())
        .then(data => {
          if (data.ok) {
            setSpecsData(data.grouped);
          }
          if (data.vehicleInfo) {
            setVehicleInfo(data.vehicleInfo);
          }
        })
        .catch(console.error)
        .finally(() => setSpecsLoading(false));
    }
  }, [activeTab, vehicle.vin, specsData, specsLoading]);
  const [expandedCategories, setExpandedCategories] = useState<Set<string>>(new Set());
  const [hasComponents, setHasComponents] = useState<Record<string, boolean>>(
    vehicle.hasComponents || {}
  );
  const [savingComponent, setSavingComponent] = useState<string | null>(null);

  const toggleCategory = (cat: string) => {
    const next = new Set(expandedCategories);
    if (next.has(cat)) {
      next.delete(cat);
    } else {
      next.add(cat);
    }
    setExpandedCategories(next);
  };

  const toComponentKey = (itemName: string): string => {
    return itemName.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
  };

  const toggleComponent = useCallback(async (itemName: string, currentValue: boolean) => {
    const componentKey = toComponentKey(itemName);
    setSavingComponent(componentKey);
    const newValue = !currentValue;
    
    setHasComponents(prev => ({ ...prev, [componentKey]: newValue }));
    
    try {
      await fetch(`/api/vehicles/${vehicle.vin}/components`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ componentKey, hasComponent: newValue }),
      });
    } catch (err) {
      setHasComponents(prev => ({ ...prev, [componentKey]: currentValue }));
      console.error("Failed to save component:", err);
    } finally {
      setSavingComponent(null);
    }
  }, [vehicle.vin]);

  const miles = resolvedMiles ?? vehicle.lastMileage ?? vehicle.odometer ?? null;
  const vehicleTitle = [vehicle.year, vehicle.make, vehicle.model].filter(Boolean).join(" ") || "Vehicle";

  const tabs = [
    { id: "oe" as TabId, label: "OE" },
    { id: "dvi" as TabId, label: "DVI" },
    { id: "carfax" as TabId, label: "CARFAX" },
    { id: "specs" as TabId, label: "Specs" }
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
                {miles ? (
                  <span
                    className={`text-sm text-gray-600 ${mileageEstimated ? 'font-bold italic cursor-help border-b border-dashed border-gray-400' : ''}`}
                    title={mileageEstimated && mileageEstimateDetails
                      ? `Estimated from CARFAX (${mileageEstimateDetails.dataPoints} data points)\nLast recorded: ${mileageEstimateDetails.lastRecordedMileage.toLocaleString()} mi on ${mileageEstimateDetails.lastRecordedDate}\nAvg: ${mileageEstimateDetails.milesPerDay} mi/day`
                      : mileageEstimated ? 'Estimated from CARFAX service history' : undefined}
                  >
                    {miles.toLocaleString()} miles{mileageEstimated ? ' (est.)' : ''}
                  </span>
                ) : (
                  <span className="text-sm text-gray-600">Mileage unknown</span>
                )}
                <button className="p-1 text-gray-400 hover:text-gray-600">
                  <Edit2 className="w-3 h-3" />
                </button>
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Link
              href={`/dashboard/vehicles/${vehicle.vin}/plan`}
              className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors text-sm font-medium flex items-center gap-2"
            >
              <img src="/icons/vehicle-health-intelligence.png" alt="" className="w-5 h-5" />
              <span className="flex flex-col items-center leading-tight">
                <span>Vehicle Health Indicator</span>
                <span className="text-[10px] italic font-normal opacity-90">authentically intelligent</span>
              </span>
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

          {activeTab === "oe" && (
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
                                checked={hasComponents[toComponentKey(item.name)] ?? false}
                                onChange={() => toggleComponent(item.name, hasComponents[toComponentKey(item.name)] ?? false)}
                                disabled={savingComponent === toComponentKey(item.name)}
                                className="w-5 h-5 rounded border-gray-300 text-blue-600 focus:ring-blue-500 cursor-pointer disabled:opacity-50"
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

          {activeTab === "dvi" && (
            <div className="space-y-6">
              {/* Tekmetric DVI Inspections */}
              {tekmetricDvi?.ok && tekmetricDvi.items && tekmetricDvi.items.length > 0 && (
                <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
                  <div className="px-6 py-4 border-b border-gray-200 bg-gray-50">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <h3 className="font-medium text-gray-900">Tekmetric Inspection</h3>
                        <span className="text-xs bg-blue-100 text-blue-700 px-2 py-0.5 rounded-full font-medium">
                          Tekmetric
                        </span>
                      </div>
                      <span className="text-xs text-gray-500">{tekmetricDvi.items.length} items</span>
                    </div>
                  </div>
                  <div className="divide-y divide-gray-100">
                    {tekmetricDvi.items.map((item, j: number) => (
                      <div 
                        key={j} 
                        className={`px-6 py-3 flex items-center justify-between ${
                          item.status === "red" || item.status === "fail" ? "bg-red-50 border-l-4 border-red-500" :
                          item.status === "yellow" || item.status === "caution" ? "bg-yellow-50 border-l-4 border-yellow-400" :
                          ""
                        }`}
                      >
                        <div className="flex items-center gap-3">
                          {item.status === "pass" || item.status === "green" ? (
                            <CheckCircle className="w-5 h-5 text-green-500" />
                          ) : item.status === "yellow" || item.status === "caution" ? (
                            <AlertCircle className="w-5 h-5 text-yellow-500" />
                          ) : item.status === "red" || item.status === "fail" ? (
                            <XCircle className="w-5 h-5 text-red-600" />
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
              )}

              {/* Protractor DVI (AutoVitals data) */}
              {protractorDvi?.ok && protractorDvi.items && protractorDvi.items.length > 0 && (
                <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
                  <div className="px-6 py-4 border-b border-gray-200 bg-gray-50">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <h3 className="font-medium text-gray-900">Protractor Inspection</h3>
                        <span className="text-xs bg-purple-100 text-purple-700 px-2 py-0.5 rounded-full font-medium">
                          Protractor
                        </span>
                      </div>
                      <span className="text-xs text-gray-500">{protractorDvi.items.length} items</span>
                    </div>
                  </div>
                  <div className="divide-y divide-gray-100">
                    {protractorDvi.items.map((item, j: number) => {
                      const isRed = item.status?.toLowerCase() === "immediate" || item.status?.toLowerCase() === "fail" || item.severity?.toLowerCase() === "high";
                      const isYellow = item.status?.toLowerCase() === "needs attention" || item.status?.toLowerCase() === "caution" || item.severity?.toLowerCase() === "medium";
                      const isGreen = item.status?.toLowerCase() === "good" || item.status?.toLowerCase() === "pass";
                      
                      return (
                        <div 
                          key={j} 
                          className={`px-6 py-3 flex items-center justify-between ${
                            isRed ? "bg-red-50 border-l-4 border-red-500" :
                            isYellow ? "bg-yellow-50 border-l-4 border-yellow-400" :
                            ""
                          }`}
                        >
                          <div className="flex items-center gap-3">
                            {isGreen ? (
                              <CheckCircle className="w-5 h-5 text-green-500" />
                            ) : isYellow ? (
                              <AlertCircle className="w-5 h-5 text-yellow-500" />
                            ) : isRed ? (
                              <XCircle className="w-5 h-5 text-red-600" />
                            ) : (
                              <Clock className="w-5 h-5 text-gray-400" />
                            )}
                            <div>
                              <span className={`text-sm ${isRed ? "font-medium text-red-800" : "text-gray-700"}`}>
                                {item.name}
                              </span>
                              {isRed && (
                                <span className="ml-2 text-xs bg-red-600 text-white px-2 py-0.5 rounded-full font-medium">
                                  IMMEDIATE
                                </span>
                              )}
                              {isYellow && (
                                <span className="ml-2 text-xs bg-yellow-500 text-white px-2 py-0.5 rounded-full font-medium">
                                  NEEDS ATTENTION
                                </span>
                              )}
                            </div>
                          </div>
                          {item.notes && (
                            <span className="text-xs text-gray-500 max-w-xs truncate">
                              {item.notes}
                            </span>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* AutoFlow DVI */}
              {dvi?.ok && Array.isArray(dvi.categories) && dvi.categories.length > 0 ? (
                <div className="space-y-4">
                  {dvi.categories.map((cat: any, i: number) => {
                    const redCount = cat.items?.filter((it: any) => it.status === "0").length || 0;
                    const yellowCount = cat.items?.filter((it: any) => it.status === "1").length || 0;
                    return (
                    <div key={i} className="bg-white rounded-xl border border-gray-200 overflow-hidden">
                      <div className="px-6 py-4 border-b border-gray-200 bg-gray-50">
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-2">
                            <h3 className="font-medium text-gray-900">{cat.name || "Category"}</h3>
                            <span className="text-xs bg-orange-100 text-orange-700 px-2 py-0.5 rounded-full font-medium">
                              DVI
                            </span>
                          </div>
                          <div className="flex items-center gap-2">
                            {redCount > 0 && (
                              <span className="text-xs bg-red-100 text-red-700 px-2 py-0.5 rounded-full font-medium">
                                {redCount} Need Attention
                              </span>
                            )}
                            {yellowCount > 0 && (
                              <span className="text-xs bg-yellow-100 text-yellow-700 px-2 py-0.5 rounded-full font-medium">
                                {yellowCount} Caution
                              </span>
                            )}
                            {cat.video && (
                              <a 
                                href={cat.video} 
                                target="_blank" 
                                rel="noopener noreferrer"
                                className="text-xs bg-blue-100 text-blue-700 px-2 py-1 rounded-full hover:bg-blue-200 flex items-center gap-1"
                              >
                                <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 20 20">
                                  <path d="M6.3 2.841A1.5 1.5 0 004 4.11V15.89a1.5 1.5 0 002.3 1.269l9.344-5.89a1.5 1.5 0 000-2.538L6.3 2.84z"/>
                                </svg>
                                Watch Video
                              </a>
                            )}
                          </div>
                        </div>
                      </div>
                      <div className="divide-y divide-gray-100">
                        {Array.isArray(cat.items) && cat.items.map((item: any, j: number) => (
                          <div 
                            key={j} 
                            className={`px-6 py-3 flex items-center justify-between ${
                              item.status === "0" ? "bg-red-50 border-l-4 border-red-500" :
                              item.status === "1" ? "bg-yellow-50 border-l-4 border-yellow-400" :
                              ""
                            }`}
                          >
                            <div className="flex items-center gap-3">
                              {item.status === "2" ? (
                                <CheckCircle className="w-5 h-5 text-green-500" />
                              ) : item.status === "1" ? (
                                <AlertCircle className="w-5 h-5 text-yellow-500" />
                              ) : item.status === "0" ? (
                                <XCircle className="w-5 h-5 text-red-600" />
                              ) : (
                                <Clock className="w-5 h-5 text-gray-400" />
                              )}
                              <div>
                                <span className={`text-sm ${item.status === "0" ? "font-medium text-red-800" : "text-gray-700"}`}>
                                  {item.name}
                                </span>
                                {item.status === "0" && (
                                  <span className="ml-2 text-xs bg-red-600 text-white px-2 py-0.5 rounded-full font-medium">
                                    NEEDS ATTENTION
                                  </span>
                                )}
                                {item.status === "1" && (
                                  <span className="ml-2 text-xs bg-yellow-500 text-white px-2 py-0.5 rounded-full font-medium">
                                    CAUTION
                                  </span>
                                )}
                              </div>
                            </div>
                            <div className="flex items-center gap-2">
                              {item.notes && (
                                <span className="text-xs text-gray-500 max-w-xs truncate">
                                  {item.notes}
                                </span>
                              )}
                              {item.videos && item.videos.length > 0 && (
                                <a 
                                  href={item.videos[0]} 
                                  target="_blank" 
                                  rel="noopener noreferrer"
                                  className="text-xs bg-blue-100 text-blue-700 px-2 py-0.5 rounded-full hover:bg-blue-200 flex items-center gap-1"
                                >
                                  <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 20 20">
                                    <path d="M6.3 2.841A1.5 1.5 0 004 4.11V15.89a1.5 1.5 0 002.3 1.269l9.344-5.89a1.5 1.5 0 000-2.538L6.3 2.84z"/>
                                  </svg>
                                  Video
                                </a>
                              )}
                              {item.pictures && item.pictures.length > 0 && (
                                <a 
                                  href={item.pictures[0]} 
                                  target="_blank" 
                                  rel="noopener noreferrer"
                                  className="text-xs bg-green-100 text-green-700 px-2 py-0.5 rounded-full hover:bg-green-200 flex items-center gap-1"
                                >
                                  <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 20 20">
                                    <path fillRule="evenodd" d="M1 5.25A2.25 2.25 0 013.25 3h13.5A2.25 2.25 0 0119 5.25v9.5A2.25 2.25 0 0116.75 17H3.25A2.25 2.25 0 011 14.75v-9.5zm1.5 5.81v3.69c0 .414.336.75.75.75h13.5a.75.75 0 00.75-.75v-2.69l-2.22-2.219a.75.75 0 00-1.06 0l-1.91 1.909.47.47a.75.75 0 11-1.06 1.06L6.53 8.091a.75.75 0 00-1.06 0L2.5 11.06zm10-1.56a1.75 1.75 0 100-3.5 1.75 1.75 0 000 3.5z" clipRule="evenodd"/>
                                  </svg>
                                  Photo
                                </a>
                              )}
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )})}
                </div>
              ) : !tekmetricDvi?.ok && !protractorDvi?.ok ? (
                <div className="bg-white rounded-xl border border-gray-200 p-8 text-center">
                  <div className="w-12 h-12 bg-gray-100 rounded-full flex items-center justify-center mx-auto mb-4">
                    <FileText className="w-6 h-6 text-gray-400" />
                  </div>
                  <h3 className="font-medium text-gray-900 mb-2">No DVI Inspection</h3>
                  <p className="text-sm text-gray-500 mb-4">
                    {!cfg.configured && !tekmetricConnected && !protractorConnected
                      ? "No inspection system is connected. Connect AutoFlow, Tekmetric, or Protractor to view DVI results."
                      : !latestRoNumber
                      ? "No repair orders found for this vehicle."
                      : protractorConnected && !protractorDvi?.ok
                      ? "No Protractor inspection data available for this vehicle."
                      : tekmetricConnected && !tekmetricDvi?.ok
                      ? "No Tekmetric inspection data available for this vehicle."
                      : dvi?.ok
                      ? "No inspection was performed for the latest repair order."
                      : dvi?.error || "Unable to load DVI results."}
                  </p>
                  {!cfg.configured && !tekmetricConnected && !protractorConnected && (
                    <Link
                      href="/dashboard/settings/autoflow"
                      className="text-sm text-blue-600 hover:text-blue-700 font-medium"
                    >
                      Connect AutoFlow
                    </Link>
                  )}
                </div>
              ) : null}
            </div>
          )}

          {activeTab === "carfax" && (
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

              {vehicle.declinedServices && vehicle.declinedServices.length > 0 && (
                <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
                  <div className="px-6 py-4 border-b border-gray-200 flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <h3 className="font-semibold text-gray-900">Declined Services</h3>
                      <span className="text-xs bg-red-100 text-red-700 px-2 py-0.5 rounded-full font-medium">
                        DECLINED
                      </span>
                    </div>
                    <span className="text-xs text-gray-500">
                      {vehicle.declinedServices.length} items
                    </span>
                  </div>
                  <div className="divide-y divide-gray-200">
                    {vehicle.declinedServices.map((declined: DeclinedService, i: number) => (
                      <div key={i} className="px-6 py-3 flex items-start justify-between">
                        <div className="flex items-center gap-2">
                          <Ban className="w-4 h-4 text-red-500 flex-shrink-0" />
                          <div className="flex-1">
                            <div className="text-sm text-gray-900">{declined.serviceName}</div>
                            <div className="text-xs text-gray-500">
                              {declined.declinedAt ? new Date(declined.declinedAt).toLocaleDateString() : ""}
                              {declined.mileage && ` at ${declined.mileage.toLocaleString()} mi`}
                              {declined.reason && ` - ${declined.reason}`}
                            </div>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {carfax?.ok && Array.isArray(carfax.serviceRecords) && carfax.serviceRecords.length > 0 && (
                <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
                  <div className="px-6 py-4 border-b border-gray-200 flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <h3 className="font-semibold text-gray-900">Service History</h3>
                      <img src="/badges/carfax.png" alt="CARFAX" className="h-4" />
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

          {activeTab === "specs" && (
            <div className="space-y-6">
              {specsLoading ? (
                <div className="bg-white rounded-xl border border-gray-200 p-8 text-center">
                  <div className="animate-spin w-8 h-8 border-2 border-blue-600 border-t-transparent rounded-full mx-auto mb-4"></div>
                  <p className="text-sm text-gray-500">Loading specifications...</p>
                </div>
              ) : (specsData || vehicleInfo) ? (
                <>
                  {vehicleInfo && (
                    <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
                      <div className="px-6 py-4 border-b border-gray-200 bg-indigo-50">
                        <h3 className="font-semibold text-gray-900 flex items-center gap-2">
                          <span>&#x2699;&#xFE0F;</span> Powertrain
                        </h3>
                      </div>
                      <div className="p-6 grid grid-cols-2 sm:grid-cols-3 gap-4">
                        {vehicleInfo.engine && (
                          <div>
                            <div className="text-xs text-gray-500 uppercase">Engine</div>
                            <div className="font-semibold text-gray-900">{vehicleInfo.engine}</div>
                          </div>
                        )}
                        {vehicleInfo.engineSize && (
                          <div>
                            <div className="text-xs text-gray-500 uppercase">Displacement</div>
                            <div className="font-semibold text-gray-900">{vehicleInfo.engineSize}L</div>
                          </div>
                        )}
                        {vehicleInfo.engineCylinders && (
                          <div>
                            <div className="text-xs text-gray-500 uppercase">Cylinders</div>
                            <div className="font-semibold text-gray-900">{vehicleInfo.engineCylinders}</div>
                          </div>
                        )}
                        {vehicleInfo.transmission && (
                          <div>
                            <div className="text-xs text-gray-500 uppercase">Transmission</div>
                            <div className="font-semibold text-gray-900">{vehicleInfo.transmission}</div>
                          </div>
                        )}
                        {vehicleInfo.transType && (
                          <div>
                            <div className="text-xs text-gray-500 uppercase">Trans Type</div>
                            <div className="font-semibold text-gray-900">{vehicleInfo.transType}</div>
                          </div>
                        )}
                        {vehicleInfo.driveType && (
                          <div>
                            <div className="text-xs text-gray-500 uppercase">Drive Type</div>
                            <div className="font-semibold text-gray-900">{vehicleInfo.driveType}</div>
                          </div>
                        )}
                        {vehicleInfo.fuelType && (
                          <div>
                            <div className="text-xs text-gray-500 uppercase">Fuel Type</div>
                            <div className="font-semibold text-gray-900">{vehicleInfo.fuelType}</div>
                          </div>
                        )}
                        {vehicleInfo.brakeSystem && (
                          <div>
                            <div className="text-xs text-gray-500 uppercase">Brake System</div>
                            <div className="font-semibold text-gray-900">{vehicleInfo.brakeSystem}</div>
                          </div>
                        )}
                      </div>
                    </div>
                  )}

                  {specsData && Object.keys(specsData.weightsAndCapacities).length > 0 && (
                    <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
                      <div className="px-6 py-4 border-b border-gray-200 bg-blue-50">
                        <h3 className="font-semibold text-gray-900 flex items-center gap-2">
                          <span>⚖️</span> Weights & Capacities
                        </h3>
                      </div>
                      <div className="p-6 grid grid-cols-2 sm:grid-cols-3 gap-4">
                        {specsData.weightsAndCapacities.fuelTankCapacity && (
                          <div>
                            <div className="text-xs text-gray-500 uppercase">Fuel Tank</div>
                            <div className="font-semibold text-gray-900">{specsData.weightsAndCapacities.fuelTankCapacity} gal</div>
                          </div>
                        )}
                        {specsData.weightsAndCapacities.baseTowingCapacity && (
                          <div>
                            <div className="text-xs text-gray-500 uppercase">Base Towing</div>
                            <div className="font-semibold text-gray-900">{Number(specsData.weightsAndCapacities.baseTowingCapacity).toLocaleString()} lbs</div>
                          </div>
                        )}
                        {specsData.weightsAndCapacities.maxTowingCapacity && (
                          <div>
                            <div className="text-xs text-gray-500 uppercase">Max Towing</div>
                            <div className="font-semibold text-gray-900">{Number(specsData.weightsAndCapacities.maxTowingCapacity).toLocaleString()} lbs</div>
                          </div>
                        )}
                        {specsData.weightsAndCapacities.maxPayload && (
                          <div>
                            <div className="text-xs text-gray-500 uppercase">Max Payload</div>
                            <div className="font-semibold text-gray-900">{Number(specsData.weightsAndCapacities.maxPayload).toLocaleString()} lbs</div>
                          </div>
                        )}
                        {specsData.weightsAndCapacities.curbWeight && (
                          <div>
                            <div className="text-xs text-gray-500 uppercase">Curb Weight</div>
                            <div className="font-semibold text-gray-900">{Number(specsData.weightsAndCapacities.curbWeight).toLocaleString()} lbs</div>
                          </div>
                        )}
                        {specsData.weightsAndCapacities.gvwr && (
                          <div>
                            <div className="text-xs text-gray-500 uppercase">GVWR</div>
                            <div className="font-semibold text-gray-900">{Number(specsData.weightsAndCapacities.gvwr).toLocaleString()} lbs</div>
                          </div>
                        )}
                        {specsData.weightsAndCapacities.gcwr && (
                          <div>
                            <div className="text-xs text-gray-500 uppercase">GCWR</div>
                            <div className="font-semibold text-gray-900">{Number(specsData.weightsAndCapacities.gcwr).toLocaleString()} lbs</div>
                          </div>
                        )}
                        {specsData.weightsAndCapacities.tonnage && (
                          <div>
                            <div className="text-xs text-gray-500 uppercase">Tonnage</div>
                            <div className="font-semibold text-gray-900">{specsData.weightsAndCapacities.tonnage}</div>
                          </div>
                        )}
                      </div>
                    </div>
                  )}

                  {specsData && Object.keys(specsData.wheelsAndTires).length > 0 && (
                    <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
                      <div className="px-6 py-4 border-b border-gray-200 bg-gray-50">
                        <h3 className="font-semibold text-gray-900 flex items-center gap-2">
                          <span>🛞</span> Wheels & Tires
                        </h3>
                      </div>
                      <div className="p-6 grid grid-cols-2 sm:grid-cols-3 gap-4">
                        {specsData.wheelsAndTires.frontTireDescription && (
                          <div>
                            <div className="text-xs text-gray-500 uppercase">Front Tires</div>
                            <div className="font-semibold text-gray-900">{specsData.wheelsAndTires.frontTireDescription}</div>
                          </div>
                        )}
                        {specsData.wheelsAndTires.rearTireDescription && specsData.wheelsAndTires.rearTireDescription !== specsData.wheelsAndTires.frontTireDescription && (
                          <div>
                            <div className="text-xs text-gray-500 uppercase">Rear Tires</div>
                            <div className="font-semibold text-gray-900">{specsData.wheelsAndTires.rearTireDescription}</div>
                          </div>
                        )}
                        {specsData.wheelsAndTires.frontWheelDiameter && (
                          <div>
                            <div className="text-xs text-gray-500 uppercase">Front Wheel</div>
                            <div className="font-semibold text-gray-900">{specsData.wheelsAndTires.frontWheelDiameter}"</div>
                          </div>
                        )}
                        {specsData.wheelsAndTires.rearWheelDiameter && specsData.wheelsAndTires.rearWheelDiameter !== specsData.wheelsAndTires.frontWheelDiameter && (
                          <div>
                            <div className="text-xs text-gray-500 uppercase">Rear Wheel</div>
                            <div className="font-semibold text-gray-900">{specsData.wheelsAndTires.rearWheelDiameter}"</div>
                          </div>
                        )}
                        {specsData.wheelsAndTires.frontWheelSize && (
                          <div>
                            <div className="text-xs text-gray-500 uppercase">Front Wheel Size</div>
                            <div className="font-semibold text-gray-900">{specsData.wheelsAndTires.frontWheelSize}</div>
                          </div>
                        )}
                        {specsData.wheelsAndTires.rearWheelSize && specsData.wheelsAndTires.rearWheelSize !== specsData.wheelsAndTires.frontWheelSize && (
                          <div>
                            <div className="text-xs text-gray-500 uppercase">Rear Wheel Size</div>
                            <div className="font-semibold text-gray-900">{specsData.wheelsAndTires.rearWheelSize}</div>
                          </div>
                        )}
                        {specsData.wheelsAndTires.tireType && (
                          <div>
                            <div className="text-xs text-gray-500 uppercase">Tire Type</div>
                            <div className="font-semibold text-gray-900">{specsData.wheelsAndTires.tireType}</div>
                          </div>
                        )}
                      </div>
                    </div>
                  )}

                  {specsData && Object.keys(specsData.brakes).length > 0 && (
                    <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
                      <div className="px-6 py-4 border-b border-gray-200 bg-red-50">
                        <h3 className="font-semibold text-gray-900 flex items-center gap-2">
                          <span>🛑</span> Brakes
                        </h3>
                      </div>
                      <div className="p-6 grid grid-cols-2 gap-4">
                        {specsData.brakes.frontBrakeDiameter && (
                          <div>
                            <div className="text-xs text-gray-500 uppercase">Front Brake Diameter</div>
                            <div className="font-semibold text-gray-900">{specsData.brakes.frontBrakeDiameter}"</div>
                          </div>
                        )}
                        {specsData.brakes.rearBrakeDiameter && (
                          <div>
                            <div className="text-xs text-gray-500 uppercase">Rear Brake Diameter</div>
                            <div className="font-semibold text-gray-900">{specsData.brakes.rearBrakeDiameter}"</div>
                          </div>
                        )}
                      </div>
                    </div>
                  )}

                  {specsData && Object.keys(specsData.dimensions).length > 0 && (
                    <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
                      <div className="px-6 py-4 border-b border-gray-200 bg-green-50">
                        <h3 className="font-semibold text-gray-900 flex items-center gap-2">
                          <span>📐</span> Dimensions
                        </h3>
                      </div>
                      <div className="p-6 grid grid-cols-2 sm:grid-cols-3 gap-4">
                        {specsData.dimensions.length && (
                          <div>
                            <div className="text-xs text-gray-500 uppercase">Length</div>
                            <div className="font-semibold text-gray-900">{specsData.dimensions.length}"</div>
                          </div>
                        )}
                        {specsData.dimensions.width && (
                          <div>
                            <div className="text-xs text-gray-500 uppercase">Width</div>
                            <div className="font-semibold text-gray-900">{specsData.dimensions.width}"</div>
                          </div>
                        )}
                        {specsData.dimensions.height && (
                          <div>
                            <div className="text-xs text-gray-500 uppercase">Height</div>
                            <div className="font-semibold text-gray-900">{specsData.dimensions.height}"</div>
                          </div>
                        )}
                        {specsData.dimensions.wheelbase && (
                          <div>
                            <div className="text-xs text-gray-500 uppercase">Wheelbase</div>
                            <div className="font-semibold text-gray-900">{specsData.dimensions.wheelbase}"</div>
                          </div>
                        )}
                        {specsData.dimensions.groundClearance && (
                          <div>
                            <div className="text-xs text-gray-500 uppercase">Ground Clearance</div>
                            <div className="font-semibold text-gray-900">{specsData.dimensions.groundClearance}"</div>
                          </div>
                        )}
                        {specsData.dimensions.frontTrackWidth && (
                          <div>
                            <div className="text-xs text-gray-500 uppercase">Front Track</div>
                            <div className="font-semibold text-gray-900">{specsData.dimensions.frontTrackWidth}"</div>
                          </div>
                        )}
                        {specsData.dimensions.rearTrackWidth && (
                          <div>
                            <div className="text-xs text-gray-500 uppercase">Rear Track</div>
                            <div className="font-semibold text-gray-900">{specsData.dimensions.rearTrackWidth}"</div>
                          </div>
                        )}
                      </div>
                    </div>
                  )}

                  {specsData?.truckSpecs?.bedLength && (
                    <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
                      <div className="px-6 py-4 border-b border-gray-200 bg-amber-50">
                        <h3 className="font-semibold text-gray-900 flex items-center gap-2">
                          <span>🛻</span> Truck Specifications
                        </h3>
                      </div>
                      <div className="p-6 grid grid-cols-2 gap-4">
                        <div>
                          <div className="text-xs text-gray-500 uppercase">Bed Length</div>
                          <div className="font-semibold text-gray-900">{specsData.truckSpecs.bedLength}"</div>
                        </div>
                      </div>
                    </div>
                  )}

                  {(specsData?.seating?.maxSeating || specsData?.seating?.standardSeating || specsData?.interior?.cargoVolume || specsData?.interior?.passengerVolume) && (
                    <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
                      <div className="px-6 py-4 border-b border-gray-200 bg-purple-50">
                        <h3 className="font-semibold text-gray-900 flex items-center gap-2">
                          <span>🪑</span> Interior
                        </h3>
                      </div>
                      <div className="p-6 grid grid-cols-2 sm:grid-cols-3 gap-4">
                        {specsData?.seating?.maxSeating && (
                          <div>
                            <div className="text-xs text-gray-500 uppercase">Max Seating</div>
                            <div className="font-semibold text-gray-900">{specsData.seating.maxSeating} passengers</div>
                          </div>
                        )}
                        {specsData?.seating?.standardSeating && (
                          <div>
                            <div className="text-xs text-gray-500 uppercase">Standard Seating</div>
                            <div className="font-semibold text-gray-900">{specsData.seating.standardSeating} passengers</div>
                          </div>
                        )}
                        {specsData?.interior?.cargoVolume && (
                          <div>
                            <div className="text-xs text-gray-500 uppercase">Cargo Volume</div>
                            <div className="font-semibold text-gray-900">{specsData.interior.cargoVolume} cu ft</div>
                          </div>
                        )}
                        {specsData?.interior?.passengerVolume && (
                          <div>
                            <div className="text-xs text-gray-500 uppercase">Passenger Volume</div>
                            <div className="font-semibold text-gray-900">{specsData.interior.passengerVolume} cu ft</div>
                          </div>
                        )}
                      </div>
                    </div>
                  )}

                  {vehicleInfo && (vehicleInfo.bodyType || vehicleInfo.doors || vehicleInfo.countryOfMfr) && (
                    <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
                      <div className="px-6 py-4 border-b border-gray-200 bg-slate-50">
                        <h3 className="font-semibold text-gray-900 flex items-center gap-2">
                          <span>&#x2139;&#xFE0F;</span> General
                        </h3>
                      </div>
                      <div className="p-6 grid grid-cols-2 sm:grid-cols-3 gap-4">
                        {vehicleInfo.bodyType && (
                          <div>
                            <div className="text-xs text-gray-500 uppercase">Body Type</div>
                            <div className="font-semibold text-gray-900">{vehicleInfo.bodyType}</div>
                          </div>
                        )}
                        {vehicleInfo.doors && (
                          <div>
                            <div className="text-xs text-gray-500 uppercase">Doors</div>
                            <div className="font-semibold text-gray-900">{vehicleInfo.doors}</div>
                          </div>
                        )}
                        {vehicleInfo.countryOfMfr && (
                          <div>
                            <div className="text-xs text-gray-500 uppercase">Country of Manufacture</div>
                            <div className="font-semibold text-gray-900">{vehicleInfo.countryOfMfr}</div>
                          </div>
                        )}
                      </div>
                    </div>
                  )}
                </>
              ) : (
                <div className="bg-white rounded-xl border border-gray-200 p-8 text-center">
                  <div className="w-12 h-12 bg-gray-100 rounded-full flex items-center justify-center mx-auto mb-4">
                    <FileText className="w-6 h-6 text-gray-400" />
                  </div>
                  <h3 className="font-medium text-gray-900 mb-2">No Specifications Available</h3>
                  <p className="text-sm text-gray-500">
                    Vehicle specifications are not available for this VIN.
                  </p>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
