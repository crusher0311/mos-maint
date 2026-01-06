"use client";

import { useEffect, useState, useRef } from "react";
import Link from "next/link";
import { RefreshCw, Car, CheckCircle, Clock, Search, ChevronRight, HelpCircle, ChevronLeft, Archive, ArrowUp, ArrowDown, LogOut, ClipboardCheck, FileText, ThumbsUp, CheckCircle2, PauseCircle, X, Wrench, ClipboardList, AlertTriangle, Printer, Loader2 } from "lucide-react";
import JobLookup from "@/components/JobLookup";
import CommonFailuresPanel from "@/components/CommonFailuresPanel";
import { ReactNode } from "react";

type SortColumn = 'customer' | 'vehicle' | 'vin' | 'ro' | 'status' | 'dvi' | 'mileage';
type SortDirection = 'asc' | 'desc';

type PaginationInfo = {
  page: number;
  pageSize: number;
  totalCount: number;
  totalPages: number;
  hasNextPage: boolean;
  hasPrevPage: boolean;
};

type DashboardData = {
  rows: any[];
  pagination?: PaginationInfo;
  user: any;
  smsType?: string;
  distanceUnit?: "miles" | "kilometers";
};

const PAGE_SIZE = 100;

// Map Protractor workflow stages to display names, colors, and icons
const WORKFLOW_STAGE_MAP: Record<string, { label: string; color: string; icon: ReactNode }> = {
  "VehicleOnSite": { label: "Vehicle On Site", color: "bg-cyan-100 text-cyan-800", icon: <Car className="w-3 h-3" /> },
  "Unassigned": { label: "Vehicle On Site", color: "bg-cyan-100 text-cyan-800", icon: <Car className="w-3 h-3" /> },
  "InspectionInProgress": { label: "Inspection In Progress", color: "bg-blue-100 text-blue-800", icon: <Search className="w-3 h-3" /> },
  "InspectionComplete": { label: "Inspection Complete", color: "bg-indigo-100 text-indigo-800", icon: <ClipboardCheck className="w-3 h-3" /> },
  "EstimateCompleted": { label: "Estimate Completed", color: "bg-purple-100 text-purple-800", icon: <FileText className="w-3 h-3" /> },
  "WorkAuthorized": { label: "Work Authorized", color: "bg-amber-100 text-amber-800", icon: <ThumbsUp className="w-3 h-3" /> },
  "WorkCompleted": { label: "Work Completed", color: "bg-green-100 text-green-800", icon: <CheckCircle2 className="w-3 h-3" /> },
  "WorkOnHold": { label: "Work On Hold", color: "bg-red-100 text-red-800", icon: <PauseCircle className="w-3 h-3" /> },
};

function formatWorkflowStage(status: string): { label: string; color: string; icon: ReactNode | null } {
  const mapped = WORKFLOW_STAGE_MAP[status];
  if (mapped) return mapped;
  
  // Fallback for unknown stages or legacy status values
  if (status.toLowerCase().includes('close') || status.toLowerCase().includes('complete')) {
    return { label: status, color: "bg-green-100 text-green-800", icon: <CheckCircle2 className="w-3 h-3" /> };
  }
  if (status.toLowerCase().includes('open') || status.toLowerCase().includes('progress')) {
    return { label: status, color: "bg-blue-100 text-blue-800", icon: <Clock className="w-3 h-3" /> };
  }
  return { label: status, color: "bg-gray-100 text-gray-800", icon: null };
}

async function fetchDashboardData(page: number, search: string, archived: boolean = false): Promise<DashboardData | null> {
  try {
    const params = new URLSearchParams({
      page: page.toString(),
      pageSize: PAGE_SIZE.toString(),
    });
    if (search) params.set('search', search);
    if (archived) params.set('archived', 'true');
    
    const response = await fetch(`/api/dashboard/data?${params}`, {
      cache: 'no-store'
    });
    
    if (response.ok) {
      return await response.json();
    }
  } catch (error) {
    console.error('Failed to fetch dashboard data:', error);
  }
  return null;
}

export default function DashboardClient({ initialData }: { initialData: DashboardData }) {
  const [data, setData] = useState(initialData);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [currentPage, setCurrentPage] = useState(1);
  const [showArchived, setShowArchived] = useState(false);
  const [sortColumn, setSortColumn] = useState<SortColumn>('mileage');
  const [sortDirection, setSortDirection] = useState<SortDirection>('desc');
  const searchTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [showUserMenu, setShowUserMenu] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const [jobLookupVehicle, setJobLookupVehicle] = useState<{
    vin: string;
    year?: number;
    make?: string;
    model?: string;
    engine?: string;
    workOrderId?: string;
    displayName?: string;
  } | null>(null);
  const [commonFailuresVehicle, setCommonFailuresVehicle] = useState<{
    vin: string;
    year?: number;
    make?: string;
    model?: string;
    engine?: string;
    mileage?: number;
    displayName?: string;
  } | null>(null);
  const userMenuRef = useRef<HTMLDivElement>(null);
  const [printingSticker, setPrintingSticker] = useState<string | null>(null);

  const handleQuickPrintSticker = async (vin: string, currentMileage: number | null) => {
    if (!currentMileage) {
      alert("Mileage is required to print a sticker");
      return;
    }
    
    setPrintingSticker(vin);
    try {
      // Fetch shop sticker settings to get interval preferences and size
      let intervalMileage = 5000;
      let intervalMonths = 3;
      let stickerSize = '2x2';
      let includeQR = true;
      
      try {
        const settingsRes = await fetch('/api/sticker/settings');
        if (settingsRes.ok) {
          const settingsData = await settingsRes.json();
          const config = settingsData.config;
          const intervals = config?.intervals;
          
          // Use shop's configured sticker size
          if (config?.defaultSize) {
            stickerSize = config.defaultSize;
          }
          
          // Use shop's QR code preference
          if (config?.showQRCode !== undefined) {
            includeQR = config.showQRCode;
          }
          
          // Use synthetic oil as default interval (most common)
          if (intervals?.synthetic) {
            intervalMileage = intervals.synthetic.mileage || 5000;
            intervalMonths = intervals.synthetic.months || 3;
          } else if (intervals?.conventional) {
            intervalMileage = intervals.conventional.mileage || 3000;
            intervalMonths = intervals.conventional.months || 3;
          }
        }
      } catch (e) {
        console.log('Using default intervals');
      }
      
      // Calculate next service date based on shop interval
      const nextDate = new Date();
      nextDate.setMonth(nextDate.getMonth() + intervalMonths);
      const nextServiceDate = nextDate.toISOString().split('T')[0];
      
      // Calculate next service mileage based on shop interval
      const nextServiceMileage = currentMileage + intervalMileage;
      
      // Generate the sticker image
      const response = await fetch('/api/sticker/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          vin,
          currentMileage,
          nextServiceMileage,
          nextServiceDate,
          size: stickerSize,
          includeQR,
        }),
      });
      
      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || 'Failed to generate sticker');
      }
      
      // Get the image blob and convert to data URL
      const blob = await response.blob();
      const reader = new FileReader();
      
      reader.onloadend = () => {
        const dataUrl = reader.result as string;
        
        // Parse sticker dimensions for print CSS
        const sizeMap: Record<string, { width: string; height: string }> = {
          '2x2': { width: '2in', height: '2in' },
          '2x2.5': { width: '2in', height: '2.5in' },
          '2x3': { width: '2in', height: '3in' },
          '2x3.5': { width: '2in', height: '3.5in' },
        };
        const dims = sizeMap[stickerSize] || sizeMap['2x2'];
        
        // Open print window
        const printWindow = window.open('', '_blank', 'width=400,height=500');
        if (printWindow) {
          printWindow.document.write(`
            <!DOCTYPE html>
            <html>
            <head>
              <title>Print Sticker</title>
              <style>
                @page {
                  size: ${dims.width} ${dims.height};
                  margin: 0;
                }
                body { 
                  margin: 0; 
                  padding: 0;
                  display: flex; 
                  justify-content: center; 
                  align-items: center;
                  width: ${dims.width};
                  height: ${dims.height};
                }
                img { 
                  width: ${dims.width}; 
                  height: ${dims.height}; 
                  object-fit: contain;
                }
                @media screen {
                  body {
                    padding: 20px;
                    width: auto;
                    height: auto;
                  }
                  img {
                    max-width: 300px;
                    height: auto;
                    width: auto;
                  }
                }
              </style>
            </head>
            <body>
              <div>
                <img src="${dataUrl}" alt="Oil Change Sticker" onload="window.print();" />
              </div>
            </body>
            </html>
          `);
          printWindow.document.close();
        }
      };
      
      reader.readAsDataURL(blob);
    } catch (error) {
      console.error('Failed to print sticker:', error);
      alert(error instanceof Error ? error.message : 'Failed to generate sticker. Please check your sticker settings.');
    } finally {
      setPrintingSticker(null);
    }
  };

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (userMenuRef.current && !userMenuRef.current.contains(e.target as Node)) {
        setShowUserMenu(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  async function handleLogout() {
    setLoggingOut(true);
    try {
      const res = await fetch("/api/auth/logout", { method: "POST" });
      const data = await res.json().catch(() => ({}));
      window.location.href = data?.redirect || "/login";
    } finally {
      setLoggingOut(false);
    }
  }

  const handleSort = (column: SortColumn) => {
    if (sortColumn === column) {
      setSortDirection(sortDirection === 'asc' ? 'desc' : 'asc');
    } else {
      setSortColumn(column);
      setSortDirection(column === 'mileage' ? 'desc' : 'asc');
    }
  };

  const sortedRows = [...(data.rows || [])].sort((a, b) => {
    const dir = sortDirection === 'asc' ? 1 : -1;
    
    const getMileage = (r: any) => r.displayMiles ?? r.af?.miles ?? 0;
    
    switch (sortColumn) {
      case 'customer':
        return dir * (String(a.displayName || '').localeCompare(String(b.displayName || '')));
      case 'vehicle':
        return dir * (String(a.displayVehicle || '').localeCompare(String(b.displayVehicle || '')));
      case 'vin':
        return dir * (String(a.displayVin || '').localeCompare(String(b.displayVin || '')));
      case 'ro':
        return dir * (String(a.displayRo || '').localeCompare(String(b.displayRo || '')));
      case 'status':
        return dir * (String(a.af?.status || '').localeCompare(String(b.af?.status || '')));
      case 'dvi':
        return dir * ((a.dviDone ? 1 : 0) - (b.dviDone ? 1 : 0));
      case 'mileage':
        return dir * (getMileage(a) - getMileage(b));
      default:
        return 0;
    }
  });

  const SortHeader = ({ column, children }: { column: SortColumn; children: React.ReactNode }) => (
    <th 
      className="px-6 py-3 font-medium cursor-pointer hover:bg-gray-100 select-none"
      onClick={() => handleSort(column)}
    >
      <div className="flex items-center gap-1">
        {children}
        {sortColumn === column && (
          sortDirection === 'asc' 
            ? <ArrowUp className="w-3 h-3" />
            : <ArrowDown className="w-3 h-3" />
        )}
      </div>
    </th>
  );

  const loadData = async (page: number, search: string, archived: boolean = false) => {
    setIsRefreshing(true);
    const newData = await fetchDashboardData(page, search, archived);
    if (newData) {
      setData(newData);
      setLastUpdated(new Date());
    }
    setIsRefreshing(false);
  };

  useEffect(() => {
    // Always fetch fresh data on mount to ensure SSR and client are in sync
    // This prevents stale data from showing after browser refresh
    loadData(1, "", false);
    
    if (data.rows?.length > 0) {
      const vinsToPrefeetch = data.rows
        .slice(0, 10)
        .map((r: any) => r.displayVin || r.vin)
        .filter((v: string) => v && v.length === 17);
      
      if (vinsToPrefeetch.length > 0) {
        fetch("/api/plan-prefetch/batch", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ vins: vinsToPrefeetch }),
        }).catch(() => {});
      }
    }
  }, []);

  useEffect(() => {
    const interval = setInterval(() => {
      loadData(currentPage, searchQuery, showArchived);
    }, 30000);
    return () => clearInterval(interval);
  }, [currentPage, searchQuery, showArchived]);

  useEffect(() => {
    if (!data.user?.shopId) return;
    
    const checkClosedOrders = async () => {
      try {
        const response = await fetch('/api/vehicles/check-closed-orders', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ shopId: data.user.shopId })
        });
        
        if (response.ok) {
          const result = await response.json();
          if (result.closed > 0) {
            loadData(currentPage, searchQuery, showArchived);
          }
        }
      } catch (err) {
        console.error('Error checking closed orders:', err);
      }
    };

    const pollInterval = setInterval(checkClosedOrders, 5000);
    return () => clearInterval(pollInterval);
  }, [data.user?.shopId, currentPage, searchQuery, showArchived]);

  const handleSearchChange = (value: string) => {
    setSearchQuery(value);
    if (searchTimeoutRef.current) clearTimeout(searchTimeoutRef.current);
    searchTimeoutRef.current = setTimeout(() => {
      setCurrentPage(1);
      loadData(1, value, showArchived);
    }, 300);
  };

  const handlePageChange = (newPage: number) => {
    setCurrentPage(newPage);
    loadData(newPage, searchQuery, showArchived);
  };

  const handleToggleArchived = () => {
    const newArchived = !showArchived;
    setShowArchived(newArchived);
    setCurrentPage(1);
    loadData(1, searchQuery, newArchived);
  };

  const refreshData = () => loadData(currentPage, searchQuery, showArchived);

  const VEHICLE_HREF = (vin: string) => `/dashboard/vehicles/${encodeURIComponent(vin)}/plan`;

  const pagination = data.pagination || {
    page: 1,
    pageSize: 50,
    totalCount: data.rows.length,
    totalPages: 1,
    hasNextPage: false,
    hasPrevPage: false
  };

  const stats = {
    total: pagination.totalCount,
    dviComplete: data.rows.filter(r => r.dviDone).length,
    inProgress: data.rows.filter(r => !r.dviDone).length
  };

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <header className="bg-white border-b border-gray-200 px-4 sm:px-6 py-3 sm:py-4">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 sm:gap-3 min-w-0">
            <Car className="w-5 h-5 sm:w-6 sm:h-6 text-gray-600 flex-shrink-0" />
            <h1 className="text-lg sm:text-xl font-semibold text-gray-900">Vehicles</h1>
            <span className="text-xs sm:text-sm text-gray-500">({pagination.totalCount} total)</span>
          </div>
          <div className="flex items-center gap-2 sm:gap-4">
            <button
              onClick={handleToggleArchived}
              className={`flex items-center gap-1 sm:gap-2 px-2 sm:px-4 py-1.5 sm:py-2 text-xs sm:text-sm font-medium rounded-lg transition-colors ${
                showArchived 
                  ? 'bg-gray-800 text-white hover:bg-gray-700' 
                  : 'text-gray-700 bg-white border border-gray-300 hover:bg-gray-50'
              }`}
            >
              <Archive className="w-3.5 h-3.5 sm:w-4 sm:h-4" />
              <span className="hidden sm:inline">{showArchived ? "Showing Archived" : "Show Archived"}</span>
              <span className="sm:hidden">{showArchived ? "Archived" : "Archive"}</span>
            </button>
            <button
              onClick={refreshData}
              disabled={isRefreshing}
              className="flex items-center gap-1 sm:gap-2 px-2 sm:px-4 py-1.5 sm:py-2 text-xs sm:text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors disabled:opacity-50"
            >
              <RefreshCw className={`w-3.5 h-3.5 sm:w-4 sm:h-4 ${isRefreshing ? 'animate-spin' : ''}`} />
              <span className="hidden sm:inline">{isRefreshing ? "Refreshing..." : "Refresh"}</span>
            </button>
            <div className="flex items-center gap-2">
              <button className="p-2 text-gray-400 hover:text-gray-600 rounded-lg hover:bg-gray-100 transition-colors">
                <HelpCircle className="w-5 h-5" />
              </button>
              <div className="relative" ref={userMenuRef}>
                <button
                  onClick={() => setShowUserMenu(!showUserMenu)}
                  className="w-8 h-8 rounded-full bg-mos-blue flex items-center justify-center text-white text-sm font-medium hover:ring-2 hover:ring-mos-blue/50 transition-all"
                >
                  {data.user?.email?.charAt(0).toUpperCase() || "U"}
                </button>
                {showUserMenu && (
                  <div className="absolute right-0 top-full mt-2 w-48 bg-white rounded-lg shadow-lg border border-gray-200 py-1 z-50">
                    <div className="px-4 py-2 border-b border-gray-100">
                      <p className="text-sm font-medium text-gray-900 truncate">{data.user?.email}</p>
                      <p className="text-xs text-gray-500 capitalize">{data.user?.role || "User"}</p>
                    </div>
                    <button
                      onClick={handleLogout}
                      disabled={loggingOut}
                      className="w-full flex items-center gap-2 px-4 py-2 text-sm text-red-600 hover:bg-red-50 transition-colors disabled:opacity-50"
                    >
                      <LogOut className="w-4 h-4" />
                      {loggingOut ? "Logging out..." : "Log out"}
                    </button>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      </header>

      <div className="flex-1 overflow-auto p-4 sm:p-6">
        <div className="grid grid-cols-3 gap-2 sm:gap-4 mb-4 sm:mb-6">
          <div className="bg-white rounded-lg sm:rounded-xl border border-gray-200 p-3 sm:p-5">
            <div className="flex items-center gap-2 sm:gap-4">
              <div className="w-8 h-8 sm:w-12 sm:h-12 bg-blue-100 rounded-lg sm:rounded-xl flex items-center justify-center flex-shrink-0">
                <Car className="w-4 h-4 sm:w-6 sm:h-6 text-blue-600" />
              </div>
              <div className="min-w-0">
                <p className="text-xs sm:text-sm text-gray-500 truncate">Total Vehicles</p>
                <p className="text-lg sm:text-2xl font-bold text-gray-900">{pagination.totalCount}</p>
              </div>
            </div>
          </div>

          <div className="bg-white rounded-lg sm:rounded-xl border border-gray-200 p-3 sm:p-5">
            <div className="flex items-center gap-2 sm:gap-4">
              <div className="w-8 h-8 sm:w-12 sm:h-12 bg-green-100 rounded-lg sm:rounded-xl flex items-center justify-center flex-shrink-0">
                <CheckCircle className="w-4 h-4 sm:w-6 sm:h-6 text-green-600" />
              </div>
              <div className="min-w-0">
                <p className="text-xs sm:text-sm text-gray-500 truncate">DVI Complete (this page)</p>
                <p className="text-lg sm:text-2xl font-bold text-gray-900">{stats.dviComplete}</p>
              </div>
            </div>
          </div>

          <div className="bg-white rounded-lg sm:rounded-xl border border-gray-200 p-3 sm:p-5">
            <div className="flex items-center gap-2 sm:gap-4">
              <div className="w-8 h-8 sm:w-12 sm:h-12 bg-yellow-100 rounded-lg sm:rounded-xl flex items-center justify-center flex-shrink-0">
                <Clock className="w-4 h-4 sm:w-6 sm:h-6 text-yellow-600" />
              </div>
              <div className="min-w-0">
                <p className="text-xs sm:text-sm text-gray-500 truncate">No DVI (this page)</p>
                <p className="text-lg sm:text-2xl font-bold text-gray-900">{stats.inProgress}</p>
              </div>
            </div>
          </div>
        </div>

        <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
          <div className="px-6 py-4 border-b border-gray-200">
            <div className="flex items-center justify-between">
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
                <input
                  type="text"
                  placeholder="Search vehicles..."
                  value={searchQuery}
                  onChange={(e) => handleSearchChange(e.target.value)}
                  className="w-64 pl-10 pr-4 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                />
              </div>
              <div className="flex items-center gap-4 text-sm text-gray-500">
                <span>
                  Showing {((pagination.page - 1) * pagination.pageSize) + 1}-{Math.min(pagination.page * pagination.pageSize, pagination.totalCount)} of {pagination.totalCount}
                </span>
              </div>
            </div>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="bg-gray-50 text-left text-sm text-gray-600">
                <tr>
                  <SortHeader column="customer">Customer</SortHeader>
                  <SortHeader column="vehicle">Vehicle</SortHeader>
                  <SortHeader column="vin">VIN</SortHeader>
                  <SortHeader column="ro">RO #</SortHeader>
                  <SortHeader column="status">{data.smsType === 'protractor' ? 'Workflow Stage' : 'Status'}</SortHeader>
                  <SortHeader column="dvi">DVI</SortHeader>
                  <SortHeader column="mileage">{data.distanceUnit === "kilometers" ? "Odometer (km)" : "Mileage"}</SortHeader>
                  <th className="px-6 py-3 font-medium"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-200">
                {sortedRows.map((r: any, index: number) => {
                  const vin = r.displayVin || "";
                  const statusText = r.displayStatus || r.af?.status || "Unknown";
                  const rowKey = r.displayRo ? `${vin}-${r.displayRo}` : `${vin}-${index}`;
                  
                  return (
                    <tr key={rowKey} className="hover:bg-gray-50 transition-colors">
                      <td className="px-6 py-4">
                        <Link href={VEHICLE_HREF(vin)} className="text-gray-900 font-medium hover:text-blue-600 transition-colors">
                          {r.displayName || "Unknown"}
                        </Link>
                      </td>
                      <td className="px-6 py-4 text-gray-600">
                        {r.displayVehicle && r.displayVehicle.trim() !== "" ? r.displayVehicle : "—"}
                      </td>
                      <td className="px-6 py-4">
                        <code className="text-xs bg-gray-100 px-2 py-1 rounded font-mono text-gray-700">
                          {vin}
                        </code>
                      </td>
                      <td className="px-6 py-4">
                        {r.displayRo ? (
                          <span className="text-gray-600">{r.displayRo}</span>
                        ) : (
                          <span className="text-gray-400">—</span>
                        )}
                      </td>
                      <td className="px-6 py-4">
                        {(() => {
                          const { label, color, icon } = formatWorkflowStage(statusText);
                          return (
                            <span className={`inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-medium ${color}`}>
                              {icon}
                              {label}
                            </span>
                          );
                        })()}
                      </td>
                      <td className="px-6 py-4">
                        {r.dviDone ? (
                          <div className="w-6 h-6 bg-green-100 rounded-full flex items-center justify-center">
                            <CheckCircle className="w-4 h-4 text-green-600" />
                          </div>
                        ) : (
                          <div className="w-6 h-6 bg-gray-100 rounded-full flex items-center justify-center">
                            <Clock className="w-4 h-4 text-gray-400" />
                          </div>
                        )}
                      </td>
                      <td className="px-6 py-4 font-mono text-sm text-gray-600">
                        {r.displayMiles != null
                          ? Number(r.displayMiles).toLocaleString()
                          : "—"}
                      </td>
                      <td className="px-6 py-4">
                        <div className="flex items-center gap-2">
                          {r.displayMiles != null && r.displayMiles > 0 ? (
                            <Link
                              href={VEHICLE_HREF(vin)}
                              className="p-1.5 text-gray-400 hover:text-blue-600 hover:bg-blue-50 rounded transition-colors"
                              title="View Recommendations"
                            >
                              <ClipboardList className="w-4 h-4" />
                            </Link>
                          ) : (
                            <span 
                              className="p-1.5 text-gray-300 cursor-not-allowed"
                              title="Mileage required for recommendations"
                            >
                              <ClipboardList className="w-4 h-4" />
                            </span>
                          )}
                          <button
                            onClick={() => {
                              // Use structured vehicle fields with fallback parsing for legacy data
                              let year = r.vehicle?.year;
                              let make = r.vehicle?.make;
                              let model = r.vehicle?.model;
                              
                              // Fallback: parse displayVehicle if structured data is missing
                              if (!year && !make && !model && r.displayVehicle) {
                                const vehicleStr = r.displayVehicle || "";
                                const yearMatch = vehicleStr.match(/^(\d{4})/);
                                year = yearMatch ? parseInt(yearMatch[1]) : undefined;
                                const afterYear = yearMatch ? vehicleStr.slice(4).trim() : vehicleStr;
                                const parts = afterYear.split(" ").filter(Boolean);
                                make = parts[0] || undefined;
                                model = parts.slice(1).join(" ") || undefined;
                              }
                              
                              setJobLookupVehicle({
                                vin,
                                year,
                                make,
                                model,
                                engine: r.vehicle?.engine || r.engine || undefined,
                                workOrderId: r.workOrderGuid || r.displayRo,
                                displayName: r.displayName,
                              });
                            }}
                            className="p-1.5 text-gray-400 hover:text-amber-600 hover:bg-amber-50 rounded transition-colors"
                            title="Job Lookup"
                          >
                            <Wrench className="w-4 h-4" />
                          </button>
                          <button
                            onClick={() => {
                              let year = r.vehicle?.year;
                              let make = r.vehicle?.make;
                              let model = r.vehicle?.model;
                              
                              if (!year && !make && !model && r.displayVehicle) {
                                const vehicleStr = r.displayVehicle || "";
                                const yearMatch = vehicleStr.match(/^(\d{4})/);
                                year = yearMatch ? parseInt(yearMatch[1]) : undefined;
                                const afterYear = yearMatch ? vehicleStr.slice(4).trim() : vehicleStr;
                                const parts = afterYear.split(" ").filter(Boolean);
                                make = parts[0] || undefined;
                                model = parts.slice(1).join(" ") || undefined;
                              }
                              
                              setCommonFailuresVehicle({
                                vin,
                                year,
                                make,
                                model,
                                engine: r.vehicle?.engine || r.engine || undefined,
                                mileage: r.displayMiles,
                                displayName: r.displayName,
                              });
                            }}
                            className="p-1.5 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded transition-colors"
                            title="Common Failures"
                          >
                            <AlertTriangle className="w-4 h-4" />
                          </button>
                          <button
                            onClick={() => handleQuickPrintSticker(vin, r.displayMiles)}
                            disabled={printingSticker === vin || !r.displayMiles}
                            className={`p-1.5 rounded transition-colors ${
                              !r.displayMiles 
                                ? "text-gray-300 cursor-not-allowed" 
                                : "text-gray-400 hover:text-green-600 hover:bg-green-50"
                            }`}
                            title={r.displayMiles ? "Quick Print Oil Sticker" : "Mileage required for sticker"}
                          >
                            {printingSticker === vin ? (
                              <Loader2 className="w-4 h-4 animate-spin" />
                            ) : (
                              <Printer className="w-4 h-4" />
                            )}
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
                {sortedRows.length === 0 && (
                  <tr>
                    <td colSpan={8} className="px-6 py-12 text-center">
                      <div className="flex flex-col items-center gap-3">
                        <div className="w-12 h-12 bg-gray-100 rounded-full flex items-center justify-center">
                          <Car className="w-6 h-6 text-gray-400" />
                        </div>
                        <div>
                          <p className="text-gray-900 font-medium">No vehicles found</p>
                          <p className="text-sm text-gray-500">
                            {searchQuery ? "Try adjusting your search" : "No active vehicles to display"}
                          </p>
                        </div>
                      </div>
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          {pagination.totalPages > 1 && (
            <div className="px-6 py-4 border-t border-gray-200 flex items-center justify-between">
              <div className="text-sm text-gray-500">
                Page {pagination.page} of {pagination.totalPages}
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => handlePageChange(pagination.page - 1)}
                  disabled={!pagination.hasPrevPage || isRefreshing}
                  className="flex items-center gap-1 px-3 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  <ChevronLeft className="w-4 h-4" />
                  Previous
                </button>
                <div className="flex items-center gap-1">
                  {Array.from({ length: Math.min(5, pagination.totalPages) }, (_, i) => {
                    let pageNum;
                    if (pagination.totalPages <= 5) {
                      pageNum = i + 1;
                    } else if (pagination.page <= 3) {
                      pageNum = i + 1;
                    } else if (pagination.page >= pagination.totalPages - 2) {
                      pageNum = pagination.totalPages - 4 + i;
                    } else {
                      pageNum = pagination.page - 2 + i;
                    }
                    return (
                      <button
                        key={pageNum}
                        onClick={() => handlePageChange(pageNum)}
                        disabled={isRefreshing}
                        className={`px-3 py-2 text-sm font-medium rounded-lg transition-colors ${
                          pageNum === pagination.page
                            ? 'bg-blue-600 text-white'
                            : 'text-gray-700 hover:bg-gray-100'
                        }`}
                      >
                        {pageNum}
                      </button>
                    );
                  })}
                </div>
                <button
                  onClick={() => handlePageChange(pagination.page + 1)}
                  disabled={!pagination.hasNextPage || isRefreshing}
                  className="flex items-center gap-1 px-3 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  Next
                  <ChevronRight className="w-4 h-4" />
                </button>
              </div>
            </div>
          )}
        </div>

        <div className="mt-4 flex items-center justify-between text-xs text-gray-500">
          <p>Last updated: {lastUpdated ? lastUpdated.toLocaleTimeString() : "—"}</p>
          <p className="flex items-center gap-1">
            <span className="w-2 h-2 bg-green-500 rounded-full"></span>
            Auto-refreshes every 30 seconds
          </p>
        </div>
      </div>

      {jobLookupVehicle && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-xl shadow-2xl w-full max-w-4xl max-h-[90vh] overflow-hidden flex flex-col">
            <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200 bg-gray-50">
              <div>
                <h2 className="text-lg font-semibold text-gray-900 flex items-center gap-2">
                  <Wrench className="w-5 h-5 text-amber-500" />
                  Job Lookup
                </h2>
                <p className="text-sm text-gray-500">
                  {jobLookupVehicle.displayName} - {jobLookupVehicle.year} {jobLookupVehicle.make} {jobLookupVehicle.model}
                </p>
              </div>
              <button
                onClick={() => setJobLookupVehicle(null)}
                className="p-2 text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded-lg transition-colors"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="flex-1 overflow-auto p-6">
              <JobLookup
                currentVehicle={{
                  year: jobLookupVehicle.year,
                  make: jobLookupVehicle.make,
                  model: jobLookupVehicle.model,
                  engine: jobLookupVehicle.engine,
                }}
                workOrderGuid={jobLookupVehicle.workOrderId}
                onJobAdded={() => {
                  refreshData();
                }}
              />
            </div>
          </div>
        </div>
      )}

      {commonFailuresVehicle && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-xl shadow-2xl w-full max-w-2xl max-h-[90vh] overflow-hidden flex flex-col">
            <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200 bg-gray-50">
              <div>
                <h2 className="text-lg font-semibold text-gray-900 flex items-center gap-2">
                  <AlertTriangle className="w-5 h-5 text-red-500" />
                  Common Failures
                </h2>
                <p className="text-sm text-gray-500">
                  {commonFailuresVehicle.displayName} - {commonFailuresVehicle.year} {commonFailuresVehicle.make} {commonFailuresVehicle.model}
                </p>
              </div>
              <button
                onClick={() => setCommonFailuresVehicle(null)}
                className="p-2 text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded-lg transition-colors"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="flex-1 overflow-auto p-6">
              <CommonFailuresPanel
                vehicle={{
                  year: commonFailuresVehicle.year,
                  make: commonFailuresVehicle.make,
                  model: commonFailuresVehicle.model,
                  engine: commonFailuresVehicle.engine,
                  mileage: commonFailuresVehicle.mileage,
                }}
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
