"use client";

import { useEffect, useState, useRef } from "react";
import Link from "next/link";
import { RefreshCw, Car, CheckCircle, Clock, Search, ChevronRight, HelpCircle, ChevronLeft, Archive, ArrowUp, ArrowDown, LogOut, ClipboardCheck, FileText, ThumbsUp, CheckCircle2, PauseCircle, X, Wrench, ClipboardList, AlertTriangle, Printer, Loader2, Key, HeartPulse, Plus, MessageSquareText } from "lucide-react";
import JobLookup from "@/components/JobLookup";
import CommonFailuresPanel from "@/components/CommonFailuresPanel";
import { VinSpecsTooltip } from "@/components/VinSpecsTooltip";
import AddVehicleModal from "@/components/AddVehicleModal";
import ConcernAssistantModal from "@/components/ConcernAssistantModal";
import NewWorkOrderModal from "@/components/NewWorkOrderModal";
import { ReactNode } from "react";
import { queueMultiplePrefetch, queuePrefetch } from "@/lib/plan-prefetch";
import { getOELogoUrl } from "@/lib/oe-logos";

function getRowMake(r: any): string | undefined {
  const direct = r?.vehicle?.make || r?.vehicleMake || r?.make;
  if (direct) return String(direct);
  const display = r?.displayVehicle;
  if (!display) return undefined;
  const yearMatch = String(display).match(/^(\d{4})/);
  const afterYear = yearMatch ? String(display).slice(4).trim() : String(display);
  const parts = afterYear.split(" ").filter(Boolean);
  if (parts.length >= 2) {
    const twoWord = `${parts[0]} ${parts[1]}`;
    if (getOELogoUrl(twoWord)) return twoWord;
  }
  return parts[0] || undefined;
}

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

type FeatureId = "maintenance" | "job_lookup" | "common_failures" | "oil_sticker" | "keytags" | "auto_booking" | "part_xref" | "concern_assistant";

type QuickSpecs = {
  frontTireDescription?: string;
  rearTireDescription?: string;
  frontBrakeDiameter?: string;
  rearBrakeDiameter?: string;
  wheelbase?: string;
};

type DashboardData = {
  rows: any[];
  pagination?: PaginationInfo;
  user: any;
  shopId?: number;
  smsType?: string;
  distanceUnit?: "miles" | "kilometers";
  enabledFeatures?: FeatureId[];
  quickSpecs?: Record<string, QuickSpecs>;
};

const PAGE_SIZE = 100;

// Map Protractor workflow stages to display names, colors, and icons
const WORKFLOW_STAGE_MAP: Record<string, { label: string; color: string; icon: ReactNode }> = {
  "Manual": { label: "Manual", color: "bg-violet-100 text-violet-800", icon: <Plus className="w-3 h-3" /> },
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
  const safeStatus = typeof status === 'string' ? status : String(status ?? 'Unknown');
  const mapped = WORKFLOW_STAGE_MAP[safeStatus];
  if (mapped) return mapped;
  
  // Fallback for unknown stages or legacy status values
  const lower = safeStatus.toLowerCase();
  if (lower.includes('close') || lower.includes('complete') || lower.includes('invoice')) {
    return { label: safeStatus, color: "bg-green-100 text-green-800", icon: <CheckCircle2 className="w-3 h-3" /> };
  }
  if (lower.includes('open') || lower.includes('progress') || lower.includes('in_progress')) {
    return { label: safeStatus, color: "bg-blue-100 text-blue-800", icon: <Clock className="w-3 h-3" /> };
  }
  if (lower.includes('estimate')) {
    return { label: safeStatus, color: "bg-purple-100 text-purple-800", icon: <FileText className="w-3 h-3" /> };
  }
  return { label: safeStatus, color: "bg-gray-100 text-gray-800", icon: null };
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
  
  // Load saved sort preferences after hydration to avoid SSR mismatch
  useEffect(() => {
    const savedColumn = localStorage.getItem('dashboard_sort_column');
    if (savedColumn && ['customer', 'vehicle', 'vin', 'ro', 'status', 'dvi', 'mileage'].includes(savedColumn)) {
      setSortColumn(savedColumn as SortColumn);
    }
    const savedDirection = localStorage.getItem('dashboard_sort_direction');
    if (savedDirection === 'asc' || savedDirection === 'desc') {
      setSortDirection(savedDirection);
    }
  }, []);
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
  const [printingKeytag, setPrintingKeytag] = useState<string | null>(null);
  const [stickerContextMenu, setStickerContextMenu] = useState<{
    vin: string;
    mileage: number;
    x: number;
    y: number;
    intervals: Record<string, { mileage: number; months: number }>;
    useKilometers: boolean;
    customerName?: string;
    vehicleYear?: number;
    vehicleMake?: string;
    vehicleModel?: string;
  } | null>(null);
  const [customStickerModal, setCustomStickerModal] = useState<{
    vin: string;
    mileage: number;
    customerName?: string;
    vehicleYear?: number;
    vehicleMake?: string;
    vehicleModel?: string;
  } | null>(null);
  const [customDate, setCustomDate] = useState('');
  const [customMileage, setCustomMileage] = useState('');
  const stickerContextRef = useRef<HTMLDivElement>(null);
  const [showAddVehicle, setShowAddVehicle] = useState(false);
  const [showNewWorkOrder, setShowNewWorkOrder] = useState(false);
  const [concernAssistant, setConcernAssistant] = useState<{
    vin: string;
    vehicleDisplay: string;
    workOrderId?: string;
    workOrderNumber?: string;
    contactId?: string;
    serviceItemId?: string;
    customerName?: string;
  } | null>(null);

  const handleVehicleAdded = (row: any) => {
    setData(prev => ({
      ...prev,
      rows: [row, ...prev.rows],
    }));
    const shopId = data.shopId || data.user?.shopId;
    if (row.displayVin && row.displayMiles && shopId) {
      queuePrefetch(row.displayVin, row.displayMiles, shopId, "high");
    }
  };

  useEffect(() => {
    function handleClickOutsideContext(e: MouseEvent) {
      if (stickerContextRef.current && !stickerContextRef.current.contains(e.target as Node)) {
        setStickerContextMenu(null);
      }
    }
    document.addEventListener("mousedown", handleClickOutsideContext);
    return () => document.removeEventListener("mousedown", handleClickOutsideContext);
  }, []);

  const handleStickerRightClick = async (
    e: React.MouseEvent, 
    vin: string, 
    currentMileage: number | null,
    customerName?: string,
    vehicleYear?: number,
    vehicleMake?: string,
    vehicleModel?: string
  ) => {
    e.preventDefault();
    if (!currentMileage) {
      alert("Mileage is required to print a sticker");
      return;
    }
    
    // Fetch sticker settings to get intervals
    try {
      const settingsRes = await fetch('/api/sticker/settings');
      if (settingsRes.ok) {
        const settingsData = await settingsRes.json();
        const config = settingsData.config || {};
        const defaultIntervals = {
          conventional: { mileage: 3000, months: 3 },
          synthetic: { mileage: 5000, months: 6 },
          euro: { mileage: 10000, months: 12 },
          diesel: { mileage: 7500, months: 6 },
        };
        setStickerContextMenu({
          vin,
          mileage: currentMileage,
          x: e.clientX,
          y: e.clientY,
          intervals: config.intervals || defaultIntervals,
          useKilometers: config.useKilometers || false,
          customerName,
          vehicleYear,
          vehicleMake,
          vehicleModel,
        });
      }
    } catch (err) {
      console.error('Failed to fetch sticker settings', err);
    }
  };

  const handlePrintWithInterval = (intervalType: string) => {
    if (!stickerContextMenu) return;
    const interval = stickerContextMenu.intervals[intervalType];
    if (!interval) return;
    
    const nextDate = new Date();
    nextDate.setMonth(nextDate.getMonth() + interval.months);
    const nextServiceDate = nextDate.toISOString().split('T')[0];
    const nextServiceMileage = stickerContextMenu.mileage + interval.mileage;
    
    const { customerName, vehicleYear, vehicleMake, vehicleModel } = stickerContextMenu;
    setStickerContextMenu(null);
    handleQuickPrintStickerWithValues(
      stickerContextMenu.vin,
      stickerContextMenu.mileage,
      nextServiceMileage,
      nextServiceDate,
      customerName,
      vehicleYear,
      vehicleMake,
      vehicleModel
    );
  };

  const handleOpenCustomModal = () => {
    if (!stickerContextMenu) return;
    const nextDate = new Date();
    nextDate.setMonth(nextDate.getMonth() + 3);
    setCustomDate(nextDate.toISOString().split('T')[0]);
    setCustomMileage(String(stickerContextMenu.mileage + 5000));
    setCustomStickerModal({
      vin: stickerContextMenu.vin,
      mileage: stickerContextMenu.mileage,
      customerName: stickerContextMenu.customerName,
      vehicleYear: stickerContextMenu.vehicleYear,
      vehicleMake: stickerContextMenu.vehicleMake,
      vehicleModel: stickerContextMenu.vehicleModel,
    });
    setStickerContextMenu(null);
  };

  const handlePrintCustom = () => {
    if (!customStickerModal) return;
    handleQuickPrintStickerWithValues(
      customStickerModal.vin,
      customStickerModal.mileage,
      parseInt(customMileage) || customStickerModal.mileage + 5000,
      customDate,
      customStickerModal.customerName,
      customStickerModal.vehicleYear,
      customStickerModal.vehicleMake,
      customStickerModal.vehicleModel
    );
    setCustomStickerModal(null);
  };

  const handleQuickPrintStickerWithValues = async (
    vin: string,
    currentMileage: number,
    nextServiceMileage: number,
    nextServiceDate: string,
    customerName?: string,
    vehicleYear?: number,
    vehicleMake?: string,
    vehicleModel?: string
  ) => {
    setPrintingSticker(vin);
    try {
      let stickerSize = '2x2';
      let includeQR = true;
      
      try {
        const settingsRes = await fetch('/api/sticker/settings');
        if (settingsRes.ok) {
          const settingsData = await settingsRes.json();
          const config = settingsData.config;
          if (config?.defaultSize) stickerSize = config.defaultSize;
          if (config?.showQRCode !== undefined) includeQR = config.showQRCode;
        }
      } catch (e) {
        console.log('Using default settings');
      }
      
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
          customerName,
          vehicleYear,
          vehicleMake,
          vehicleModel,
        }),
      });
      
      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || 'Failed to generate sticker');
      }
      
      const blob = await response.blob();
      const reader = new FileReader();
      
      reader.onloadend = () => {
        const dataUrl = reader.result as string;
        const sizeMap: Record<string, { width: string; height: string }> = {
          '2x2': { width: '2in', height: '2in' },
          '2x2.5': { width: '2in', height: '2.5in' },
          '2x3': { width: '2in', height: '3in' },
          '2x3.5': { width: '2in', height: '3.5in' },
        };
        const dims = sizeMap[stickerSize] || sizeMap['2x2'];
        
        const existingFrame = document.getElementById('sticker-print-frame');
        if (existingFrame) existingFrame.remove();
        
        const iframe = document.createElement('iframe');
        iframe.id = 'sticker-print-frame';
        iframe.style.position = 'fixed';
        iframe.style.right = '0';
        iframe.style.bottom = '0';
        iframe.style.width = '0';
        iframe.style.height = '0';
        iframe.style.border = 'none';
        document.body.appendChild(iframe);
        
        const iframeDoc = iframe.contentDocument || iframe.contentWindow?.document;
        if (iframeDoc) {
          iframeDoc.open();
          iframeDoc.write(`
            <!DOCTYPE html>
            <html>
            <head>
              <title>Print Sticker</title>
              <style>
                @page { size: ${dims.width} ${dims.height}; margin: 0 !important; }
                @media print {
                  html, body { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
                }
                * { margin: 0; padding: 0; box-sizing: border-box; }
                html, body { 
                  width: ${dims.width}; 
                  height: ${dims.height}; 
                  overflow: hidden;
                  display: flex;
                  align-items: center;
                  justify-content: center;
                }
                img { 
                  display: block; 
                  width: ${dims.width}; 
                  height: ${dims.height}; 
                  object-fit: contain;
                }
              </style>
            </head>
            <body><img src="${dataUrl}" /></body>
            </html>
          `);
          iframeDoc.close();
          
          setTimeout(() => {
            iframe.contentWindow?.focus();
            iframe.contentWindow?.print();
            window.dispatchEvent(new CustomEvent("refreshBookingCount"));
          }, 250);
        }
      };
      
      reader.readAsDataURL(blob);
    } catch (error) {
      console.error('Failed to print sticker:', error);
      alert(error instanceof Error ? error.message : 'Failed to generate sticker.');
    } finally {
      setPrintingSticker(null);
    }
  };

  const handlePrintKeytag = async (
    customerName: string,
    vehicle: string,
    vin: string,
    roNumber: string,
    mileage: number | null
  ) => {
    setPrintingKeytag(vin);
    try {
      const res = await fetch('/api/keytag/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          customerName: customerName || 'Customer',
          vehicleInfo: vehicle || 'Vehicle',
          vin: vin || '',
          roNumber: roNumber || '',
          mileage: mileage ?? 0,
        }),
      });

      if (!res.ok) {
        const errorData = await res.json().catch(() => ({}));
        throw new Error(errorData.error || 'Failed to generate keytag');
      }

      const blob = await res.blob();
      const reader = new FileReader();
      reader.onloadend = () => {
        const dataUrl = reader.result as string;
        const printFrame = document.createElement('iframe');
        printFrame.style.position = 'fixed';
        printFrame.style.top = '-9999px';
        printFrame.style.left = '-9999px';
        document.body.appendChild(printFrame);

        const iframeDoc = printFrame.contentWindow?.document;
        if (iframeDoc) {
          iframeDoc.open();
          iframeDoc.write(`
            <!DOCTYPE html>
            <html>
            <head>
              <title>Print Keytag</title>
              <style>
                @page { size: 3.5in 1.125in; margin: 0; }
                * { margin: 0; padding: 0; box-sizing: border-box; }
                html, body { width: 3.5in; height: 1.125in; overflow: hidden; }
                img { display: block; width: 100%; height: 100%; }
              </style>
            </head>
            <body>
              <img src="${dataUrl}" />
            </body>
            </html>
          `);
          iframeDoc.close();

          printFrame.onload = () => {
            setTimeout(() => {
              printFrame.contentWindow?.print();
              setTimeout(() => {
                document.body.removeChild(printFrame);
              }, 1000);
            }, 100);
          };
        }
      };
      reader.readAsDataURL(blob);
    } catch (error) {
      console.error('Failed to print keytag:', error);
      alert(error instanceof Error ? error.message : 'Failed to generate keytag.');
    } finally {
      setPrintingKeytag(null);
    }
  };

  const handleQuickPrintSticker = async (
    vin: string, 
    currentMileage: number | null,
    customerName?: string,
    vehicleYear?: number,
    vehicleMake?: string,
    vehicleModel?: string
  ) => {
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
      let usePredictiveDate = false;
      
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
          
          // Check if predictive date is enabled
          if (config?.usePredictiveDate) {
            usePredictiveDate = true;
          }
          
          // Use shop's configured default oil type (or fall back to synthetic)
          const defaultOilType = config?.defaultOilType || 'synthetic';
          if (intervals?.[defaultOilType]) {
            intervalMileage = intervals[defaultOilType].mileage || 5000;
            intervalMonths = intervals[defaultOilType].months || 6;
          } else if (intervals?.synthetic) {
            intervalMileage = intervals.synthetic.mileage || 5000;
            intervalMonths = intervals.synthetic.months || 6;
          } else if (intervals?.conventional) {
            intervalMileage = intervals.conventional.mileage || 3000;
            intervalMonths = intervals.conventional.months || 3;
          }
        }
      } catch (e) {
        console.log('Using default intervals');
      }
      
      // Calculate next service mileage based on shop interval
      const nextServiceMileage = currentMileage + intervalMileage;
      
      // Calculate next service date - use "shortest interval wins" logic
      let nextServiceDate: string;
      
      // Fixed interval date (always calculate as baseline)
      const fixedDate = new Date();
      fixedDate.setMonth(fixedDate.getMonth() + intervalMonths);
      
      if (usePredictiveDate) {
        try {
          const statsRes = await fetch(`/api/vehicle/driving-stats?vin=${encodeURIComponent(vin)}`);
          if (statsRes.ok) {
            const stats = await statsRes.json();
            if (stats.milesPerDay && stats.milesPerDay > 0) {
              // Calculate days until next service based on driving habits
              const daysUntilService = Math.ceil(intervalMileage / stats.milesPerDay);
              const predictiveDate = new Date();
              predictiveDate.setDate(predictiveDate.getDate() + daysUntilService);
              
              // Use the SHORTER of the two intervals (earliest date)
              if (predictiveDate < fixedDate) {
                nextServiceDate = predictiveDate.toISOString().split('T')[0];
              } else {
                nextServiceDate = fixedDate.toISOString().split('T')[0];
              }
            } else {
              // No driving data, use fixed interval
              nextServiceDate = fixedDate.toISOString().split('T')[0];
            }
          } else {
            nextServiceDate = fixedDate.toISOString().split('T')[0];
          }
        } catch (e) {
          nextServiceDate = fixedDate.toISOString().split('T')[0];
        }
      } else {
        nextServiceDate = fixedDate.toISOString().split('T')[0];
      }
      
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
          customerName,
          vehicleYear,
          vehicleMake,
          vehicleModel,
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
        
        const sizeMap: Record<string, { width: string; height: string }> = {
          '2x2': { width: '2in', height: '2in' },
          '2x2.5': { width: '2in', height: '2.5in' },
          '2x3': { width: '2in', height: '3in' },
          '2x3.5': { width: '2in', height: '3.5in' },
        };
        const dims = sizeMap[stickerSize] || sizeMap['2x2'];
        
        const existingFrame = document.getElementById('sticker-print-frame');
        if (existingFrame) existingFrame.remove();
        
        const iframe = document.createElement('iframe');
        iframe.id = 'sticker-print-frame';
        iframe.style.position = 'fixed';
        iframe.style.right = '0';
        iframe.style.bottom = '0';
        iframe.style.width = '0';
        iframe.style.height = '0';
        iframe.style.border = 'none';
        document.body.appendChild(iframe);
        
        const iframeDoc = iframe.contentDocument || iframe.contentWindow?.document;
        if (iframeDoc) {
          iframeDoc.open();
          iframeDoc.write(`
            <!DOCTYPE html>
            <html>
            <head>
              <title>Print Sticker</title>
              <style>
                @page { size: ${dims.width} ${dims.height}; margin: 0 !important; }
                @media print {
                  html, body { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
                }
                * { margin: 0; padding: 0; box-sizing: border-box; }
                html, body { 
                  width: ${dims.width}; 
                  height: ${dims.height}; 
                  overflow: hidden;
                  display: flex;
                  align-items: center;
                  justify-content: center;
                }
                img { 
                  display: block; 
                  width: ${dims.width}; 
                  height: ${dims.height}; 
                  object-fit: contain;
                }
              </style>
            </head>
            <body><img src="${dataUrl}" /></body>
            </html>
          `);
          iframeDoc.close();
          
          setTimeout(() => {
            iframe.contentWindow?.focus();
            iframe.contentWindow?.print();
            window.dispatchEvent(new CustomEvent("refreshBookingCount"));
          }, 250);
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
    let newDirection: SortDirection;
    if (sortColumn === column) {
      newDirection = sortDirection === 'asc' ? 'desc' : 'asc';
      setSortDirection(newDirection);
    } else {
      newDirection = column === 'mileage' ? 'desc' : 'asc';
      setSortColumn(column);
      setSortDirection(newDirection);
      localStorage.setItem('dashboard_sort_column', column);
    }
    localStorage.setItem('dashboard_sort_direction', newDirection);
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
  }, []);

  useEffect(() => {
    // Automatically prefetch plan data for visible vehicles when dashboard loads
    // Prioritize by highest RO# (most recent) and in-progress status
    if (data.rows?.length > 0) {
      const vehiclesWithData = data.rows.map((row: any) => {
        const mileageRaw = row.displayMiles || row.vehicle?.miles || row.mileage;
        const mileage = typeof mileageRaw === 'number' ? mileageRaw :
                       typeof mileageRaw === 'string' ? parseInt(mileageRaw.replace(/,/g, ''), 10) || null : null;
        const roRaw = row.displayRO || row.roNumber || row.ro || '';
        const roNumber = typeof roRaw === 'number' ? roRaw :
                        typeof roRaw === 'string' ? parseInt(roRaw.replace(/\D/g, ''), 10) || 0 : 0;
        return {
          vin: row.displayVin || row.vin,
          mileage,
          inProgress: row.displayStatus === 'in-progress' || row.status === 'in-progress',
          roNumber,
        };
      }).filter((v: any) => v.vin && v.vin.length === 17);
      
      // Sort by: in-progress first, then by highest RO# (most recent)
      vehiclesWithData.sort((a: any, b: any) => {
        if (a.inProgress && !b.inProgress) return -1;
        if (!a.inProgress && b.inProgress) return 1;
        return b.roNumber - a.roNumber; // Highest RO# first
      });
      
      const vehiclesToPrefetch = vehiclesWithData.slice(0, 50);
      const shopId = data.shopId || data.user?.shopId;
      
      if (vehiclesToPrefetch.length > 0 && shopId) {
        queueMultiplePrefetch(vehiclesToPrefetch, shopId, 50);
      }
    }
  }, [data.rows, data.shopId, data.user?.shopId]);

  useEffect(() => {
    let lastKnownUpdate = 0;
    let lastFullRefresh = Date.now();
    const POLL_INTERVAL = 3000;
    const FULL_REFRESH_INTERVAL = 30000;

    const checkForUpdates = async () => {
      try {
        const now = Date.now();
        if (now - lastFullRefresh >= FULL_REFRESH_INTERVAL) {
          lastFullRefresh = now;
          loadData(currentPage, searchQuery, showArchived);
          return;
        }

        const response = await fetch('/api/dashboard/updates');
        if (response.ok) {
          const result = await response.json();
          if (result.lastUpdate && result.lastUpdate > lastKnownUpdate) {
            if (lastKnownUpdate > 0) {
              loadData(currentPage, searchQuery, showArchived);
            }
            lastKnownUpdate = result.lastUpdate;
          }
        }
      } catch (e) {
      }
    };

    checkForUpdates();
    const interval = setInterval(checkForUpdates, POLL_INTERVAL);
    return () => clearInterval(interval);
  }, [currentPage, searchQuery, showArchived]);

  // NOTE: check-closed-orders polling disabled - Protractor webhooks now handle
  // work order status updates in real-time via /api/webhooks/protractor/[token]
  // This eliminates the need for polling and prevents API rate limiting issues.

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
            {data.smsType === "protractor" && (
              <button
                onClick={() => setShowNewWorkOrder(true)}
                className="flex items-center gap-1 sm:gap-2 px-2 sm:px-4 py-1.5 sm:py-2 text-xs sm:text-sm font-medium text-white bg-green-600 rounded-lg hover:bg-green-700 transition-colors"
              >
                <Wrench className="w-3.5 h-3.5 sm:w-4 sm:h-4" />
                <span className="hidden sm:inline">New RO</span>
              </button>
            )}
            <button
              onClick={() => setShowAddVehicle(true)}
              className="flex items-center gap-1 sm:gap-2 px-2 sm:px-4 py-1.5 sm:py-2 text-xs sm:text-sm font-medium text-white bg-blue-600 rounded-lg hover:bg-blue-700 transition-colors"
            >
              <Plus className="w-3.5 h-3.5 sm:w-4 sm:h-4" />
              <span className="hidden sm:inline">Vehicle</span>
            </button>
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
          <div className="px-4 sm:px-6 py-3 sm:py-4 border-b border-gray-200">
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
              <div className="relative flex-1 sm:flex-none">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
                <input
                  type="text"
                  placeholder="Search vehicles..."
                  value={searchQuery}
                  onChange={(e) => handleSearchChange(e.target.value)}
                  className="w-full sm:w-64 pl-10 pr-4 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                />
              </div>
              <div className="flex items-center gap-4 text-xs sm:text-sm text-gray-500">
                <span>
                  Showing {((pagination.page - 1) * pagination.pageSize) + 1}-{Math.min(pagination.page * pagination.pageSize, pagination.totalCount)} of {pagination.totalCount}
                </span>
              </div>
            </div>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px]">
              <thead className="bg-gray-50 text-left text-xs sm:text-sm text-gray-600">
                <tr>
                  <SortHeader column="customer">Customer</SortHeader>
                  <SortHeader column="vehicle"><span className="hidden sm:inline">Vehicle</span><span className="sm:hidden">Veh.</span></SortHeader>
                  <SortHeader column="vin">VIN</SortHeader>
                  <SortHeader column="ro">RO #</SortHeader>
                  <SortHeader column="status">{data.smsType === 'protractor' ? 'Stage' : 'Status'}</SortHeader>
                  <SortHeader column="dvi">DVI</SortHeader>
                  <SortHeader column="mileage"><span className="hidden sm:inline">{data.distanceUnit === "kilometers" ? "Odometer" : "Mileage"}</span><span className="sm:hidden">Mi.</span></SortHeader>
                  <th className="px-3 sm:px-6 py-3 font-medium"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-200">
                {sortedRows.map((r: any, index: number) => {
                  const vin = r.displayVin || "";
                  const statusText = r.displayStatus || r.af?.status || "Unknown";
                  const rowKey = r.displayRo ? `${vin}-${r.displayRo}` : `${vin}-${index}`;
                  
                  return (
                    <tr key={rowKey} className="hover:bg-gray-50 transition-colors">
                      <td className="px-3 sm:px-6 py-3 sm:py-4">
                        <Link href={VEHICLE_HREF(vin)} className="text-gray-900 font-medium hover:text-blue-600 transition-colors text-sm">
                          {r.displayName || "Unknown"}
                        </Link>
                      </td>
                      <td className="px-3 sm:px-6 py-3 sm:py-4 text-gray-600 text-sm">
                        {r.displayVehicle && r.displayVehicle.trim() !== "" ? (
                          (() => {
                            const make = getRowMake(r);
                            const logoUrl = getOELogoUrl(make);
                            return (
                              <div className="flex items-center gap-2 min-w-0">
                                {logoUrl && (
                                  <img
                                    src={logoUrl}
                                    alt={make || ""}
                                    className="h-6 sm:h-7 w-auto object-contain flex-shrink-0"
                                  />
                                )}
                                <span className="truncate">{r.displayVehicle}</span>
                              </div>
                            );
                          })()
                        ) : "—"}
                      </td>
                      <td className="px-3 sm:px-6 py-3 sm:py-4">
                        <VinSpecsTooltip vin={vin} specs={data.quickSpecs?.[vin]} />
                      </td>
                      <td className="px-3 sm:px-6 py-3 sm:py-4">
                        {r.displayRo ? (
                          <span className="text-gray-600 text-sm">{r.displayRo}</span>
                        ) : (
                          <span className="text-gray-400">—</span>
                        )}
                      </td>
                      <td className="px-3 sm:px-6 py-3 sm:py-4">
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
                      <td className="px-3 sm:px-6 py-3 sm:py-4">
                        {r.dviDone ? (
                          <div className="w-5 h-5 sm:w-6 sm:h-6 bg-green-100 rounded-full flex items-center justify-center">
                            <CheckCircle className="w-3 h-3 sm:w-4 sm:h-4 text-green-600" />
                          </div>
                        ) : (
                          <div className="w-5 h-5 sm:w-6 sm:h-6 bg-gray-100 rounded-full flex items-center justify-center">
                            <Clock className="w-3 h-3 sm:w-4 sm:h-4 text-gray-400" />
                          </div>
                        )}
                      </td>
                      <td className="px-3 sm:px-6 py-3 sm:py-4 font-mono text-xs sm:text-sm text-gray-600">
                        {r.displayMiles != null ? (
                          <span
                            className={r.mileageEstimated ? 'font-bold italic cursor-help border-b border-dashed border-neutral-400' : ''}
                            title={r.mileageEstimated && r.mileageEstimateDetails
                              ? `Estimated from CARFAX (${r.mileageEstimateDetails.dataPoints} data points)\nLast recorded: ${Number(r.mileageEstimateDetails.lastRecordedMileage).toLocaleString()} mi on ${r.mileageEstimateDetails.lastRecordedDate}\nAvg: ${r.mileageEstimateDetails.milesPerDay} mi/day`
                              : undefined}
                          >
                            {Number(r.displayMiles).toLocaleString()}{r.mileageEstimated ? ' (est.)' : ''}
                          </span>
                        ) : "—"}
                      </td>
                      <td className="px-3 sm:px-6 py-3 sm:py-4">
                        <div className="flex items-center gap-1 sm:gap-2">
                          {r.displayMiles != null && r.displayMiles > 0 ? (
                            <Link
                              href={VEHICLE_HREF(vin)}
                              className="p-1.5 text-sky-500 hover:text-sky-700 hover:bg-sky-50 rounded transition-colors"
                              title="View Vehicle Health Indicator"
                            >
                              <HeartPulse className="w-4 h-4" />
                            </Link>
                          ) : (
                            <span 
                              className="p-1.5 text-gray-300 cursor-not-allowed"
                              title="Mileage required for recommendations"
                            >
                              <HeartPulse className="w-4 h-4" />
                            </span>
                          )}
                          {data.enabledFeatures?.includes('job_lookup') ? (
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
                          ) : (
                            <span
                              className="p-1.5 text-gray-300 cursor-not-allowed"
                              title="Job Lookup not enabled for this shop"
                            >
                              <Wrench className="w-4 h-4" />
                            </span>
                          )}
                          {data.enabledFeatures?.includes('common_failures') ? (
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
                          ) : (
                            <span
                              className="p-1.5 text-gray-300 cursor-not-allowed"
                              title="Common Failures not enabled for this shop"
                            >
                              <AlertTriangle className="w-4 h-4" />
                            </span>
                          )}
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
                              handleQuickPrintSticker(vin, r.displayMiles, r.displayName, year, make, model);
                            }}
                            onContextMenu={(e) => {
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
                              handleStickerRightClick(e, vin, r.displayMiles, r.displayName, year, make, model);
                            }}
                            disabled={printingSticker === vin || !r.displayMiles}
                            className={`p-1.5 rounded transition-colors ${
                              !r.displayMiles 
                                ? "text-gray-300 cursor-not-allowed" 
                                : "text-gray-400 hover:text-green-600 hover:bg-green-50"
                            }`}
                            title={r.displayMiles ? "Quick Print Oil Sticker (Right-click for options)" : "Mileage required for sticker"}
                          >
                            {printingSticker === vin ? (
                              <Loader2 className="w-4 h-4 animate-spin" />
                            ) : (
                              <Printer className="w-4 h-4" />
                            )}
                          </button>
                          {data.enabledFeatures?.includes('keytags') ? (
                            <button
                              onClick={() => handlePrintKeytag(
                                r.displayName || '',
                                r.displayVehicle || '',
                                vin,
                                r.displayRo || '',
                                r.displayMiles
                              )}
                              disabled={printingKeytag === vin}
                              className="p-1.5 rounded transition-colors text-gray-400 hover:text-amber-600 hover:bg-amber-50"
                              title="Print Keytag"
                            >
                              {printingKeytag === vin ? (
                                <Loader2 className="w-4 h-4 animate-spin" />
                              ) : (
                                <Key className="w-4 h-4" />
                              )}
                            </button>
                          ) : (
                            <span
                              className="p-1.5 text-gray-300 cursor-not-allowed"
                              title="Keytags not enabled for this shop"
                            >
                              <Key className="w-4 h-4" />
                            </span>
                          )}
                          {data.enabledFeatures?.includes('concern_assistant') ? (
                            <button
                              onClick={() => {
                                setConcernAssistant({
                                  vin,
                                  vehicleDisplay: r.displayVehicle || '',
                                  workOrderId: r.workOrderGuid || undefined,
                                  workOrderNumber: r.displayRo || undefined,
                                  contactId: r.contactId || undefined,
                                  serviceItemId: r.serviceItemId || undefined,
                                  customerName: r.displayName || undefined,
                                });
                              }}
                              className="p-1.5 rounded transition-colors text-gray-400 hover:text-blue-600 hover:bg-blue-50"
                              title="Concern Assistant"
                            >
                              <MessageSquareText className="w-4 h-4" />
                            </button>
                          ) : (
                            <span
                              className="p-1.5 text-gray-300 cursor-not-allowed"
                              title="Concern Assistant not enabled for this shop"
                            >
                              <MessageSquareText className="w-4 h-4" />
                            </span>
                          )}
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

      {stickerContextMenu && (
        <div
          ref={stickerContextRef}
          className="fixed bg-white rounded-lg shadow-xl border border-gray-200 py-1 z-50 min-w-[200px]"
          style={{ 
            left: Math.min(stickerContextMenu.x, window.innerWidth - 280),
            top: Math.min(stickerContextMenu.y, window.innerHeight - 250),
          }}
        >
          <div className="px-3 py-2 text-xs font-semibold text-gray-500 uppercase border-b border-gray-100">
            Oil Type Presets
          </div>
          <button
            onClick={() => handlePrintWithInterval('conventional')}
            className="w-full px-3 py-2 text-left text-sm text-gray-700 hover:bg-gray-100 flex justify-between"
          >
            <span>Conventional</span>
            <span className="text-gray-400">
              {stickerContextMenu.intervals.conventional?.mileage?.toLocaleString()} {stickerContextMenu.useKilometers ? 'km' : 'mi'} / {stickerContextMenu.intervals.conventional?.months} mo
            </span>
          </button>
          <button
            onClick={() => handlePrintWithInterval('synthetic')}
            className="w-full px-3 py-2 text-left text-sm text-gray-700 hover:bg-gray-100 flex justify-between"
          >
            <span>Synthetic</span>
            <span className="text-gray-400">
              {stickerContextMenu.intervals.synthetic?.mileage?.toLocaleString()} {stickerContextMenu.useKilometers ? 'km' : 'mi'} / {stickerContextMenu.intervals.synthetic?.months} mo
            </span>
          </button>
          <button
            onClick={() => handlePrintWithInterval('euro')}
            className="w-full px-3 py-2 text-left text-sm text-gray-700 hover:bg-gray-100 flex justify-between"
          >
            <span>European</span>
            <span className="text-gray-400">
              {stickerContextMenu.intervals.euro?.mileage?.toLocaleString()} {stickerContextMenu.useKilometers ? 'km' : 'mi'} / {stickerContextMenu.intervals.euro?.months} mo
            </span>
          </button>
          <button
            onClick={() => handlePrintWithInterval('diesel')}
            className="w-full px-3 py-2 text-left text-sm text-gray-700 hover:bg-gray-100 flex justify-between"
          >
            <span>Diesel</span>
            <span className="text-gray-400">
              {stickerContextMenu.intervals.diesel?.mileage?.toLocaleString()} {stickerContextMenu.useKilometers ? 'km' : 'mi'} / {stickerContextMenu.intervals.diesel?.months} mo
            </span>
          </button>
          <div className="border-t border-gray-100 mt-1 pt-1">
            <button
              onClick={handleOpenCustomModal}
              className="w-full px-3 py-2 text-left text-sm text-blue-600 hover:bg-blue-50 font-medium"
            >
              Custom Date/Mileage...
            </button>
          </div>
        </div>
      )}

      {customStickerModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-xl shadow-2xl w-full max-w-sm">
            <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200">
              <h2 className="text-lg font-semibold text-gray-900">Custom Sticker Values</h2>
              <button
                onClick={() => setCustomStickerModal(null)}
                className="p-2 text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded-lg transition-colors"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="p-6 space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Next Service Date</label>
                <input
                  type="date"
                  value={customDate}
                  onChange={(e) => setCustomDate(e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Next Service Mileage</label>
                <input
                  type="number"
                  value={customMileage}
                  onChange={(e) => setCustomMileage(e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                />
              </div>
              <div className="flex gap-3 pt-2">
                <button
                  onClick={() => setCustomStickerModal(null)}
                  className="flex-1 px-4 py-2 text-gray-700 bg-gray-100 rounded-lg hover:bg-gray-200 transition-colors"
                >
                  Cancel
                </button>
                <button
                  onClick={handlePrintCustom}
                  className="flex-1 px-4 py-2 text-white bg-blue-600 rounded-lg hover:bg-blue-700 transition-colors"
                >
                  Print Sticker
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      <AddVehicleModal
        isOpen={showAddVehicle}
        onClose={() => setShowAddVehicle(false)}
        onVehicleAdded={handleVehicleAdded}
      />

      <NewWorkOrderModal
        isOpen={showNewWorkOrder}
        onClose={() => setShowNewWorkOrder(false)}
        onCreated={() => refreshData()}
      />

      <ConcernAssistantModal
        isOpen={!!concernAssistant}
        onClose={() => setConcernAssistant(null)}
        vin={concernAssistant?.vin}
        vehicleDisplay={concernAssistant?.vehicleDisplay}
        workOrderId={concernAssistant?.workOrderId}
        workOrderNumber={concernAssistant?.workOrderNumber}
        contactId={concernAssistant?.contactId}
        serviceItemId={concernAssistant?.serviceItemId}
        customerName={concernAssistant?.customerName}
        smsType={data.smsType}
      />
    </div>
  );
}
