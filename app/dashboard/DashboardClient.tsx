"use client";

import { useEffect, useState, useRef } from "react";
import Link from "next/link";
import { RefreshCw, Car, CheckCircle, Clock, Search, ChevronRight, HelpCircle, ChevronLeft, Archive, ArrowUp, ArrowDown, LogOut } from "lucide-react";

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
};

const PAGE_SIZE = 50;

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
  const userMenuRef = useRef<HTMLDivElement>(null);

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
    const hasMileageA = getMileage(a) > 0;
    const hasMileageB = getMileage(b) > 0;
    if (hasMileageA !== hasMileageB) {
      return hasMileageA ? -1 : 1;
    }
    
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
    setLastUpdated(new Date());
    
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
      <header className="bg-white border-b border-gray-200 px-6 py-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Car className="w-6 h-6 text-gray-600" />
            <h1 className="text-xl font-semibold text-gray-900">Vehicles</h1>
            <span className="text-sm text-gray-500">({pagination.totalCount} total)</span>
          </div>
          <div className="flex items-center gap-4">
            <button
              onClick={handleToggleArchived}
              className={`flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-lg transition-colors ${
                showArchived 
                  ? 'bg-gray-800 text-white hover:bg-gray-700' 
                  : 'text-gray-700 bg-white border border-gray-300 hover:bg-gray-50'
              }`}
            >
              <Archive className="w-4 h-4" />
              {showArchived ? "Showing Archived" : "Show Archived"}
            </button>
            <button
              onClick={refreshData}
              disabled={isRefreshing}
              className="flex items-center gap-2 px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors disabled:opacity-50"
            >
              <RefreshCw className={`w-4 h-4 ${isRefreshing ? 'animate-spin' : ''}`} />
              {isRefreshing ? "Refreshing..." : "Refresh"}
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

      <div className="flex-1 overflow-auto p-6">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
          <div className="bg-white rounded-xl border border-gray-200 p-5">
            <div className="flex items-center gap-4">
              <div className="w-12 h-12 bg-blue-100 rounded-xl flex items-center justify-center">
                <Car className="w-6 h-6 text-blue-600" />
              </div>
              <div>
                <p className="text-sm text-gray-500">Total Vehicles</p>
                <p className="text-2xl font-bold text-gray-900">{pagination.totalCount}</p>
              </div>
            </div>
          </div>

          <div className="bg-white rounded-xl border border-gray-200 p-5">
            <div className="flex items-center gap-4">
              <div className="w-12 h-12 bg-green-100 rounded-xl flex items-center justify-center">
                <CheckCircle className="w-6 h-6 text-green-600" />
              </div>
              <div>
                <p className="text-sm text-gray-500">DVI Complete (this page)</p>
                <p className="text-2xl font-bold text-gray-900">{stats.dviComplete}</p>
              </div>
            </div>
          </div>

          <div className="bg-white rounded-xl border border-gray-200 p-5">
            <div className="flex items-center gap-4">
              <div className="w-12 h-12 bg-yellow-100 rounded-xl flex items-center justify-center">
                <Clock className="w-6 h-6 text-yellow-600" />
              </div>
              <div>
                <p className="text-sm text-gray-500">In Progress (this page)</p>
                <p className="text-2xl font-bold text-gray-900">{stats.inProgress}</p>
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
                  <SortHeader column="status">Status</SortHeader>
                  <SortHeader column="dvi">DVI</SortHeader>
                  <SortHeader column="mileage">Mileage</SortHeader>
                  <th className="px-6 py-3 font-medium"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-200">
                {sortedRows.map((r: any, index: number) => {
                  const vin = r.displayVin || "";
                  const statusText = r.af?.status || "Unknown";
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
                        <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${
                          statusText.toLowerCase().includes('close') 
                            ? 'bg-green-100 text-green-800' 
                            : statusText.toLowerCase().includes('open')
                            ? 'bg-blue-100 text-blue-800'
                            : 'bg-gray-100 text-gray-800'
                        }`}>
                          {statusText}
                        </span>
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
                        {r.displayMiles != null && r.displayMiles > 0 ? (
                          <Link
                            href={VEHICLE_HREF(vin)}
                            className="flex items-center gap-1 text-sm text-blue-600 hover:text-blue-800 font-medium transition-colors"
                          >
                            View
                            <ChevronRight className="w-4 h-4" />
                          </Link>
                        ) : (
                          <span 
                            className="flex items-center gap-1 text-sm text-gray-400 cursor-not-allowed"
                            title="Mileage required for recommendations"
                          >
                            View
                            <ChevronRight className="w-4 h-4" />
                          </span>
                        )}
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
    </div>
  );
}
