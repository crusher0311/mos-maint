"use client";

import { useState, useEffect } from "react";
import { Building2, Search, RefreshCw, LogIn, Loader2, RotateCcw, Plus, Settings, X, Lock, Unlock, Trash2, ChevronDown, ChevronUp, MapPin, Phone, Clock, CheckCircle2, Clock4, Play, AlertTriangle, Pause, AlertCircle, XCircle, Mail, CreditCard } from "lucide-react";

interface ShopBilling {
  plan: string;
  isPaid: boolean;
  vinLimit: number;
  vinViewCount: number;
  status?: string;
  stripeSubscriptionAmount?: number | null;
  stripeProductName?: string | null;
  cardOnFile?: boolean;
}

interface ShopTrial {
  startedAt: string | null;
  endsAt: string | null;
  days: number | null;
  daysLeft: number | null;
  cardOnFile: boolean;
}

const planLabels: Record<string, string> = {
  trial: "Trial",
  starter: "Starter",
  professional: "Pro",
  enterprise: "Enterprise",
  detect_dog_founder: "Detect Dog - Founder",
  oil_sticker_legacy: "Oil Sticker - Legacy",
  demo: "Demo",
  churned: "Churned",
};

const planColors: Record<string, string> = {
  trial: "bg-gray-100 text-gray-600",
  starter: "bg-blue-100 text-blue-700",
  professional: "bg-green-100 text-green-700",
  enterprise: "bg-indigo-100 text-indigo-700",
  detect_dog_founder: "bg-amber-100 text-amber-700",
  oil_sticker_legacy: "bg-purple-100 text-purple-700",
  demo: "bg-[rgba(60,129,195,0.15)] text-[#3c81c3]",
  churned: "bg-red-100 text-red-700",
};

interface ShopFeatures {
  maintenance?: boolean;
  job_lookup?: boolean;
  common_failures?: boolean;
  oil_sticker?: boolean;
  keytags?: boolean;
  auto_booking?: boolean;
  part_xref?: boolean;
  labor_rates?: boolean;
  concern_assistant?: boolean;
  dvi_prefill?: boolean;
  enhance_notes?: boolean;
}

interface IntegrationDetails {
  protractor?: {
    configuredAt: string;
    locationName: string | null;
    shortName: string | null;
    address: string | null;
    phone: string | null;
    timeZone: string | null;
  } | null;
  carfax?: {
    locationId: string;
  } | null;
  tekmetric?: {
    shopId: string | number;
  } | null;
}

interface CardCaptureEmailEntry {
  sentAt: string | null;
  recipient: string | null;
  source: "admin" | "cron";
  adminEmail: string | null;
  mode: string | null;
  daysLeft: number | null;
}

interface BackfillStatus {
  completed: boolean;
  inProgress: boolean;
  status: "completed" | "active" | "stale" | "error" | "pending";
  isStale?: boolean;
  totalJobsIndexed: number;
  processedCount: number;
  currentChunkDate: string | null;
  lastAttemptedAt: string | null;
  lastActivityAt: string | null;
  lastError: string | null;
  lastErrorAt: string | null;
  source?: "protractor" | "tekmetric";
}

interface Shop {
  _id: string;
  shopId: number | string;
  name: string;
  locationIdentifier?: string | null;
  enterpriseId?: string | null;
  enterpriseName?: string | null;
  createdAt: string;
  userCount: number;
  vehicleCount: number;
  integrations: string[];
  billing: ShopBilling;
  isLocked?: boolean;
  integrationDetails?: IntegrationDetails;
  enabledFeatures?: ShopFeatures | string[];
  backfill?: BackfillStatus | null;
  stickerCount?: number;
  stickerCountThisMonth?: number;
  trial?: ShopTrial | null;
  cardOnFile?: boolean;
  lastCardCaptureEmail?: CardCaptureEmailEntry | null;
  cardCaptureEmailHistory?: CardCaptureEmailEntry[];
}

function formatTimeAgo(input: string | null | undefined): string | null {
  if (!input) return null;
  const t = new Date(input).getTime();
  if (!Number.isFinite(t)) return null;
  const diffMs = Date.now() - t;
  if (diffMs < 0) return "just now";
  const minutes = Math.floor(diffMs / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  const years = Math.floor(days / 365);
  return `${years}y ago`;
}

function describeCardCaptureSource(entry: CardCaptureEmailEntry): string {
  if (entry.source === "admin") {
    return entry.adminEmail ? `admin (${entry.adminEmail})` : "admin";
  }
  if (entry.daysLeft !== null && entry.daysLeft !== undefined) {
    return `cron (${entry.daysLeft}-day reminder)`;
  }
  return "cron";
}

function buildCardCaptureHistoryTitle(history: CardCaptureEmailEntry[] | undefined): string {
  if (!history || history.length === 0) {
    return "No card-capture emails sent yet";
  }
  const lines = history.map((e) => {
    const when = e.sentAt ? new Date(e.sentAt).toLocaleString() : "unknown time";
    const who = e.recipient || "unknown recipient";
    return `• ${when} — ${who} — ${describeCardCaptureSource(e)}`;
  });
  return `Card-capture email history (most recent first):\n${lines.join("\n")}`;
}

export default function PlatformShopsPage() {
  const [shops, setShops] = useState<Shop[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [impersonating, setImpersonating] = useState<number | null>(null);
  const [defaultVinLimit, setDefaultVinLimit] = useState(10);
  const [defaultTrialDays, setDefaultTrialDays] = useState(14);
  const [extendTrialShop, setExtendTrialShop] = useState<Shop | null>(null);
  const [extendTrialDays, setExtendTrialDays] = useState<string>("14");
  const [extendTrialMode, setExtendTrialMode] = useState<"days" | "date">("days");
  const [extendTrialDate, setExtendTrialDate] = useState<string>("");
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [selectedShop, setSelectedShop] = useState<Shop | null>(null);
  const [vinInput, setVinInput] = useState("");
  const [modalAction, setModalAction] = useState<"setLimit" | "addViews" | "resetLimit" | "manageFeatures" | null>(null);
  const [expandedShop, setExpandedShop] = useState<string | null>(null);
  const [featureEdits, setFeatureEdits] = useState<ShopFeatures>({});
  const [billingEdits, setBillingEdits] = useState<{ plan: string; status: string }>({ plan: "trial", status: "trial" });
  const [groupByEnterprise, setGroupByEnterprise] = useState(false);
  type TrialFilter = "all" | "trial_active" | "ending_7" | "ending_3" | "expired" | "no_card";
  type SortBy = "createdAt" | "trialEndsAt";
  const TRIAL_FILTERS: readonly TrialFilter[] = ["all", "trial_active", "ending_7", "ending_3", "expired", "no_card"];
  const SORT_OPTIONS: readonly SortBy[] = ["createdAt", "trialEndsAt"];
  const isTrialFilter = (v: string): v is TrialFilter => (TRIAL_FILTERS as readonly string[]).includes(v);
  const isSortBy = (v: string): v is SortBy => (SORT_OPTIONS as readonly string[]).includes(v);
  const [trialFilter, setTrialFilter] = useState<TrialFilter>("all");
  const [sortBy, setSortBy] = useState<SortBy>("createdAt");
  const [showCreateShop, setShowCreateShop] = useState(false);
  const [createShopData, setCreateShopData] = useState({
    shopName: "",
    ownerEmail: "",
    ownerPassword: "",
    ownerName: "",
    plan: "trial",
    status: "trial",
    vinLimit: "10",
    trialDays: "14",
    features: {
      maintenance: true,
      job_lookup: false,
      common_failures: false,
      oil_sticker: false,
      keytags: false,
      auto_booking: false,
      part_xref: false,
      labor_rates: false,
    } as ShopFeatures,
  });
  const [createLoading, setCreateLoading] = useState(false);

  const createShop = async () => {
    if (!createShopData.shopName || !createShopData.ownerEmail || !createShopData.ownerPassword) {
      alert("Shop name, owner email, and password are required");
      return;
    }
    setCreateLoading(true);
    try {
      const res = await fetch("/api/platform-admin/shops", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(createShopData),
      });
      const data = await res.json();
      if (data.ok) {
        const emailNote = data.emailSent
          ? `\n\nWelcome email with credentials sent to ${createShopData.ownerEmail}.`
          : `\n\nNote: Welcome email could not be sent. Please share the credentials to the user manually.`;
        alert(data.message + emailNote);
        setShowCreateShop(false);
        setCreateShopData({
          shopName: "", ownerEmail: "", ownerPassword: "", ownerName: "",
          plan: "trial", status: "trial", vinLimit: "10",
          trialDays: String(defaultTrialDays || 14),
          features: { maintenance: true, job_lookup: false, common_failures: false, oil_sticker: false, keytags: false, auto_booking: false, part_xref: false, labor_rates: false },
        });
        loadShops();
      } else {
        alert(data.error || "Failed to create shop");
      }
    } catch (err) {
      console.error("Create shop error:", err);
      alert("Failed to create shop");
    } finally {
      setCreateLoading(false);
    }
  };

  const accessShop = async (shopId: number | string) => {
    if (impersonating) return;
    setImpersonating(typeof shopId === 'number' ? shopId : -1);
    try {
      const res = await fetch("/api/platform-admin/impersonate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ shopId }),
      });
      const data = await res.json();
      if (res.ok) {
        window.location.href = "/dashboard";
      } else {
        alert(data.error || "Failed to access shop");
      }
    } catch (err) {
      console.error("Error accessing shop:", err);
      alert("Failed to access shop");
    } finally {
      setImpersonating(null);
    }
  };

  const vinAction = async (shopId: number | string, action: string, value?: number) => {
    setActionLoading(`${shopId}-${action}`);
    try {
      const res = await fetch(`/api/platform-admin/shops/${shopId}/vins`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, value }),
      });
      const data = await res.json();
      if (data.ok) {
        loadShops();
        setSelectedShop(null);
        setModalAction(null);
        setVinInput("");
      } else {
        alert(data.error || "Action failed");
      }
    } catch (err) {
      console.error("VIN action error:", err);
      alert("Action failed");
    } finally {
      setActionLoading(null);
    }
  };

  const toggleLock = async (shopId: number | string, isLocked: boolean) => {
    const action = isLocked ? "unlock" : "lock";
    setActionLoading(`${shopId}-${action}`);
    try {
      const res = await fetch(`/api/platform-admin/shops/${shopId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      const data = await res.json();
      if (data.ok) {
        loadShops();
      } else {
        alert(data.error || "Action failed");
      }
    } catch (err) {
      console.error("Lock/unlock error:", err);
      alert("Action failed");
    } finally {
      setActionLoading(null);
    }
  };

  const resendCardCaptureEmail = async (shop: Shop) => {
    if (!confirm(`Resend the card-capture email to the owner of "${shop.name}"?`)) return;
    setActionLoading(`${shop.shopId}-resend-card`);
    try {
      const res = await fetch(`/api/platform-admin/shops/${shop.shopId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "resend_card_capture" }),
      });
      const data = await res.json();
      if (data.ok) {
        alert(data.message || "Card-capture email sent");
        loadShops();
      } else {
        alert(data.error || "Failed to send email");
      }
    } catch (err) {
      console.error("Resend card-capture error:", err);
      alert("Failed to send email");
    } finally {
      setActionLoading(null);
    }
  };

  const updateShopSettings = async (shopId: number | string, billing?: { plan: string; status: string }, features?: ShopFeatures) => {
    setActionLoading(`${shopId}-settings`);
    try {
      const res = await fetch(`/api/platform-admin/shops/${shopId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ billing, features }),
      });
      const data = await res.json();
      if (data.ok) {
        loadShops();
        setSelectedShop(null);
        setModalAction(null);
      } else {
        alert(data.error || "Update failed");
      }
    } catch (err) {
      console.error("Update shop settings error:", err);
      alert("Update failed");
    } finally {
      setActionLoading(null);
    }
  };

  const extendTrial = async () => {
    if (!extendTrialShop) return;
    let body: any = null;
    if (extendTrialMode === "days") {
      const days = Number(extendTrialDays);
      if (!Number.isFinite(days) || days < 1 || days > 365) {
        alert("Trial extension must be between 1 and 365 days");
        return;
      }
      body = { trial: { extendDays: days } };
    } else {
      if (!extendTrialDate) {
        alert("Please pick a new trial end date");
        return;
      }
      const parsed = new Date(`${extendTrialDate}T23:59:59`);
      if (Number.isNaN(parsed.getTime())) {
        alert("Invalid date");
        return;
      }
      body = { trial: { endsAt: parsed.toISOString() } };
    }
    setActionLoading(`${extendTrialShop.shopId}-extend`);
    try {
      const res = await fetch(`/api/platform-admin/shops/${extendTrialShop.shopId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (data.ok) {
        setExtendTrialShop(null);
        setExtendTrialDays("14");
        setExtendTrialDate("");
        setExtendTrialMode("days");
        loadShops();
      } else {
        alert(data.error || "Failed to extend trial");
      }
    } catch (err) {
      console.error("Extend trial error:", err);
      alert("Failed to extend trial");
    } finally {
      setActionLoading(null);
    }
  };

  const triggerBackfill = async (shopId: number | string, action: "resume" | "reset") => {
    const numericShopId = typeof shopId === 'string' ? parseInt(shopId) : shopId;
    setActionLoading(`${shopId}-backfill`);
    try {
      const res = await fetch("/api/platform-admin/backfill", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ shopId: numericShopId, action }),
      });
      const data = await res.json();
      if (data.ok) {
        alert(data.message);
        loadShops();
      } else {
        alert(data.error || "Backfill action failed");
      }
    } catch (err) {
      console.error("Backfill error:", err);
      alert("Backfill action failed");
    } finally {
      setActionLoading(null);
    }
  };

  const openFeatureModal = (shop: Shop) => {
    setSelectedShop(shop);
    
    // Convert enabledFeatures to object format if it's an array
    let features: ShopFeatures = {};
    if (Array.isArray(shop.enabledFeatures)) {
      // Convert array format to object format
      shop.enabledFeatures.forEach((f: string) => {
        features[f as keyof ShopFeatures] = true;
      });
    } else if (shop.enabledFeatures && typeof shop.enabledFeatures === 'object') {
      features = shop.enabledFeatures;
    }
    
    setFeatureEdits(features);
    setBillingEdits({ 
      plan: shop.billing.plan || "trial", 
      status: shop.billing.status || "trial" 
    });
    setVinInput(String(shop.billing.vinLimit || 10));
    setModalAction("manageFeatures");
  };

  const deleteShop = async (shop: Shop) => {
    if (!confirm(`Are you sure you want to PERMANENTLY DELETE "${shop.name}"?\n\nThis will remove:\n- The shop\n- All users\n- All sessions\n\nThis action cannot be undone!`)) {
      return;
    }
    setActionLoading(`${shop.shopId}-delete`);
    try {
      const res = await fetch(`/api/platform-admin/shops/${shop.shopId}`, {
        method: "DELETE",
      });
      const data = await res.json();
      if (data.ok) {
        loadShops();
      } else {
        alert(data.error || "Delete failed");
      }
    } catch (err) {
      console.error("Delete error:", err);
      alert("Delete failed");
    } finally {
      setActionLoading(null);
    }
  };

  useEffect(() => {
    loadShops();
  }, []);

  const loadShops = async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/platform-admin/shops");
      const data = await res.json();
      if (data.ok) {
        setShops(data.shops || []);
        setDefaultVinLimit(data.defaultVinLimit || 10);
        if (typeof data.defaultTrialDays === "number") {
          setDefaultTrialDays(data.defaultTrialDays);
        }
      }
    } catch (err) {
      console.error("Error loading shops:", err);
    } finally {
      setLoading(false);
    }
  };

  // Sync the create-shop form's trialDays to the platform default
  // whenever it loads or changes, so the configured billing setting is
  // honored on first open instead of the hardcoded "14".
  useEffect(() => {
    setCreateShopData((prev) =>
      prev.trialDays === String(defaultTrialDays) ? prev : { ...prev, trialDays: String(defaultTrialDays) },
    );
  }, [defaultTrialDays]);

  const searchLower = search.toLowerCase();
  const now = Date.now();
  const filteredShops = shops
    .filter(shop =>
      shop.name?.toLowerCase().includes(searchLower) ||
      (shop.locationIdentifier && shop.locationIdentifier.toLowerCase().includes(searchLower)) ||
      (shop.enterpriseName && shop.enterpriseName.toLowerCase().includes(searchLower)) ||
      String(shop.shopId).includes(search)
    )
    .filter(shop => {
      if (trialFilter === "all") return true;
      const endsAtMs = shop.trial?.endsAt ? new Date(shop.trial.endsAt).getTime() : null;
      const cardOnFile = !!shop.cardOnFile;
      const daysLeft = shop.trial?.daysLeft ?? null;
      if (trialFilter === "trial_active") return endsAtMs !== null && endsAtMs > now;
      if (trialFilter === "ending_7") return endsAtMs !== null && endsAtMs > now && (daysLeft ?? 999) <= 7;
      if (trialFilter === "ending_3") return endsAtMs !== null && endsAtMs > now && (daysLeft ?? 999) <= 3;
      if (trialFilter === "expired") return endsAtMs !== null && endsAtMs <= now;
      if (trialFilter === "no_card") return endsAtMs !== null && !cardOnFile;
      return true;
    })
    .sort((a, b) => {
      if (sortBy === "trialEndsAt") {
        const aEnds = a.trial?.endsAt ? new Date(a.trial.endsAt).getTime() : Number.POSITIVE_INFINITY;
        const bEnds = b.trial?.endsAt ? new Date(b.trial.endsAt).getTime() : Number.POSITIVE_INFINITY;
        if (aEnds !== bEnds) return aEnds - bEnds;
      }
      return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
    });
  
  // Group shops by enterprise if enabled
  const groupedShops = groupByEnterprise 
    ? (() => {
        const groups: { enterprise: string | null; shops: Shop[] }[] = [];
        const enterpriseMap = new Map<string | null, Shop[]>();
        
        filteredShops.forEach(shop => {
          const key = shop.enterpriseId || null;
          if (!enterpriseMap.has(key)) {
            enterpriseMap.set(key, []);
          }
          enterpriseMap.get(key)!.push(shop);
        });
        
        // Sort: enterprises first (alphabetically), then standalone shops
        const enterpriseKeys = Array.from(enterpriseMap.keys()).sort((a, b) => {
          if (a === null) return 1;
          if (b === null) return -1;
          const nameA = enterpriseMap.get(a)?.[0]?.enterpriseName || '';
          const nameB = enterpriseMap.get(b)?.[0]?.enterpriseName || '';
          return nameA.localeCompare(nameB);
        });
        
        enterpriseKeys.forEach(key => {
          const shopsInGroup = enterpriseMap.get(key)!;
          groups.push({
            enterprise: key ? (shopsInGroup[0]?.enterpriseName || `Enterprise ${key}`) : null,
            shops: shopsInGroup.sort((a, b) => (a.locationIdentifier || a.name).localeCompare(b.locationIdentifier || b.name))
          });
        });
        
        return groups;
      })()
    : null;

  if (loading) {
    return (
      <div className="p-8">
        <div className="animate-pulse space-y-4">
          <div className="h-8 bg-gray-200 rounded w-1/4"></div>
          <div className="h-64 bg-gray-200 rounded-lg"></div>
        </div>
      </div>
    );
  }

  return (
    <div className="p-8 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">All Shops</h1>
          <p className="text-gray-600">Manage all client shops on the platform</p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={async () => {
              if (!confirm("Resume backfill for all shops that haven't completed? This will restart any stalled backfills.")) return;
              setActionLoading("resume-all");
              try {
                const res = await fetch("/api/platform-admin/backfill", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ action: "resume_all_incomplete" }),
                });
                const data = await res.json();
                if (data.ok) {
                  alert(data.message || `Resumed backfill for ${data.totalResumed || 0} shops`);
                  loadShops();
                } else {
                  alert(data.error || "Failed to resume backfills");
                }
              } catch (err) {
                console.error("Resume all error:", err);
                alert("Failed to resume backfills");
              } finally {
                setActionLoading(null);
              }
            }}
            disabled={actionLoading === "resume-all"}
            className="flex items-center gap-2 px-3 py-2 text-sm bg-orange-100 text-orange-700 hover:bg-orange-200 rounded-lg disabled:opacity-50"
          >
            {actionLoading === "resume-all" ? <Loader2 className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4" />}
            Resume All Incomplete
          </button>
          <button
            onClick={loadShops}
            className="p-2 text-gray-600 hover:text-gray-900 hover:bg-gray-100 rounded-lg"
          >
            <RefreshCw className="w-5 h-5" />
          </button>
          <button
            onClick={() => setShowCreateShop(true)}
            className="flex items-center gap-2 px-4 py-2 text-sm bg-[#3c81c3] text-white hover:bg-[#2d6da8] rounded-lg font-medium"
          >
            <Plus className="w-4 h-4" />
            Create Shop
          </button>
        </div>
      </div>

      <div className="flex flex-wrap gap-4 items-center">
        <div className="relative flex-1 min-w-[240px]">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-gray-400" />
          <input
            type="text"
            placeholder="Search shops by name, location, or ID..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full pl-10 pr-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-[#3c81c3] focus:border-transparent"
          />
        </div>
        <div className="flex items-center gap-2">
          <label className="text-xs text-gray-500 whitespace-nowrap">Trial</label>
          <select
            value={trialFilter}
            onChange={(e) => {
              const v = e.target.value;
              if (isTrialFilter(v)) setTrialFilter(v);
            }}
            className="px-3 py-2 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-[#3c81c3]"
          >
            <option value="all">All shops</option>
            <option value="trial_active">Trial active</option>
            <option value="ending_7">Ending in ≤ 7 days</option>
            <option value="ending_3">Ending in ≤ 3 days</option>
            <option value="expired">Trial expired</option>
            <option value="no_card">No card on file</option>
          </select>
        </div>
        <div className="flex items-center gap-2">
          <label className="text-xs text-gray-500 whitespace-nowrap">Sort</label>
          <select
            value={sortBy}
            onChange={(e) => {
              const v = e.target.value;
              if (isSortBy(v)) setSortBy(v);
            }}
            className="px-3 py-2 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-[#3c81c3]"
          >
            <option value="createdAt">Newest first</option>
            <option value="trialEndsAt">Trial ending soonest</option>
          </select>
        </div>
        <label className="flex items-center gap-2 text-sm text-gray-600 whitespace-nowrap cursor-pointer">
          <input
            type="checkbox"
            checked={groupByEnterprise}
            onChange={(e) => setGroupByEnterprise(e.target.checked)}
            className="w-4 h-4 text-[#3c81c3] rounded border-gray-300 focus:ring-[#3c81c3]"
          />
          Group by Enterprise
        </label>
      </div>

      <div className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-x-auto">
        <table className="w-full min-w-[1000px]">
          <thead className="bg-gray-50">
            <tr>
              <th className="text-left px-4 py-3 text-sm font-medium text-gray-600">Shop</th>
              <th className="text-right px-4 py-3 text-sm font-medium text-gray-600">ID</th>
              <th className="text-right px-4 py-3 text-sm font-medium text-gray-600">Users</th>
              <th className="text-right px-4 py-3 text-sm font-medium text-gray-600">Vehicles</th>
              <th className="text-center px-4 py-3 text-sm font-medium text-gray-600">VIN Usage</th>
              <th className="text-center px-4 py-3 text-sm font-medium text-gray-600">Stickers</th>
              <th className="text-left px-4 py-3 text-sm font-medium text-gray-600">Integrations</th>
              <th className="text-center px-4 py-3 text-sm font-medium text-gray-600">Backfill</th>
              <th className="text-left px-4 py-3 text-sm font-medium text-gray-600">Created</th>
              <th className="text-right px-4 py-3 text-sm font-medium text-gray-600">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {filteredShops.length === 0 ? (
              <tr>
                <td colSpan={9} className="px-4 py-8 text-center text-gray-500">
                  {search ? "No shops match your search" : "No shops yet"}
                </td>
              </tr>
            ) : groupByEnterprise && groupedShops ? (
              groupedShops.flatMap((group, groupIndex) => [
                <tr key={`group-${groupIndex}`} className="bg-gray-100">
                  <td colSpan={9} className="px-4 py-2">
                    <div className="flex items-center gap-2 font-medium text-gray-700">
                      <Building2 className="w-4 h-4" />
                      {group.enterprise || "Standalone Shops"}
                      <span className="text-xs text-gray-500 font-normal">({group.shops.length} location{group.shops.length !== 1 ? 's' : ''})</span>
                    </div>
                  </td>
                </tr>,
                ...group.shops.flatMap((shop) => [
                <tr key={`${shop._id}-row`} className="hover:bg-gray-50">
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-3">
                      <div className={`w-8 h-8 rounded-lg flex items-center justify-center ${shop.isLocked ? "bg-red-100" : shop.enterpriseId ? "bg-blue-100" : "bg-[rgba(60,129,195,0.15)]"}`}>
                        {shop.isLocked ? (
                          <Lock className="w-4 h-4 text-red-600" />
                        ) : (
                          <Building2 className={`w-4 h-4 ${shop.enterpriseId ? "text-blue-600" : "text-[#3c81c3]"}`} />
                        )}
                      </div>
                      <div>
                        <div className="flex items-center gap-2">
                          <span className={`font-medium ${shop.isLocked ? "text-red-700" : "text-gray-900"}`}>{shop.name}</span>
                          {shop.locationIdentifier && (
                            <span className="px-1.5 py-0.5 bg-blue-100 text-blue-700 text-xs rounded">{shop.locationIdentifier}</span>
                          )}
                          {shop.isLocked && (
                            <span className="px-1.5 py-0.5 bg-red-100 text-red-700 text-xs rounded">Locked</span>
                          )}
                          <span className={`px-1.5 py-0.5 text-xs rounded ${planColors[shop.billing.plan] || planColors.trial}`}>
                            {planLabels[shop.billing.plan] || shop.billing.plan}
                          </span>
                          {typeof shop.billing.stripeSubscriptionAmount === "number" && shop.billing.stripeSubscriptionAmount > 0 && (
                            <span className="text-xs text-gray-500" title={shop.billing.stripeProductName || undefined}>
                              ${(shop.billing.stripeSubscriptionAmount / 100).toFixed(2)}/mo
                            </span>
                          )}
                          {shop.trial?.endsAt && (
                            <TrialBadge trial={shop.trial} />
                          )}
                          {shop.cardOnFile ? (
                            <span className="px-1.5 py-0.5 bg-emerald-100 text-emerald-700 text-xs rounded inline-flex items-center gap-1" title="Payment method on file">
                              <CreditCard className="w-3 h-3" /> Card on file
                            </span>
                          ) : shop.trial?.endsAt ? (
                            <span className="px-1.5 py-0.5 bg-orange-100 text-orange-700 text-xs rounded inline-flex items-center gap-1" title="No payment method on file yet">
                              <CreditCard className="w-3 h-3" /> No card
                            </span>
                          ) : null}
                          {shop.trial?.endsAt && (
                            <button
                              onClick={() => { setExtendTrialShop(shop); setExtendTrialDays("14"); }}
                              className="px-1.5 py-0.5 text-xs bg-blue-50 text-blue-700 hover:bg-blue-100 rounded"
                              title="Extend trial"
                            >
                              Extend
                            </button>
                          )}
                        </div>
                        {shop.enterpriseName && !groupByEnterprise && (
                          <div className="text-xs text-gray-500">{shop.enterpriseName}</div>
                        )}
                      </div>
                    </div>
                  </td>
                  <td className="px-4 py-3 text-right text-gray-600">{shop.shopId}</td>
                  <td className="px-4 py-3 text-right text-gray-900">{shop.userCount}</td>
                  <td className="px-4 py-3 text-right text-gray-900">{shop.vehicleCount}</td>
                  <td className="px-4 py-3">
                    <div className="flex items-center justify-center gap-2">
                      <div className="text-center">
                        <div className={`text-sm font-medium ${shop.billing.vinViewCount >= shop.billing.vinLimit ? "text-red-600" : shop.billing.isPaid ? "text-green-600" : "text-gray-900"}`}>
                          {shop.billing.vinViewCount} / {shop.billing.vinLimit}
                          {shop.billing.isPaid && <span className="ml-1 text-green-500 text-xs">(Paid)</span>}
                        </div>
                        <div className="w-24 h-1.5 bg-gray-200 rounded-full overflow-hidden">
                          <div 
                            className={`h-full transition-all ${shop.billing.vinViewCount >= shop.billing.vinLimit ? "bg-red-500" : shop.billing.isPaid ? "bg-green-500" : "bg-[#3c81c3]"}`}
                            style={{ width: `${Math.min(100, (shop.billing.vinViewCount / shop.billing.vinLimit) * 100)}%` }}
                          />
                        </div>
                      </div>
                      <div className="flex gap-0.5">
                        <button
                          onClick={() => { setSelectedShop(shop); setModalAction("addViews"); setVinInput("10"); }}
                          title="Add VINs"
                          className="p-1 text-green-600 hover:bg-green-50 rounded"
                        >
                          <Plus className="w-4 h-4" />
                        </button>
                        <button
                          onClick={() => { setSelectedShop(shop); setModalAction("setLimit"); setVinInput(String(shop.billing.vinLimit)); }}
                          title="Set Custom Limit"
                          className="p-1 text-blue-600 hover:bg-blue-50 rounded"
                        >
                          <Settings className="w-4 h-4" />
                        </button>
                        <button
                          onClick={() => { setSelectedShop(shop); setModalAction("resetLimit"); }}
                          title="Reset to Default Limit"
                          className="p-1 text-gray-500 hover:bg-gray-50 rounded"
                        >
                          <X className="w-4 h-4" />
                        </button>
                        <button
                          onClick={() => { if(confirm(`Reset all viewed VINs for ${shop.name}? This will start their trial fresh.`)) vinAction(shop.shopId, "resetViews"); }}
                            title="Reset Viewed VINs (Start Fresh)"
                            disabled={actionLoading === `${shop.shopId}-resetViews`}
                            className="p-1 text-orange-600 hover:bg-orange-50 rounded disabled:opacity-50"
                          >
                            {actionLoading === `${shop.shopId}-resetViews` ? (
                              <Loader2 className="w-4 h-4 animate-spin" />
                            ) : (
                              <RotateCcw className="w-4 h-4" />
                            )}
                          </button>
                        </div>
                      </div>
                    </td>
                  <td className="px-4 py-3 text-center">
                    <div className="text-sm">
                      <span className="font-medium text-gray-900">{shop.stickerCountThisMonth || 0}</span>
                      <span className="text-gray-400 text-xs ml-1">/ {shop.stickerCount || 0}</span>
                    </div>
                    <div className="text-xs text-gray-500">this month / total</div>
                  </td>
                  <td className="px-4 py-3">
                    {shop.integrations?.length > 0 ? (
                      <button
                        onClick={() => setExpandedShop(expandedShop === shop._id ? null : shop._id)}
                        className="flex items-center gap-1 text-left hover:bg-gray-50 rounded px-1 -mx-1"
                      >
                        <div className="flex gap-1 flex-wrap items-center">
                          {shop.integrations.map(int => {
                            const iconMap: Record<string, string> = {
                              "Protractor": "/protractor-icon.png",
                              "Tekmetric": "/tekmetric-logo.png",
                              "CARFAX": "/icons/carfax.png",
                              "AutoFlow": "/icons/autoflow.png",
                              "Shop-Ware": "/logos/shopware.png",
                            };
                            const icon = iconMap[int];
                            return icon ? (
                              <img 
                                key={int}
                                src={icon}
                                alt={int}
                                title={int}
                                className="w-6 h-6 rounded object-contain"
                              />
                            ) : (
                              <span key={int} className={`px-2 py-0.5 text-xs rounded font-medium ${
                                int === "AutoVitals" ? "bg-orange-100 text-orange-700" : "bg-gray-100 text-gray-700"
                              }`}>
                                {int}
                              </span>
                            );
                          })}
                        </div>
                        {expandedShop === shop._id ? (
                          <ChevronUp className="w-4 h-4 text-gray-400 flex-shrink-0" />
                        ) : (
                          <ChevronDown className="w-4 h-4 text-gray-400 flex-shrink-0" />
                        )}
                      </button>
                    ) : (
                      <span className="text-gray-400 text-sm">None</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-center">
                    {shop.backfill ? (
                      shop.backfill.status === "completed" ? (
                        <div className="flex items-center justify-center gap-1" title={`Completed: ${shop.backfill.totalJobsIndexed.toLocaleString()} jobs indexed (${shop.backfill.source || 'unknown'})`}>
                          <CheckCircle2 className="w-4 h-4 text-green-600" />
                          <span className="text-xs text-green-600">{shop.backfill.totalJobsIndexed.toLocaleString()}</span>
                        </div>
                      ) : shop.backfill.status === "active" ? (
                        <div className="flex items-center justify-center gap-1" title={`Active: ${shop.backfill.processedCount.toLocaleString()} WOs processed, ${shop.backfill.totalJobsIndexed.toLocaleString()} jobs indexed. Processing: ${shop.backfill.currentChunkDate ? new Date(shop.backfill.currentChunkDate).toLocaleDateString() : 'starting'}. Last activity: ${shop.backfill.lastActivityAt ? new Date(shop.backfill.lastActivityAt).toLocaleTimeString() : 'unknown'}`}>
                          <Loader2 className="w-4 h-4 text-blue-500 animate-spin" />
                          <span className="text-xs text-blue-600">{shop.backfill.totalJobsIndexed.toLocaleString()}</span>
                        </div>
                      ) : shop.backfill.status === "stale" ? (
                        <div className="flex items-center justify-center gap-1" title={`Stale (no activity in 5+ min): ${shop.backfill.processedCount.toLocaleString()} WOs processed, ${shop.backfill.totalJobsIndexed.toLocaleString()} jobs indexed. Last activity: ${shop.backfill.lastActivityAt ? new Date(shop.backfill.lastActivityAt).toLocaleString() : 'unknown'}`}>
                          <AlertCircle className="w-4 h-4 text-orange-500" />
                          <span className="text-xs text-orange-600">{shop.backfill.totalJobsIndexed.toLocaleString()}</span>
                        </div>
                      ) : shop.backfill.status === "error" ? (
                        <div className="flex items-center justify-center gap-1" title={`Error: ${shop.backfill.lastError || 'Unknown error'}. Last run: ${shop.backfill.lastErrorAt ? new Date(shop.backfill.lastErrorAt).toLocaleString() : 'unknown'}`}>
                          <XCircle className="w-4 h-4 text-red-500" />
                          <span className="text-xs text-red-600">{shop.backfill.totalJobsIndexed.toLocaleString()}</span>
                        </div>
                      ) : (
                        <div className="flex items-center justify-center gap-1" title={`Pending: ${shop.backfill.processedCount.toLocaleString()} WOs processed, ${shop.backfill.totalJobsIndexed.toLocaleString()} jobs indexed. Last run: ${shop.backfill.lastAttemptedAt ? new Date(shop.backfill.lastAttemptedAt).toLocaleString() : 'never'}`}>
                          <Pause className="w-4 h-4 text-amber-500" />
                          <span className="text-xs text-amber-600">{shop.backfill.totalJobsIndexed.toLocaleString()}</span>
                        </div>
                      )
                    ) : (
                      <span className="text-gray-300">—</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-gray-600 text-sm">
                    {new Date(shop.createdAt).toLocaleDateString()}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <div className="flex items-center justify-end gap-2">
                      <button
                        onClick={() => openFeatureModal(shop)}
                        disabled={actionLoading !== null}
                        title="Manage billing & features"
                        className="p-1.5 text-[#3c81c3] hover:bg-[rgba(60,129,195,0.1)] rounded-lg transition-colors disabled:opacity-50"
                      >
                        <Settings className="w-4 h-4" />
                      </button>
                      {shop.trial?.endsAt && (() => {
                        const lastEmail = shop.lastCardCaptureEmail || null;
                        const sentAgo = lastEmail ? formatTimeAgo(lastEmail.sentAt) : null;
                        const sentMs = lastEmail?.sentAt ? Date.now() - new Date(lastEmail.sentAt).getTime() : null;
                        const isRecent = sentMs !== null && sentMs < 24 * 60 * 60 * 1000;
                        const baseTitle = shop.cardOnFile
                          ? "Resend card-capture email (card already on file)"
                          : "Resend card-capture email to owner";
                        const historyTitle = buildCardCaptureHistoryTitle(shop.cardCaptureEmailHistory);
                        const lastLine = lastEmail
                          ? `Last sent ${sentAgo} to ${lastEmail.recipient || "unknown"} via ${describeCardCaptureSource(lastEmail)}`
                          : "No card-capture emails sent yet";
                        return (
                          <div className="flex items-center gap-1">
                            <button
                              onClick={() => resendCardCaptureEmail(shop)}
                              disabled={actionLoading !== null}
                              title={`${baseTitle}\n\n${lastLine}\n\n${historyTitle}`}
                              className={`relative p-1.5 rounded-lg transition-colors disabled:opacity-50 ${
                                shop.cardOnFile
                                  ? "text-gray-500 hover:bg-gray-50"
                                  : "text-amber-600 hover:bg-amber-50"
                              }`}
                            >
                              {actionLoading === `${shop.shopId}-resend-card` ? (
                                <Loader2 className="w-4 h-4 animate-spin" />
                              ) : (
                                <Mail className="w-4 h-4" />
                              )}
                              {isRecent && (
                                <span
                                  className="absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full bg-emerald-500 ring-2 ring-white"
                                  aria-hidden="true"
                                />
                              )}
                            </button>
                            {sentAgo && (
                              <span
                                className={`text-[11px] leading-tight ${isRecent ? "text-emerald-700" : "text-gray-500"} flex flex-col max-w-[140px]`}
                                title={`${lastLine}\n\n${historyTitle}`}
                              >
                                <span className="whitespace-nowrap">Sent {sentAgo}</span>
                                {lastEmail?.recipient && (
                                  <span className="truncate text-gray-500">
                                    to {lastEmail.recipient}
                                    {lastEmail.source === "admin" ? " · admin" : " · cron"}
                                  </span>
                                )}
                              </span>
                            )}
                          </div>
                        );
                      })()}
                      <button
                        onClick={() => toggleLock(shop.shopId, !!shop.isLocked)}
                        disabled={actionLoading !== null}
                        title={shop.isLocked ? "Unlock shop" : "Lock shop"}
                        className={`p-1.5 rounded-lg transition-colors disabled:opacity-50 ${
                          shop.isLocked 
                            ? "text-green-600 hover:bg-green-50" 
                            : "text-orange-600 hover:bg-orange-50"
                        }`}
                      >
                        {actionLoading === `${shop.shopId}-lock` || actionLoading === `${shop.shopId}-unlock` ? (
                          <Loader2 className="w-4 h-4 animate-spin" />
                        ) : shop.isLocked ? (
                          <Unlock className="w-4 h-4" />
                        ) : (
                          <Lock className="w-4 h-4" />
                        )}
                      </button>
                      <button
                        onClick={() => deleteShop(shop)}
                        disabled={actionLoading !== null}
                        title="Delete shop permanently"
                        className="p-1.5 text-red-600 hover:bg-red-50 rounded-lg transition-colors disabled:opacity-50"
                      >
                        {actionLoading === `${shop.shopId}-delete` ? (
                          <Loader2 className="w-4 h-4 animate-spin" />
                        ) : (
                          <Trash2 className="w-4 h-4" />
                        )}
                      </button>
                      <button
                        onClick={() => accessShop(shop.shopId)}
                        disabled={impersonating !== null || shop.isLocked}
                        title={shop.isLocked ? "Shop is locked" : "Access this shop"}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-[rgba(60,129,195,0.75)] text-white text-sm font-medium rounded-lg hover:bg-[#3c81c3] disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                      >
                        {impersonating === shop.shopId ? (
                          <Loader2 className="w-4 h-4 animate-spin" />
                        ) : (
                          <LogIn className="w-4 h-4" />
                        )}
                        Access
                      </button>
                    </div>
                  </td>
                </tr>,
                expandedShop === shop._id && shop.integrationDetails ? (
                  <tr key={`${shop._id}-expanded`} className="bg-blue-50">
                    <td colSpan={9} className="px-4 py-4">
                      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                        {shop.integrationDetails.protractor && (
                          <div className="bg-white rounded-lg p-4 border border-blue-200">
                            <div className="flex items-center gap-2 mb-3">
                              <span className="px-2 py-0.5 bg-blue-100 text-blue-700 text-xs rounded font-medium">Protractor</span>
                              <span className="text-xs text-gray-500">
                                Connected {new Date(shop.integrationDetails.protractor.configuredAt).toLocaleDateString()}
                              </span>
                            </div>
                            {shop.integrationDetails.protractor.locationName && (
                              <div className="font-medium text-gray-900 mb-2">
                                {shop.integrationDetails.protractor.locationName}
                                {shop.integrationDetails.protractor.shortName && (
                                  <span className="text-gray-500 font-normal"> ({shop.integrationDetails.protractor.shortName})</span>
                                )}
                              </div>
                            )}
                            {shop.integrationDetails.protractor.address && (
                              <div className="flex items-start gap-2 text-sm text-gray-600 mb-1">
                                <MapPin className="w-4 h-4 mt-0.5 flex-shrink-0" />
                                <span>{shop.integrationDetails.protractor.address}</span>
                              </div>
                            )}
                            {shop.integrationDetails.protractor.phone && (
                              <div className="flex items-center gap-2 text-sm text-gray-600 mb-1">
                                <Phone className="w-4 h-4 flex-shrink-0" />
                                <span>{shop.integrationDetails.protractor.phone}</span>
                              </div>
                            )}
                            {shop.integrationDetails.protractor.timeZone && (
                              <div className="flex items-center gap-2 text-sm text-gray-600">
                                <Clock className="w-4 h-4 flex-shrink-0" />
                                <span>{shop.integrationDetails.protractor.timeZone}</span>
                              </div>
                            )}
                          </div>
                        )}
                        {shop.integrationDetails.carfax && (
                          <div className="bg-white rounded-lg p-4 border border-blue-200">
                            <div className="flex items-center gap-2 mb-3">
                              <span className="px-2 py-0.5 bg-red-100 text-red-700 text-xs rounded font-medium">CARFAX</span>
                            </div>
                            <div className="text-sm text-gray-600">
                              <span className="font-medium">Location ID:</span> {shop.integrationDetails.carfax.locationId}
                            </div>
                          </div>
                        )}
                        {shop.integrationDetails.tekmetric && (
                          <div className="bg-white rounded-lg p-4 border border-blue-200">
                            <div className="flex items-center gap-2 mb-3">
                              <span className="px-2 py-0.5 bg-green-100 text-green-700 text-xs rounded font-medium">Tekmetric</span>
                            </div>
                            <div className="text-sm text-gray-600">
                              <span className="font-medium">Shop ID:</span> {shop.integrationDetails.tekmetric.shopId}
                            </div>
                          </div>
                        )}
                      </div>
                    </td>
                  </tr>
                ) : null,
              ])
              ])
            ) : (
              filteredShops.flatMap((shop) => [
                <tr key={`${shop._id}-row-flat`} className="hover:bg-gray-50">
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-3">
                      <div className={`w-8 h-8 rounded-lg flex items-center justify-center ${shop.isLocked ? "bg-red-100" : shop.enterpriseId ? "bg-blue-100" : "bg-[rgba(60,129,195,0.15)]"}`}>
                        {shop.isLocked ? (
                          <Lock className="w-4 h-4 text-red-600" />
                        ) : (
                          <Building2 className={`w-4 h-4 ${shop.enterpriseId ? "text-blue-600" : "text-[#3c81c3]"}`} />
                        )}
                      </div>
                      <div>
                        <div className="flex items-center gap-2">
                          <span className={`font-medium ${shop.isLocked ? "text-red-700" : "text-gray-900"}`}>{shop.name}</span>
                          {shop.locationIdentifier && (
                            <span className="px-1.5 py-0.5 bg-blue-100 text-blue-700 text-xs rounded">{shop.locationIdentifier}</span>
                          )}
                          {shop.isLocked && (
                            <span className="px-1.5 py-0.5 bg-red-100 text-red-700 text-xs rounded">Locked</span>
                          )}
                          <span className={`px-1.5 py-0.5 text-xs rounded ${planColors[shop.billing.plan] || planColors.trial}`}>
                            {planLabels[shop.billing.plan] || shop.billing.plan}
                          </span>
                          {typeof shop.billing.stripeSubscriptionAmount === "number" && shop.billing.stripeSubscriptionAmount > 0 && (
                            <span className="text-xs text-gray-500" title={shop.billing.stripeProductName || undefined}>
                              ${(shop.billing.stripeSubscriptionAmount / 100).toFixed(2)}/mo
                            </span>
                          )}
                          {shop.trial?.endsAt && (
                            <TrialBadge trial={shop.trial} />
                          )}
                          {shop.cardOnFile ? (
                            <span className="px-1.5 py-0.5 bg-emerald-100 text-emerald-700 text-xs rounded inline-flex items-center gap-1" title="Payment method on file">
                              <CreditCard className="w-3 h-3" /> Card on file
                            </span>
                          ) : shop.trial?.endsAt ? (
                            <span className="px-1.5 py-0.5 bg-orange-100 text-orange-700 text-xs rounded inline-flex items-center gap-1" title="No payment method on file yet">
                              <CreditCard className="w-3 h-3" /> No card
                            </span>
                          ) : null}
                          {shop.trial?.endsAt && (
                            <button
                              onClick={() => { setExtendTrialShop(shop); setExtendTrialDays("14"); }}
                              className="px-1.5 py-0.5 text-xs bg-blue-50 text-blue-700 hover:bg-blue-100 rounded"
                              title="Extend trial"
                            >
                              Extend
                            </button>
                          )}
                        </div>
                        {shop.enterpriseName && (
                          <div className="text-xs text-gray-500">{shop.enterpriseName}</div>
                        )}
                      </div>
                    </div>
                  </td>
                  <td className="px-4 py-3 text-right text-gray-600">{shop.shopId}</td>
                  <td className="px-4 py-3 text-right text-gray-900">{shop.userCount}</td>
                  <td className="px-4 py-3 text-right text-gray-900">{shop.vehicleCount}</td>
                  <td className="px-4 py-3">
                    <div className="flex items-center justify-center gap-2">
                      <div className="text-center">
                        <div className={`text-sm font-medium ${shop.billing.vinViewCount >= shop.billing.vinLimit ? "text-red-600" : shop.billing.isPaid ? "text-green-600" : "text-gray-900"}`}>
                          {shop.billing.vinViewCount} / {shop.billing.vinLimit}
                          {shop.billing.isPaid && <span className="ml-1 text-green-500 text-xs">(Paid)</span>}
                        </div>
                        <div className="w-24 h-1.5 bg-gray-200 rounded-full overflow-hidden">
                          <div 
                            className={`h-full transition-all ${shop.billing.vinViewCount >= shop.billing.vinLimit ? "bg-red-500" : shop.billing.isPaid ? "bg-green-500" : "bg-[#3c81c3]"}`}
                            style={{ width: `${Math.min(100, (shop.billing.vinViewCount / shop.billing.vinLimit) * 100)}%` }}
                          />
                        </div>
                      </div>
                      <div className="flex gap-0.5">
                        <button
                          onClick={() => { setSelectedShop(shop); setModalAction("addViews"); setVinInput("10"); }}
                          title="Add VINs"
                          className="p-1 text-green-600 hover:bg-green-50 rounded"
                        >
                          <Plus className="w-4 h-4" />
                        </button>
                        <button
                          onClick={() => { setSelectedShop(shop); setModalAction("setLimit"); setVinInput(String(shop.billing.vinLimit)); }}
                          title="Set Custom Limit"
                          className="p-1 text-blue-600 hover:bg-blue-50 rounded"
                        >
                          <Settings className="w-4 h-4" />
                        </button>
                        <button
                          onClick={() => { setSelectedShop(shop); setModalAction("resetLimit"); }}
                          title="Reset to Default"
                          className="p-1 text-orange-600 hover:bg-orange-50 rounded"
                        >
                          <RotateCcw className="w-4 h-4" />
                        </button>
                      </div>
                    </div>
                  </td>
                  <td className="px-4 py-3 text-center">
                    <div className="text-sm">
                      <span className="font-medium text-gray-900">{shop.stickerCountThisMonth || 0}</span>
                      <span className="text-gray-400 text-xs ml-1">/ {shop.stickerCount || 0}</span>
                    </div>
                    <div className="text-xs text-gray-500">this month / total</div>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex flex-wrap items-center gap-1">
                      {shop.integrations.map(int => {
                        const iconMap: Record<string, string> = {
                          "Protractor": "/protractor-icon.png",
                          "Tekmetric": "/tekmetric-logo.png",
                          "CARFAX": "/icons/carfax.png",
                          "AutoFlow": "/icons/autoflow.png",
                          "Shop-Ware": "/logos/shopware.png",
                        };
                        const icon = iconMap[int];
                        return icon ? (
                          <img 
                            key={int}
                            src={icon}
                            alt={int}
                            title={int}
                            onClick={shop.integrationDetails ? () => setExpandedShop(expandedShop === shop._id ? null : shop._id) : undefined}
                            className={`w-6 h-6 rounded object-contain ${shop.integrationDetails ? "cursor-pointer hover:opacity-80" : ""}`}
                          />
                        ) : (
                          <span 
                            key={int} 
                            onClick={shop.integrationDetails ? () => setExpandedShop(expandedShop === shop._id ? null : shop._id) : undefined}
                            className={`px-2 py-0.5 text-xs rounded ${
                              int === "AutoVitals" ? "bg-orange-100 text-orange-700" :
                              "bg-gray-100 text-gray-700"
                            } ${shop.integrationDetails ? "cursor-pointer hover:opacity-80" : ""}`}
                          >
                            {int}
                          </span>
                        );
                      })}
                      {shop.integrations.length === 0 && (
                        <span className="text-gray-400 text-sm">None</span>
                      )}
                      {shop.integrationDetails && (
                        <button
                          onClick={() => setExpandedShop(expandedShop === shop._id ? null : shop._id)}
                          className="p-0.5 text-gray-400 hover:text-gray-600"
                        >
                          {expandedShop === shop._id ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                        </button>
                      )}
                    </div>
                  </td>
                  <td className="px-4 py-3 text-center">
                    {shop.backfill ? (
                      shop.backfill.status === "completed" ? (
                        <div className="flex items-center justify-center gap-1 text-green-600" title={`Completed: ${shop.backfill.totalJobsIndexed.toLocaleString()} jobs indexed (${shop.backfill.source || 'unknown'})`}>
                          <CheckCircle2 className="w-4 h-4" />
                          <span className="text-xs">{shop.backfill.totalJobsIndexed.toLocaleString()}</span>
                        </div>
                      ) : shop.backfill.status === "active" ? (
                        <div className="flex items-center justify-center gap-1 text-blue-600" title={`Active: ${shop.backfill.processedCount.toLocaleString()} WOs processed, ${shop.backfill.totalJobsIndexed.toLocaleString()} jobs indexed. Processing: ${shop.backfill.currentChunkDate ? new Date(shop.backfill.currentChunkDate).toLocaleDateString() : 'starting'}. Last activity: ${shop.backfill.lastActivityAt ? new Date(shop.backfill.lastActivityAt).toLocaleTimeString() : 'unknown'}`}>
                          <Loader2 className="w-4 h-4 animate-spin" />
                          <span className="text-xs">{shop.backfill.totalJobsIndexed.toLocaleString()}</span>
                        </div>
                      ) : shop.backfill.status === "stale" ? (
                        <div className="flex items-center justify-center gap-1 text-orange-600" title={`Stale (no activity in 5+ min): ${shop.backfill.processedCount.toLocaleString()} WOs processed, ${shop.backfill.totalJobsIndexed.toLocaleString()} jobs indexed. Last activity: ${shop.backfill.lastActivityAt ? new Date(shop.backfill.lastActivityAt).toLocaleString() : 'unknown'}`}>
                          <AlertCircle className="w-4 h-4" />
                          <span className="text-xs">{shop.backfill.totalJobsIndexed.toLocaleString()}</span>
                        </div>
                      ) : shop.backfill.status === "error" ? (
                        <div className="flex items-center justify-center gap-1 text-red-600" title={`Error: ${shop.backfill.lastError || 'Unknown error'}. Last run: ${shop.backfill.lastErrorAt ? new Date(shop.backfill.lastErrorAt).toLocaleString() : 'unknown'}`}>
                          <XCircle className="w-4 h-4" />
                          <span className="text-xs">{shop.backfill.totalJobsIndexed.toLocaleString()}</span>
                        </div>
                      ) : (
                        <div className="flex items-center justify-center gap-1 text-amber-600" title={`Pending: ${shop.backfill.processedCount.toLocaleString()} WOs processed, ${shop.backfill.totalJobsIndexed.toLocaleString()} jobs indexed. Last run: ${shop.backfill.lastAttemptedAt ? new Date(shop.backfill.lastAttemptedAt).toLocaleString() : 'never'}`}>
                          <Pause className="w-4 h-4" />
                          <span className="text-xs">{shop.backfill.totalJobsIndexed.toLocaleString()}</span>
                        </div>
                      )
                    ) : (
                      <span className="text-gray-300">—</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-gray-600 text-sm">
                    {new Date(shop.createdAt).toLocaleDateString()}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <div className="flex items-center justify-end gap-2">
                      <button
                        onClick={() => openFeatureModal(shop)}
                        disabled={actionLoading !== null}
                        title="Manage billing & features"
                        className="p-1.5 text-[#3c81c3] hover:bg-[rgba(60,129,195,0.1)] rounded-lg transition-colors disabled:opacity-50"
                      >
                        <Settings className="w-4 h-4" />
                      </button>
                      {shop.trial?.endsAt && (() => {
                        const lastEmail = shop.lastCardCaptureEmail || null;
                        const sentAgo = lastEmail ? formatTimeAgo(lastEmail.sentAt) : null;
                        const sentMs = lastEmail?.sentAt ? Date.now() - new Date(lastEmail.sentAt).getTime() : null;
                        const isRecent = sentMs !== null && sentMs < 24 * 60 * 60 * 1000;
                        const baseTitle = shop.cardOnFile
                          ? "Resend card-capture email (card already on file)"
                          : "Resend card-capture email to owner";
                        const historyTitle = buildCardCaptureHistoryTitle(shop.cardCaptureEmailHistory);
                        const lastLine = lastEmail
                          ? `Last sent ${sentAgo} to ${lastEmail.recipient || "unknown"} via ${describeCardCaptureSource(lastEmail)}`
                          : "No card-capture emails sent yet";
                        return (
                          <div className="flex items-center gap-1">
                            <button
                              onClick={() => resendCardCaptureEmail(shop)}
                              disabled={actionLoading !== null}
                              title={`${baseTitle}\n\n${lastLine}\n\n${historyTitle}`}
                              className={`relative p-1.5 rounded-lg transition-colors disabled:opacity-50 ${
                                shop.cardOnFile
                                  ? "text-gray-500 hover:bg-gray-50"
                                  : "text-amber-600 hover:bg-amber-50"
                              }`}
                            >
                              {actionLoading === `${shop.shopId}-resend-card` ? (
                                <Loader2 className="w-4 h-4 animate-spin" />
                              ) : (
                                <Mail className="w-4 h-4" />
                              )}
                              {isRecent && (
                                <span
                                  className="absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full bg-emerald-500 ring-2 ring-white"
                                  aria-hidden="true"
                                />
                              )}
                            </button>
                            {sentAgo && (
                              <span
                                className={`text-[11px] leading-tight ${isRecent ? "text-emerald-700" : "text-gray-500"} flex flex-col max-w-[140px]`}
                                title={`${lastLine}\n\n${historyTitle}`}
                              >
                                <span className="whitespace-nowrap">Sent {sentAgo}</span>
                                {lastEmail?.recipient && (
                                  <span className="truncate text-gray-500">
                                    to {lastEmail.recipient}
                                    {lastEmail.source === "admin" ? " · admin" : " · cron"}
                                  </span>
                                )}
                              </span>
                            )}
                          </div>
                        );
                      })()}
                      <button
                        onClick={() => toggleLock(shop.shopId, !!shop.isLocked)}
                        disabled={actionLoading !== null}
                        title={shop.isLocked ? "Unlock shop" : "Lock shop"}
                        className={`p-1.5 rounded-lg transition-colors disabled:opacity-50 ${
                          shop.isLocked 
                            ? "text-green-600 hover:bg-green-50" 
                            : "text-orange-600 hover:bg-orange-50"
                        }`}
                      >
                        {actionLoading === `${shop.shopId}-lock` || actionLoading === `${shop.shopId}-unlock` ? (
                          <Loader2 className="w-4 h-4 animate-spin" />
                        ) : shop.isLocked ? (
                          <Unlock className="w-4 h-4" />
                        ) : (
                          <Lock className="w-4 h-4" />
                        )}
                      </button>
                      <button
                        onClick={() => deleteShop(shop)}
                        disabled={actionLoading !== null}
                        title="Delete shop permanently"
                        className="p-1.5 text-red-600 hover:bg-red-50 rounded-lg transition-colors disabled:opacity-50"
                      >
                        {actionLoading === `${shop.shopId}-delete` ? (
                          <Loader2 className="w-4 h-4 animate-spin" />
                        ) : (
                          <Trash2 className="w-4 h-4" />
                        )}
                      </button>
                      <button
                        onClick={() => accessShop(shop.shopId)}
                        disabled={impersonating !== null || shop.isLocked}
                        title={shop.isLocked ? "Shop is locked" : "Access this shop"}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-[rgba(60,129,195,0.75)] text-white text-sm font-medium rounded-lg hover:bg-[#3c81c3] disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                      >
                        {impersonating === shop.shopId ? (
                          <Loader2 className="w-4 h-4 animate-spin" />
                        ) : (
                          <LogIn className="w-4 h-4" />
                        )}
                        Access
                      </button>
                    </div>
                  </td>
                </tr>,
              ])
            )}
          </tbody>
        </table>
      </div>

      <div className="text-sm text-gray-500">
        Showing {filteredShops.length} of {shops.length} shops | Default trial limit: {defaultVinLimit} VINs
      </div>

      {selectedShop && modalAction && modalAction !== "manageFeatures" && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={() => { setSelectedShop(null); setModalAction(null); }}>
          <div className="bg-white rounded-xl p-6 max-w-md w-full mx-4 shadow-xl" onClick={e => e.stopPropagation()}>
            <h3 className="text-lg font-semibold text-gray-900 mb-2">
              {modalAction === "addViews" ? "Add VINs" : modalAction === "resetLimit" ? "Reset to Default" : "Set VIN Limit"}
            </h3>
            <p className="text-sm text-gray-500 mb-4">
              {modalAction === "addViews" 
                ? `Add extra VINs to ${selectedShop.name}'s trial allowance`
                : modalAction === "resetLimit"
                ? `Reset ${selectedShop.name} to use the default trial limit (${defaultVinLimit} VINs)`
                : `Set a custom VIN limit for ${selectedShop.name}`
              }
            </p>
            {modalAction !== "resetLimit" && (
              <div className="mb-4">
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  {modalAction === "addViews" ? "VINs to add" : "New VIN limit"}
                </label>
                <input
                  type="number"
                  min="1"
                  value={vinInput}
                  onChange={(e) => setVinInput(e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-[#3c81c3] focus:border-transparent"
                />
                {modalAction === "setLimit" && (
                  <p className="text-xs text-gray-500 mt-1">
                    Current: {selectedShop.billing.vinViewCount} used of {selectedShop.billing.vinLimit} limit
                  </p>
                )}
                {modalAction === "addViews" && (
                  <p className="text-xs text-gray-500 mt-1">
                    Will increase limit from {selectedShop.billing.vinLimit} to {selectedShop.billing.vinLimit + (Number(vinInput) || 0)}
                  </p>
                )}
              </div>
            )}
            {modalAction === "resetLimit" && (
              <div className="mb-4 p-3 bg-orange-50 border border-orange-200 rounded-lg">
                <p className="text-sm text-orange-800">
                  This will remove any custom VIN limit and revert to the platform default of {defaultVinLimit} VINs.
                </p>
              </div>
            )}
            <div className="flex gap-3 justify-end">
              <button
                onClick={() => { setSelectedShop(null); setModalAction(null); }}
                className="px-4 py-2 text-gray-700 hover:bg-gray-100 rounded-lg"
              >
                Cancel
              </button>
              <button
                onClick={() => vinAction(selectedShop.shopId, modalAction, modalAction === "resetLimit" ? undefined : Number(vinInput))}
                disabled={(modalAction !== "resetLimit" && (!vinInput || Number(vinInput) < 1)) || actionLoading !== null}
                className="px-4 py-2 bg-[rgba(60,129,195,0.75)] text-white rounded-lg hover:bg-[#3c81c3] disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
              >
                {actionLoading && (
                  <Loader2 className="w-4 h-4 animate-spin" />
                )}
                {modalAction === "addViews" ? "Add VINs" : modalAction === "resetLimit" ? "Reset to Default" : "Set Limit"}
              </button>
            </div>
          </div>
        </div>
      )}

      {selectedShop && modalAction === "manageFeatures" && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={() => { setSelectedShop(null); setModalAction(null); }}>
          <div className="bg-white rounded-xl p-6 max-w-lg w-full mx-4 shadow-xl max-h-[90vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
            <h3 className="text-lg font-semibold text-gray-900 mb-1">Manage Shop Settings</h3>
            <p className="text-sm text-gray-500 mb-4">{selectedShop.name} (ID: {selectedShop.shopId})</p>
            
            <div className="space-y-6">
              <div>
                <h4 className="text-sm font-medium text-gray-900 mb-3">Billing Plan</h4>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs text-gray-500 mb-1">Plan</label>
                    <select
                      value={billingEdits.plan}
                      onChange={(e) => {
                        const newPlan = e.target.value;
                        setBillingEdits({ ...billingEdits, plan: newPlan });
                        if (newPlan === "demo") {
                          setVinInput("999999");
                          setFeatureEdits({
                            maintenance: true,
                            job_lookup: true,
                            common_failures: true,
                            oil_sticker: true,
                            keytags: true,
                            auto_booking: true,
                            part_xref: true,
                            labor_rates: true,
                          });
                        }
                      }}
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-[#3c81c3] text-sm"
                    >
                      <option value="trial">Trial</option>
                      <option value="starter">Starter</option>
                      <option value="professional">Professional</option>
                      <option value="enterprise">Enterprise</option>
                      <option value="detect_dog_founder">Detect Dog - Founder</option>
                      <option value="demo">Demo</option>
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs text-gray-500 mb-1">Status</label>
                    <select
                      value={billingEdits.status}
                      onChange={(e) => setBillingEdits({ ...billingEdits, status: e.target.value })}
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-[#3c81c3] text-sm"
                    >
                      <option value="trial">Trial</option>
                      <option value="active">Active</option>
                      <option value="past_due">Past Due</option>
                      <option value="canceled">Canceled</option>
                      <option value="demo">Demo</option>
                    </select>
                  </div>
                </div>
                <div className="mt-3">
                  <label className="block text-xs text-gray-500 mb-1">VIN Limit</label>
                  <input
                    type="number"
                    min="1"
                    value={vinInput}
                    onChange={(e) => setVinInput(e.target.value)}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-[#3c81c3] text-sm"
                  />
                </div>
              </div>

              <div>
                <h4 className="text-sm font-medium text-gray-900 mb-3">Feature Toggles</h4>
                <p className="text-xs text-gray-500 mb-3">Override plan defaults. Leave unchecked to use plan defaults.</p>
                <div className="space-y-2">
                  {[
                    { key: "maintenance", label: "Maintenance Tracking", desc: "Track vehicle maintenance schedules and DVI insights" },
                    { key: "job_lookup", label: "Job Lookup", desc: "Search historical jobs with smart autocomplete" },
                    { key: "common_failures", label: "Common Failures Advisor", desc: "Predict common repairs by vehicle/mileage" },
                    { key: "oil_sticker", label: "Oil Sticker", desc: "Generate oil change reminder stickers" },
                    { key: "keytags", label: "Keytags", desc: "Print customer/vehicle info on Dymo labels" },
                    { key: "auto_booking", label: "Auto Booking", desc: "Automated appointment booking for oil changes" },
                    { key: "part_xref", label: "Part Cross-Reference", desc: "Cross-reference parts across manufacturers" },
                    { key: "labor_rates", label: "Labor Rate Rules", desc: "Auto-apply labor rates based on vehicle, customer, and job criteria" },
                    { key: "concern_assistant", label: "Concern Assistant", desc: "AI-powered customer concern intake with follow-up questions and RO injection" },
                    { key: "dvi_prefill", label: "DVI Pre-fill (VHI)", desc: "Auto-fill DVI inspection ratings using VHI maintenance data" },
                    { key: "enhance_notes", label: "Enhance Notes (AI)", desc: "AI-powered rewriting of technician notes into customer-facing language" },
                  ].map(feature => (
                    <label key={feature.key} className="flex items-start gap-3 p-3 border border-gray-200 rounded-lg hover:bg-gray-50 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={featureEdits[feature.key as keyof ShopFeatures] === true}
                        onChange={(e) => setFeatureEdits({ ...featureEdits, [feature.key]: e.target.checked })}
                        className="mt-0.5 w-4 h-4 text-[#3c81c3] border-gray-300 rounded focus:ring-[#3c81c3]"
                      />
                      <div>
                        <div className="font-medium text-gray-900 text-sm">{feature.label}</div>
                        <div className="text-xs text-gray-500">{feature.desc}</div>
                      </div>
                    </label>
                  ))}
                </div>
              </div>
            </div>

            <div className="flex gap-3 justify-end mt-6 pt-4 border-t border-gray-200">
              <button
                onClick={() => { setSelectedShop(null); setModalAction(null); }}
                className="px-4 py-2 text-gray-700 hover:bg-gray-100 rounded-lg"
              >
                Cancel
              </button>
              <button
                onClick={() => updateShopSettings(
                  selectedShop.shopId, 
                  { ...billingEdits, vinLimit: Number(vinInput) } as any, 
                  featureEdits
                )}
                disabled={actionLoading !== null}
                className="px-4 py-2 bg-[rgba(60,129,195,0.75)] text-white rounded-lg hover:bg-[#3c81c3] disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
              >
                {actionLoading && <Loader2 className="w-4 h-4 animate-spin" />}
                Save Changes
              </button>
            </div>
          </div>
        </div>
      )}

      {showCreateShop && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={() => setShowCreateShop(false)}>
          <div className="bg-white rounded-xl p-6 max-w-lg w-full mx-4 shadow-xl max-h-[90vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-semibold text-gray-900">Create New Shop</h3>
              <button onClick={() => setShowCreateShop(false)} className="p-1 text-gray-400 hover:text-gray-600 rounded">
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="space-y-4">
              <div>
                <label className="block text-xs text-gray-500 mb-1">Shop Name *</label>
                <input
                  type="text"
                  value={createShopData.shopName}
                  onChange={(e) => setCreateShopData({ ...createShopData, shopName: e.target.value })}
                  placeholder="e.g. Joe's Auto Care"
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-[#3c81c3] text-sm"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs text-gray-500 mb-1">Owner Name</label>
                  <input
                    type="text"
                    value={createShopData.ownerName}
                    onChange={(e) => setCreateShopData({ ...createShopData, ownerName: e.target.value })}
                    placeholder="John Doe"
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-[#3c81c3] text-sm"
                  />
                </div>
                <div>
                  <label className="block text-xs text-gray-500 mb-1">Owner Email *</label>
                  <input
                    type="email"
                    value={createShopData.ownerEmail}
                    onChange={(e) => setCreateShopData({ ...createShopData, ownerEmail: e.target.value })}
                    placeholder="owner@shop.com"
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-[#3c81c3] text-sm"
                  />
                </div>
              </div>

              <div>
                <label className="block text-xs text-gray-500 mb-1">Password *</label>
                <input
                  type="text"
                  value={createShopData.ownerPassword}
                  onChange={(e) => setCreateShopData({ ...createShopData, ownerPassword: e.target.value })}
                  placeholder="Temporary password for the owner"
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-[#3c81c3] text-sm"
                />
              </div>

              <div className="grid grid-cols-3 gap-3">
                <div>
                  <label className="block text-xs text-gray-500 mb-1">Plan</label>
                  <select
                    value={createShopData.plan}
                    onChange={(e) => {
                      const plan = e.target.value;
                      const newData = { ...createShopData, plan };
                      if (plan === "enterprise" || plan === "demo") {
                        newData.status = plan === "demo" ? "demo" : "active";
                        newData.vinLimit = "999999";
                        newData.features = {
                          maintenance: true, job_lookup: true, common_failures: true,
                          oil_sticker: true, keytags: true, auto_booking: true,
                          part_xref: true, labor_rates: true,
                        };
                      }
                      setCreateShopData(newData);
                    }}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-[#3c81c3] text-sm"
                  >
                    <option value="trial">Trial</option>
                    <option value="starter">Starter</option>
                    <option value="professional">Professional</option>
                    <option value="enterprise">Enterprise</option>
                    <option value="detect_dog_founder">Detect Dog - Founder</option>
                    <option value="demo">Demo</option>
                  </select>
                </div>
                <div>
                  <label className="block text-xs text-gray-500 mb-1">Status</label>
                  <select
                    value={createShopData.status}
                    onChange={(e) => setCreateShopData({ ...createShopData, status: e.target.value })}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-[#3c81c3] text-sm"
                  >
                    <option value="trial">Trial</option>
                    <option value="active">Active</option>
                    <option value="demo">Demo</option>
                  </select>
                </div>
                <div>
                  <label className="block text-xs text-gray-500 mb-1">VIN Limit</label>
                  <input
                    type="number"
                    min="1"
                    value={createShopData.vinLimit}
                    onChange={(e) => setCreateShopData({ ...createShopData, vinLimit: e.target.value })}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-[#3c81c3] text-sm"
                  />
                </div>
              </div>

              {createShopData.status === "trial" && (
                <div>
                  <label className="block text-xs text-gray-500 mb-1">Trial Length (days)</label>
                  <input
                    type="number"
                    min="1"
                    max="365"
                    value={createShopData.trialDays}
                    onChange={(e) => setCreateShopData({ ...createShopData, trialDays: e.target.value })}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-[#3c81c3] text-sm"
                    placeholder={String(defaultTrialDays)}
                  />
                  <p className="text-xs text-gray-500 mt-1">
                    Default is {defaultTrialDays} days. The owner will be prompted to add a payment method on first login. Their card will not be charged until the trial ends.
                  </p>
                </div>
              )}

              <div>
                <h4 className="text-sm font-medium text-gray-900 mb-2">Feature Toggles</h4>
                <div className="space-y-1.5">
                  {[
                    { key: "maintenance", label: "Maintenance Tracking" },
                    { key: "job_lookup", label: "Job Lookup" },
                    { key: "common_failures", label: "Common Failures Advisor" },
                    { key: "oil_sticker", label: "Oil Sticker" },
                    { key: "keytags", label: "Keytags" },
                    { key: "auto_booking", label: "Auto Booking" },
                    { key: "part_xref", label: "Part Cross-Reference" },
                    { key: "labor_rates", label: "Labor Rate Rules" },
                    { key: "concern_assistant", label: "Concern Assistant" },
                    { key: "dvi_prefill", label: "DVI Pre-fill (VHI)" },
                    { key: "enhance_notes", label: "Enhance Notes (AI)" },
                  ].map(feature => (
                    <label key={feature.key} className="flex items-center gap-2 p-2 border border-gray-200 rounded-lg hover:bg-gray-50 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={createShopData.features[feature.key as keyof ShopFeatures] === true}
                        onChange={(e) => setCreateShopData({
                          ...createShopData,
                          features: { ...createShopData.features, [feature.key]: e.target.checked },
                        })}
                        className="w-4 h-4 text-[#3c81c3] border-gray-300 rounded focus:ring-[#3c81c3]"
                      />
                      <span className="text-sm text-gray-700">{feature.label}</span>
                    </label>
                  ))}
                </div>
              </div>
            </div>

            <div className="flex justify-end gap-3 mt-6 pt-4 border-t">
              <button
                onClick={() => setShowCreateShop(false)}
                className="px-4 py-2 text-gray-700 hover:bg-gray-100 rounded-lg"
              >
                Cancel
              </button>
              <button
                onClick={createShop}
                disabled={createLoading || !createShopData.shopName || !createShopData.ownerEmail || !createShopData.ownerPassword}
                className="px-4 py-2 bg-[#3c81c3] text-white rounded-lg hover:bg-[#2d6da8] disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
              >
                {createLoading && <Loader2 className="w-4 h-4 animate-spin" />}
                Create Shop
              </button>
            </div>
          </div>
        </div>
      )}

      {extendTrialShop && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-xl p-6 w-full max-w-md">
            <div className="flex items-start justify-between mb-4">
              <div>
                <h3 className="text-lg font-semibold text-gray-900">Extend Trial</h3>
                <p className="text-sm text-gray-500 mt-1">{extendTrialShop.name}</p>
              </div>
              <button onClick={() => setExtendTrialShop(null)} className="text-gray-400 hover:text-gray-600">
                <X className="w-5 h-5" />
              </button>
            </div>
            {extendTrialShop.trial?.endsAt && (
              <p className="text-sm text-gray-600 mb-3">
                Current trial ends:{" "}
                <b>{new Date(extendTrialShop.trial.endsAt).toLocaleDateString()}</b>
                {typeof extendTrialShop.trial.daysLeft === "number" && (
                  <span className="text-gray-500"> ({extendTrialShop.trial.daysLeft} days left)</span>
                )}
              </p>
            )}
            <div className="flex gap-2 mb-3">
              <button
                type="button"
                onClick={() => setExtendTrialMode("days")}
                className={`px-3 py-1.5 text-xs rounded border ${extendTrialMode === "days" ? "bg-[#3c81c3] text-white border-[#3c81c3]" : "bg-white text-gray-700 border-gray-300 hover:bg-gray-50"}`}
              >
                Add days
              </button>
              <button
                type="button"
                onClick={() => setExtendTrialMode("date")}
                className={`px-3 py-1.5 text-xs rounded border ${extendTrialMode === "date" ? "bg-[#3c81c3] text-white border-[#3c81c3]" : "bg-white text-gray-700 border-gray-300 hover:bg-gray-50"}`}
              >
                Set / reset end date
              </button>
            </div>
            {extendTrialMode === "days" ? (
              <>
                <label className="block text-xs text-gray-500 mb-1">Add days to trial</label>
                <input
                  type="number"
                  min="1"
                  max="365"
                  value={extendTrialDays}
                  onChange={(e) => setExtendTrialDays(e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-[#3c81c3] text-sm"
                />
              </>
            ) : (
              <>
                <label className="block text-xs text-gray-500 mb-1">New trial end date</label>
                <input
                  type="date"
                  value={extendTrialDate}
                  onChange={(e) => setExtendTrialDate(e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-[#3c81c3] text-sm"
                />
                <p className="text-xs text-gray-500 mt-1">Replaces the current trial end date. Suspended shops will be reactivated.</p>
              </>
            )}
            <div className="flex justify-end gap-3 mt-6 pt-4 border-t">
              <button
                onClick={() => setExtendTrialShop(null)}
                className="px-4 py-2 text-gray-700 hover:bg-gray-100 rounded-lg"
              >
                Cancel
              </button>
              <button
                onClick={extendTrial}
                disabled={actionLoading === `${extendTrialShop.shopId}-extend`}
                className="px-4 py-2 bg-[#3c81c3] text-white rounded-lg hover:bg-[#2d6da8] disabled:opacity-50 flex items-center gap-2"
              >
                {actionLoading === `${extendTrialShop.shopId}-extend` && <Loader2 className="w-4 h-4 animate-spin" />}
                {extendTrialMode === "date" ? "Update End Date" : "Extend Trial"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function TrialBadge({ trial }: { trial: ShopTrial }) {
  if (!trial.endsAt) return null;
  const daysLeft = trial.daysLeft ?? 0;
  const expired = daysLeft <= 0;
  const urgent = !expired && daysLeft <= 3;
  const cls = expired
    ? "bg-red-100 text-red-700"
    : urgent
    ? "bg-amber-100 text-amber-800"
    : "bg-yellow-50 text-yellow-800";
  const label = expired
    ? "Trial ended"
    : `${daysLeft}d left`;
  const tip = `Trial ends ${new Date(trial.endsAt).toLocaleDateString()}${trial.days ? ` (${trial.days}-day trial)` : ""}`;
  return (
    <span className={`px-1.5 py-0.5 text-xs rounded ${cls}`} title={tip}>
      {label}
    </span>
  );
}
