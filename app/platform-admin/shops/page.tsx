"use client";

import { useState, useEffect, useRef } from "react";
import {
  Building2, Search, RefreshCw, LogIn, Loader2, RotateCcw, Plus, Settings, X,
  Lock, Unlock, Trash2, ChevronDown, ChevronUp, MapPin, Phone, Clock,
  CheckCircle2, Clock4, Play, AlertTriangle, Pause, AlertCircle, XCircle,
  Mail, CreditCard, ShieldCheck, ShieldAlert, Flag,
  MoreHorizontal, Users, Car, TrendingUp, Sparkles,
} from "lucide-react";
import { REVIEW_REASON_LABELS, type ShopReviewStatus } from "@/lib/shop-review";

interface ShopBilling {
  plan: string;
  isPaid: boolean;
  vinLimit: number;
  vinViewCount: number;
  status?: string;
  stripeSubscriptionAmount?: number | null;
  stripeProductName?: string | null;
  stripeCustomerId?: string | null;
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
  carfax?: { locationId: string } | null;
  tekmetric?: { shopId: string | number } | null;
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
  reviewStatus?: ShopReviewStatus | null;
  reviewedAt?: string | null;
  reviewedBy?: string | null;
  reviewNotes?: string | null;
  autoFlagReasons?: string[] | null;
}

function ReviewBadges({ shop }: { shop: Shop }) {
  const status = (shop.reviewStatus || "approved") as ShopReviewStatus;
  if (status === "approved") return null;
  const reasons = Array.isArray(shop.autoFlagReasons) ? shop.autoFlagReasons : [];
  const reasonText = reasons.length
    ? reasons.map((r) => REVIEW_REASON_LABELS[r] ?? r).join("\n• ")
    : null;
  const notesLine = shop.reviewNotes ? `\n\nNotes: ${shop.reviewNotes}` : "";
  const tip =
    (status === "flagged"
      ? "Flagged — transactional email is suppressed."
      : "Pending platform-admin review — transactional email is suppressed.") +
    (reasonText ? `\n\nAuto-flag reasons:\n• ${reasonText}` : "") +
    notesLine;
  return status === "flagged" ? (
    <span
      className="px-1.5 py-0.5 bg-red-100 text-red-700 text-xs rounded inline-flex items-center gap-1"
      title={tip}
    >
      <ShieldAlert className="w-3 h-3" /> Flagged
      {reasons.length > 0 && <span className="opacity-70">({reasons.length})</span>}
    </span>
  ) : (
    <span
      className="px-1.5 py-0.5 bg-amber-100 text-amber-800 text-xs rounded inline-flex items-center gap-1"
      title={tip}
    >
      <Clock4 className="w-3 h-3" /> Pending review
      {reasons.length > 0 && <span className="opacity-70">({reasons.length})</span>}
    </span>
  );
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
  if (!history || history.length === 0) return "No card-capture emails sent yet";
  const lines = history.map((e) => {
    const when = e.sentAt ? new Date(e.sentAt).toLocaleString() : "unknown time";
    const who = e.recipient || "unknown recipient";
    return `• ${when} — ${who} — ${describeCardCaptureSource(e)}`;
  });
  return `Card-capture email history (most recent first):\n${lines.join("\n")}`;
}

const isActiveOrTrial = (shop: Shop): boolean => {
  if (shop.isLocked) return false;
  const status = shop.billing.status;
  return status === "active" || status === "trial";
};

const isDetectDogFounderActive = (shop: Shop): boolean =>
  shop.billing.plan === "detect_dog_founder" && shop.billing.status === "active";

type KpiFilter = "none" | "activeOrTrial" | "detectDogFounder";

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
  const [openMenuShopId, setOpenMenuShopId] = useState<string | null>(null);
  const [featureEdits, setFeatureEdits] = useState<ShopFeatures>({});
  const [billingEdits, setBillingEdits] = useState<{ plan: string; status: string }>({ plan: "trial", status: "trial" });
  const [trialResetDays, setTrialResetDays] = useState<string>("14");
  const [groupByEnterprise, setGroupByEnterprise] = useState(false);
  type TrialFilter = "all" | "trial_active" | "ending_7" | "ending_3" | "expired" | "no_card";
  type SortBy = "createdAt" | "trialEndsAt";
  const TRIAL_FILTERS: readonly TrialFilter[] = ["all", "trial_active", "ending_7", "ending_3", "expired", "no_card"];
  const SORT_OPTIONS: readonly SortBy[] = ["createdAt", "trialEndsAt"];
  const isTrialFilter = (v: string): v is TrialFilter => (TRIAL_FILTERS as readonly string[]).includes(v);
  const isSortBy = (v: string): v is SortBy => (SORT_OPTIONS as readonly string[]).includes(v);
  const [trialFilter, setTrialFilter] = useState<TrialFilter>("all");
  const [sortBy, setSortBy] = useState<SortBy>("createdAt");
  type ReviewFilter = "all" | "pending" | "flagged" | "approved" | "needs_review";
  const REVIEW_FILTERS: readonly ReviewFilter[] = ["all", "needs_review", "pending", "flagged", "approved"];
  const isReviewFilter = (v: string): v is ReviewFilter =>
    (REVIEW_FILTERS as readonly string[]).includes(v);
  const [reviewFilter, setReviewFilter] = useState<ReviewFilter>("all");
  const [reviewDialog, setReviewDialog] = useState<{ shop: Shop; mode: "approve" | "flag" } | null>(
    null,
  );
  const [reviewNotesInput, setReviewNotesInput] = useState("");
  const [reviewSubmitting, setReviewSubmitting] = useState(false);
  const [bulkApproveConfirmOpen, setBulkApproveConfirmOpen] = useState(false);
  const [bulkApproveSubmitting, setBulkApproveSubmitting] = useState(false);
  const [kpiFilter, setKpiFilter] = useState<KpiFilter>("none");
  const [bulkConfirmOpen, setBulkConfirmOpen] = useState(false);
  const [bulkSending, setBulkSending] = useState(false);
  type BulkResult = {
    shopId: number | string;
    shopName?: string;
    ownerEmail?: string;
    ok: boolean;
    mode?: "reminder" | "suspended";
    error?: string;
  };
  const [bulkResults, setBulkResults] = useState<{
    requestedCount: number;
    succeeded: number;
    failed: number;
    results: BulkResult[];
  } | null>(null);
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
      maintenance: true, job_lookup: false, common_failures: false, oil_sticker: false,
      keytags: false, auto_booking: false, part_xref: false, labor_rates: false,
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

  const sendBulkCardCapture = async (shopIds: (number | string)[]) => {
    setBulkSending(true);
    try {
      const res = await fetch("/api/platform-admin/shops/bulk-card-capture", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ shopIds }),
      });
      const data = await res.json();
      if (data.ok) {
        setBulkResults({
          requestedCount: data.requestedCount,
          succeeded: data.succeeded,
          failed: data.failed,
          results: data.results || [],
        });
        setBulkConfirmOpen(false);
        loadShops();
      } else {
        alert(data.error || "Bulk send failed");
      }
    } catch (err) {
      console.error("Bulk card-capture error:", err);
      alert("Bulk send failed");
    } finally {
      setBulkSending(false);
    }
  };

  const submitReviewDecision = async (
    shop: Shop,
    decision: "approve" | "flag",
    notes: string,
  ) => {
    const trimmed = notes.trim();
    if (decision === "flag" && !trimmed) {
      alert("Please add a note explaining why this shop is flagged.");
      return;
    }
    setReviewSubmitting(true);
    setActionLoading(`${shop.shopId}-review-${decision}`);
    try {
      const res = await fetch(
        `/api/platform-admin/shops/${shop.shopId}/review`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ decision, notes: trimmed || undefined }),
        },
      );
      const data = await res.json();
      if (!res.ok || !data.ok) {
        alert(data.error || "Failed to update review status");
        return;
      }
      setReviewDialog(null);
      setReviewNotesInput("");
      await loadShops();
    } catch (err) {
      console.error("Review decision error:", err);
      alert("Failed to update review status");
    } finally {
      setReviewSubmitting(false);
      setActionLoading(null);
    }
  };

  const submitBulkApprove = async (shopIds: (number | string)[]) => {
    if (shopIds.length === 0) return;
    setBulkApproveSubmitting(true);
    try {
      const res = await fetch("/api/platform-admin/shops/bulk-approve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ shopIds }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        alert(data.error || "Bulk approve failed");
        return;
      }
      setBulkApproveConfirmOpen(false);
      const errCount = data.errorCount || 0;
      alert(
        `Approved ${data.approvedCount} shop${data.approvedCount === 1 ? "" : "s"}.` +
          (errCount > 0 ? ` ${errCount} error${errCount === 1 ? "" : "s"} — see console.` : ""),
      );
      if (errCount > 0) console.warn("[Bulk approve errors]", data.errors);
      await loadShops();
    } catch (err) {
      console.error("Bulk approve error:", err);
      alert("Bulk approve failed");
    } finally {
      setBulkApproveSubmitting(false);
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

  const openFeatureModal = (shop: Shop) => {
    setSelectedShop(shop);
    let features: ShopFeatures = {};
    if (Array.isArray(shop.enabledFeatures)) {
      shop.enabledFeatures.forEach((f: string) => {
        features[f as keyof ShopFeatures] = true;
      });
    } else if (shop.enabledFeatures && typeof shop.enabledFeatures === 'object') {
      features = shop.enabledFeatures;
    }
    setFeatureEdits(features);
    setBillingEdits({
      plan: shop.billing.plan || "trial",
      status: shop.billing.status || "trial",
    });
    setVinInput(String(shop.billing.vinLimit || 10));
    setTrialResetDays(String(defaultTrialDays || 14));
    setModalAction("manageFeatures");
  };

  const resetTrialFromModal = async () => {
    if (!selectedShop) return;
    const days = Number(trialResetDays);
    if (!Number.isFinite(days) || days < 1 || days > 365) {
      alert("Trial days must be between 1 and 365");
      return;
    }
    if (!confirm(`Reset trial for "${selectedShop.name}" to ${days} days starting now? This clears any prior trial reminder/suspension state.`)) return;
    setActionLoading(`${selectedShop.shopId}-reset-trial`);
    try {
      const res = await fetch(`/api/platform-admin/shops/${selectedShop.shopId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ trial: { setDays: days } }),
      });
      const data = await res.json();
      if (data.ok) {
        alert(data.message || "Trial reset");
        loadShops();
        setSelectedShop(null);
        setModalAction(null);
      } else {
        alert(data.error || "Failed to reset trial");
      }
    } catch (err) {
      console.error("Reset trial error:", err);
      alert("Failed to reset trial");
    } finally {
      setActionLoading(null);
    }
  };

  const createStripeCustomerFromModal = async () => {
    if (!selectedShop) return;
    setActionLoading(`${selectedShop.shopId}-stripe-customer`);
    try {
      const res = await fetch(`/api/platform-admin/shops/${selectedShop.shopId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "create_stripe_customer" }),
      });
      const data = await res.json();
      if (data.ok) {
        alert(data.message || "Stripe customer ready");
        loadShops();
      } else {
        alert(data.error || "Failed to create Stripe customer");
      }
    } catch (err) {
      console.error("Create Stripe customer error:", err);
      alert("Failed to create Stripe customer");
    } finally {
      setActionLoading(null);
    }
  };

  const resendCardCaptureFromModal = async () => {
    if (!selectedShop) return;
    if (!confirm(`Resend the card-capture email to the owner of "${selectedShop.name}"?`)) return;
    setActionLoading(`${selectedShop.shopId}-resend-card-modal`);
    try {
      const res = await fetch(`/api/platform-admin/shops/${selectedShop.shopId}`, {
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
      console.error("Resend card-capture (modal) error:", err);
      alert("Failed to send email");
    } finally {
      setActionLoading(null);
    }
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

  useEffect(() => {
    setCreateShopData((prev) =>
      prev.trialDays === String(defaultTrialDays) ? prev : { ...prev, trialDays: String(defaultTrialDays) },
    );
  }, [defaultTrialDays]);

  // KPI numbers
  const activeOrTrialShops = shops.filter(isActiveOrTrial);
  const activeCount = activeOrTrialShops.filter((s) => s.billing.status === "active").length;
  const trialingCount = activeOrTrialShops.filter((s) => s.billing.status === "trial").length;
  const detectDogFounderShops = shops.filter(isDetectDogFounderActive);

  const searchLower = search.toLowerCase();
  const now = Date.now();
  const filteredShops = shops
    .filter((shop) => {
      if (kpiFilter === "activeOrTrial") return isActiveOrTrial(shop);
      if (kpiFilter === "detectDogFounder") return isDetectDogFounderActive(shop);
      return true;
    })
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
    .filter(shop => {
      if (reviewFilter === "all") return true;
      const status = (shop.reviewStatus || "approved") as ShopReviewStatus;
      if (reviewFilter === "needs_review") return status === "pending" || status === "flagged";
      return status === reviewFilter;
    })
    .sort((a, b) => {
      if (sortBy === "trialEndsAt") {
        const aEnds = a.trial?.endsAt ? new Date(a.trial.endsAt).getTime() : Number.POSITIVE_INFINITY;
        const bEnds = b.trial?.endsAt ? new Date(b.trial.endsAt).getTime() : Number.POSITIVE_INFINITY;
        if (aEnds !== bEnds) return aEnds - bEnds;
      }
      return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
    });

  const bulkEligibleShops = filteredShops.filter(
    (s) => !!s.trial?.endsAt && !s.cardOnFile,
  );

  // Shops eligible for bulk-approve: every shop in the current filtered view
  // that is currently pending review (not flagged — those need a manual
  // decision since the admin already chose to flag them).
  const bulkApprovePendingShops = filteredShops.filter(
    (s) => (s.reviewStatus || "approved") === "pending",
  );

  const groupedShops = groupByEnterprise
    ? (() => {
        const enterpriseMap = new Map<string | null, Shop[]>();
        filteredShops.forEach(shop => {
          const key = shop.enterpriseId || null;
          if (!enterpriseMap.has(key)) enterpriseMap.set(key, []);
          enterpriseMap.get(key)!.push(shop);
        });
        const enterpriseKeys = Array.from(enterpriseMap.keys()).sort((a, b) => {
          if (a === null) return 1;
          if (b === null) return -1;
          const nameA = enterpriseMap.get(a)?.[0]?.enterpriseName || '';
          const nameB = enterpriseMap.get(b)?.[0]?.enterpriseName || '';
          return nameA.localeCompare(nameB);
        });
        const groups: { enterprise: string | null; shops: Shop[] }[] = [];
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
          <div className="h-24 bg-gray-200 rounded-xl"></div>
          <div className="h-64 bg-gray-200 rounded-lg"></div>
        </div>
      </div>
    );
  }

  const toggleKpi = (next: KpiFilter) => {
    setKpiFilter((current) => (current === next ? "none" : next));
  };

  const rowProps = {
    actionLoading,
    impersonating,
    expandedShop,
    setExpandedShop,
    openMenuShopId,
    setOpenMenuShopId,
    accessShop,
    openFeatureModal,
    toggleLock,
    deleteShop,
    resendCardCaptureEmail,
    triggerApproveReview: (shop: Shop) => {
      setReviewNotesInput("");
      setReviewDialog({ shop, mode: "approve" });
    },
    triggerFlagReview: (shop: Shop) => {
      setReviewNotesInput(shop.reviewNotes || "");
      setReviewDialog({ shop, mode: "flag" });
    },
    triggerExtendTrial: (shop: Shop) => { setExtendTrialShop(shop); setExtendTrialDays("14"); },
    triggerVinModal: (shop: Shop, action: "addViews" | "setLimit" | "resetLimit") => {
      setSelectedShop(shop);
      setModalAction(action);
      if (action === "addViews") setVinInput("10");
      else if (action === "setLimit") setVinInput(String(shop.billing.vinLimit));
    },
    triggerResetViews: (shop: Shop) => {
      if (confirm(`Reset all viewed VINs for ${shop.name}? This will start their trial fresh.`)) {
        vinAction(shop.shopId, "resetViews");
      }
    },
  };

  const colSpan = 6;

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

      {/* KPI strip */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <KpiCard
          icon={<TrendingUp className="w-5 h-5 text-green-600" />}
          iconBg="bg-green-100"
          label="Total Shops Active/Trial"
          value={activeOrTrialShops.length}
          subtitle={`${activeCount} active · ${trialingCount} in trial`}
          active={kpiFilter === "activeOrTrial"}
          onClick={() => toggleKpi("activeOrTrial")}
        />
        <KpiCard
          icon={<Sparkles className="w-5 h-5 text-amber-600" />}
          iconBg="bg-amber-100"
          label="Detect Dog Founder Active Subscriptions"
          value={detectDogFounderShops.length}
          subtitle={detectDogFounderShops.length === 1 ? "1 paid founder shop" : `${detectDogFounderShops.length} paid founder shops`}
          active={kpiFilter === "detectDogFounder"}
          onClick={() => toggleKpi("detectDogFounder")}
        />
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
          <label className="text-xs text-gray-500 whitespace-nowrap">Review</label>
          <select
            value={reviewFilter}
            onChange={(e) => {
              const v = e.target.value;
              if (isReviewFilter(v)) setReviewFilter(v);
            }}
            className="px-3 py-2 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-[#3c81c3]"
          >
            <option value="all">All review states</option>
            <option value="needs_review">Needs review (pending + flagged)</option>
            <option value="pending">Pending review</option>
            <option value="flagged">Flagged</option>
            <option value="approved">Approved</option>
          </select>
        </div>
        {bulkApprovePendingShops.length > 0 && (
          <button
            onClick={() => setBulkApproveConfirmOpen(true)}
            disabled={bulkApproveSubmitting}
            title="Approve every pending shop in the current filtered view (re-enables transactional email)"
            className="flex items-center gap-2 px-3 py-2 text-sm bg-emerald-100 text-emerald-800 hover:bg-emerald-200 rounded-lg disabled:opacity-50"
          >
            {bulkApproveSubmitting ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <ShieldCheck className="w-4 h-4" />
            )}
            Approve {bulkApprovePendingShops.length} pending
          </button>
        )}
        {bulkEligibleShops.length > 0 && (
          <button
            onClick={() => setBulkConfirmOpen(true)}
            disabled={bulkSending}
            title="Resend the card-capture email to every filtered trial shop without a card on file"
            className="flex items-center gap-2 px-3 py-2 text-sm bg-amber-100 text-amber-800 hover:bg-amber-200 rounded-lg disabled:opacity-50"
          >
            {bulkSending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Mail className="w-4 h-4" />}
            Resend card-capture to {bulkEligibleShops.length} shop{bulkEligibleShops.length === 1 ? "" : "s"}
          </button>
        )}
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
              <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Shop</th>
              <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Usage</th>
              <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Integrations</th>
              <th className="text-center px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Backfill</th>
              <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Created</th>
              <th className="text-right px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {filteredShops.length === 0 ? (
              <tr>
                <td colSpan={colSpan} className="px-4 py-8 text-center text-gray-500">
                  {search || kpiFilter !== "none" || trialFilter !== "all" ? "No shops match your filters" : "No shops yet"}
                </td>
              </tr>
            ) : groupByEnterprise && groupedShops ? (
              groupedShops.flatMap((group, groupIndex) => [
                <tr key={`group-${groupIndex}`} className="bg-gray-100">
                  <td colSpan={colSpan} className="px-4 py-2">
                    <div className="flex items-center gap-2 font-medium text-gray-700">
                      <Building2 className="w-4 h-4" />
                      {group.enterprise || "Standalone Shops"}
                      <span className="text-xs text-gray-500 font-normal">({group.shops.length} location{group.shops.length !== 1 ? 's' : ''})</span>
                    </div>
                  </td>
                </tr>,
                ...group.shops.map((shop) => (
                  <ShopRow key={shop._id} shop={shop} hideEnterpriseLine {...rowProps} />
                )),
              ])
            ) : (
              filteredShops.map((shop) => (
                <ShopRow key={shop._id} shop={shop} {...rowProps} />
              ))

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
                            maintenance: true, job_lookup: true, common_failures: true,
                            oil_sticker: true, keytags: true, auto_booking: true,
                            part_xref: true, labor_rates: true,
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

              <div className="border border-gray-200 rounded-lg p-4 bg-gray-50/50">
                <h4 className="text-sm font-medium text-gray-900 mb-3 flex items-center gap-2">
                  <CreditCard className="w-4 h-4 text-gray-500" />
                  Trial &amp; Card Capture
                </h4>

                <div className="grid grid-cols-2 gap-3 text-xs mb-4">
                  <div>
                    <div className="text-gray-500">Current trial</div>
                    <div className="font-medium text-gray-900">
                      {selectedShop.trial?.endsAt
                        ? `${selectedShop.trial.daysLeft ?? "?"} days left · ends ${new Date(selectedShop.trial.endsAt).toLocaleDateString()}`
                        : "No active trial"}
                    </div>
                  </div>
                  <div>
                    <div className="text-gray-500">Stripe customer</div>
                    <div className="font-medium text-gray-900 break-all">
                      {selectedShop.billing.stripeCustomerId ? (
                        <span title={selectedShop.billing.stripeCustomerId}>
                          {selectedShop.billing.stripeCustomerId}
                        </span>
                      ) : (
                        <span className="text-amber-700">Not yet created</span>
                      )}
                    </div>
                    <div className="text-gray-500 mt-0.5">
                      Card on file: {selectedShop.billing.cardOnFile || selectedShop.cardOnFile ? "Yes" : "No"}
                    </div>
                  </div>
                </div>

                <div className="space-y-3">
                  <div>
                    <label className="block text-xs text-gray-500 mb-1">Reset trial to (days from now)</label>
                    <div className="flex gap-2">
                      <input
                        type="number"
                        min="1"
                        max="365"
                        value={trialResetDays}
                        onChange={(e) => setTrialResetDays(e.target.value)}
                        className="flex-1 px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-[#3c81c3] text-sm"
                      />
                      <button
                        onClick={resetTrialFromModal}
                        disabled={actionLoading === `${selectedShop.shopId}-reset-trial`}
                        className="px-3 py-2 text-xs bg-amber-100 text-amber-800 hover:bg-amber-200 rounded-lg disabled:opacity-50 flex items-center gap-1.5 whitespace-nowrap"
                      >
                        {actionLoading === `${selectedShop.shopId}-reset-trial` && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                        <RotateCcw className="w-3.5 h-3.5" />
                        Reset Trial
                      </button>
                    </div>
                    <p className="text-[11px] text-gray-500 mt-1">
                      Starts a fresh trial from today. Clears reminder and suspension state. Blocked on active paid shops.
                    </p>
                  </div>

                  <div className="flex flex-wrap gap-2">
                    {!selectedShop.billing.stripeCustomerId && (
                      <button
                        onClick={createStripeCustomerFromModal}
                        disabled={actionLoading === `${selectedShop.shopId}-stripe-customer`}
                        className="px-3 py-2 text-xs bg-blue-100 text-blue-800 hover:bg-blue-200 rounded-lg disabled:opacity-50 flex items-center gap-1.5"
                      >
                        {actionLoading === `${selectedShop.shopId}-stripe-customer` && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                        <CreditCard className="w-3.5 h-3.5" />
                        Create Stripe Customer
                      </button>
                    )}
                    <button
                      onClick={resendCardCaptureFromModal}
                      disabled={actionLoading === `${selectedShop.shopId}-resend-card-modal`}
                      className="px-3 py-2 text-xs bg-emerald-100 text-emerald-800 hover:bg-emerald-200 rounded-lg disabled:opacity-50 flex items-center gap-1.5"
                    >
                      {actionLoading === `${selectedShop.shopId}-resend-card-modal` && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                      <Mail className="w-3.5 h-3.5" />
                      {selectedShop.billing.cardOnFile || selectedShop.cardOnFile
                        ? "Resend Card-Capture Email"
                        : "Send Card-Capture Email"}
                    </button>
                  </div>
                </div>
              </div>

              <div>
                <h4 className="text-sm font-medium text-gray-900 mb-3">Feature Toggles</h4>
                {billingEdits.plan === "detect_dog_founder" ? (
                  <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded px-2 py-1.5 mb-3">
                    Detect Dog – Founder includes every current and future feature. Toggles are locked on.
                  </p>
                ) : (
                  <p className="text-xs text-gray-500 mb-3">Override plan defaults. Leave unchecked to use plan defaults.</p>
                )}
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
                  ].map(feature => {
                    const isFounder = billingEdits.plan === "detect_dog_founder";
                    const checked = isFounder
                      ? true
                      : featureEdits[feature.key as keyof ShopFeatures] === true;
                    return (
                      <label
                        key={feature.key}
                        className={`flex items-start gap-3 p-3 border border-gray-200 rounded-lg ${
                          isFounder ? "bg-amber-50/40 cursor-not-allowed" : "hover:bg-gray-50 cursor-pointer"
                        }`}
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          disabled={isFounder}
                          onChange={(e) => setFeatureEdits({ ...featureEdits, [feature.key]: e.target.checked })}
                          className="mt-0.5 w-4 h-4 text-[#3c81c3] border-gray-300 rounded focus:ring-[#3c81c3] disabled:opacity-60"
                        />
                        <div>
                          <div className="font-medium text-gray-900 text-sm">{feature.label}</div>
                          <div className="text-xs text-gray-500">{feature.desc}</div>
                          {isFounder && (
                            <div className="text-[11px] text-amber-700 mt-1">
                              Included with Detect Dog – Founder
                            </div>
                          )}
                        </div>
                      </label>
                    );
                  })}
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
                  // Founder plan = wildcard. Don't write per-feature
                  // overrides so changing the plan later doesn't leave
                  // stale toggles behind.
                  billingEdits.plan === "detect_dog_founder" ? undefined : featureEdits
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

      {bulkConfirmOpen && (
        <BulkCardCaptureConfirmDialog
          shops={bulkEligibleShops}
          sending={bulkSending}
          onCancel={() => setBulkConfirmOpen(false)}
          onConfirm={() => sendBulkCardCapture(bulkEligibleShops.map((s) => s.shopId))}
        />
      )}

      {bulkResults && (
        <BulkCardCaptureResultsDialog
          results={bulkResults}
          onClose={() => setBulkResults(null)}
        />
      )}

      {reviewDialog && (
        <ReviewDecisionDialog
          shop={reviewDialog.shop}
          mode={reviewDialog.mode}
          notes={reviewNotesInput}
          onNotesChange={setReviewNotesInput}
          submitting={reviewSubmitting}
          onCancel={() => {
            if (!reviewSubmitting) {
              setReviewDialog(null);
              setReviewNotesInput("");
            }
          }}
          onConfirm={() =>
            submitReviewDecision(reviewDialog.shop, reviewDialog.mode, reviewNotesInput)
          }
        />
      )}

      {bulkApproveConfirmOpen && (
        <BulkApproveConfirmDialog
          shops={bulkApprovePendingShops}
          submitting={bulkApproveSubmitting}
          onCancel={() => {
            if (!bulkApproveSubmitting) setBulkApproveConfirmOpen(false);
          }}
          onConfirm={() =>
            submitBulkApprove(bulkApprovePendingShops.map((s) => s.shopId))
          }
        />
      )}
    </div>
  );
}

function ReviewDecisionDialog({
  shop,
  mode,
  notes,
  onNotesChange,
  submitting,
  onCancel,
  onConfirm,
}: {
  shop: Shop;
  mode: "approve" | "flag";
  notes: string;
  onNotesChange: (v: string) => void;
  submitting: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const reasons = Array.isArray(shop.autoFlagReasons) ? shop.autoFlagReasons : [];
  const isApprove = mode === "approve";
  return (
    <div
      className="fixed inset-0 bg-black/50 flex items-center justify-center z-50"
      onClick={() => { if (!submitting) onCancel(); }}
    >
      <div
        className="bg-white rounded-xl p-6 max-w-lg w-full mx-4 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="text-lg font-semibold text-gray-900 mb-1 flex items-center gap-2">
          {isApprove ? (
            <ShieldCheck className="w-5 h-5 text-emerald-600" />
          ) : (
            <Flag className="w-5 h-5 text-red-600" />
          )}
          {isApprove ? "Approve shop" : "Flag shop"}
        </h3>
        <div className="text-sm text-gray-600 mb-4">
          <div className="font-medium text-gray-800">{shop.name}</div>
          <div className="text-xs text-gray-500">ID {shop.shopId}</div>
        </div>
        {reasons.length > 0 && (
          <div className="mb-4 p-3 bg-amber-50 border border-amber-200 rounded-lg">
            <div className="text-xs font-medium text-amber-800 mb-1">
              Auto-flag reasons:
            </div>
            <ul className="text-xs text-amber-700 list-disc list-inside space-y-0.5">
              {reasons.map((r) => (
                <li key={r}>{REVIEW_REASON_LABELS[r] ?? r}</li>
              ))}
            </ul>
          </div>
        )}
        <p className="text-sm text-gray-600 mb-3">
          {isApprove
            ? "Approving re-enables transactional email for this shop and clears the auto-flag reasons. Notes are optional."
            : "Flagging keeps transactional email suppressed. A note explaining the reason is required."}
        </p>
        <textarea
          value={notes}
          onChange={(e) => onNotesChange(e.target.value)}
          placeholder={isApprove ? "Optional notes…" : "Required: why is this shop flagged?"}
          rows={4}
          maxLength={2000}
          disabled={submitting}
          className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-[#3c81c3] focus:border-transparent disabled:opacity-60"
        />
        <div className="flex gap-3 justify-end mt-4">
          <button
            onClick={onCancel}
            disabled={submitting}
            className="px-4 py-2 text-gray-700 hover:bg-gray-100 rounded-lg disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            disabled={submitting || (!isApprove && !notes.trim())}
            className={`px-4 py-2 text-white rounded-lg disabled:opacity-50 flex items-center gap-2 ${
              isApprove
                ? "bg-emerald-600 hover:bg-emerald-700"
                : "bg-red-600 hover:bg-red-700"
            }`}
          >
            {submitting && <Loader2 className="w-4 h-4 animate-spin" />}
            {isApprove ? "Approve" : "Flag"}
          </button>
        </div>
      </div>
    </div>
  );
}

function BulkApproveConfirmDialog({
  shops,
  submitting,
  onCancel,
  onConfirm,
}: {
  shops: Shop[];
  submitting: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const sample = shops.slice(0, 8);
  const remaining = shops.length - sample.length;
  return (
    <div
      className="fixed inset-0 bg-black/50 flex items-center justify-center z-50"
      onClick={() => { if (!submitting) onCancel(); }}
    >
      <div
        className="bg-white rounded-xl p-6 max-w-lg w-full mx-4 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="text-lg font-semibold text-gray-900 mb-2 flex items-center gap-2">
          <ShieldCheck className="w-5 h-5 text-emerald-600" />
          Approve {shops.length} pending shop{shops.length === 1 ? "" : "s"}
        </h3>
        <p className="text-sm text-gray-600 mb-4">
          This re-enables transactional email for every pending shop in the
          current filtered view and clears their auto-flag reasons. Flagged
          shops are not touched.
        </p>
        <div className="border border-gray-200 rounded-lg divide-y divide-gray-100 mb-4 max-h-64 overflow-y-auto">
          {sample.map((s) => (
            <div key={String(s.shopId)} className="px-3 py-2 text-sm flex items-center justify-between gap-2">
              <span className="font-medium text-gray-800 truncate">{s.name}</span>
              <span className="text-xs text-gray-500 whitespace-nowrap">
                ID {s.shopId}
                {Array.isArray(s.autoFlagReasons) && s.autoFlagReasons.length > 0
                  ? ` · ${s.autoFlagReasons.length} reason${s.autoFlagReasons.length === 1 ? "" : "s"}`
                  : ""}
              </span>
            </div>
          ))}
          {remaining > 0 && (
            <div className="px-3 py-2 text-xs text-gray-500 italic">
              …and {remaining} more
            </div>
          )}
        </div>
        <div className="flex gap-3 justify-end">
          <button
            onClick={onCancel}
            disabled={submitting}
            className="px-4 py-2 text-gray-700 hover:bg-gray-100 rounded-lg disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            disabled={submitting}
            className="px-4 py-2 bg-emerald-600 text-white rounded-lg hover:bg-emerald-700 disabled:opacity-50 flex items-center gap-2"
          >
            {submitting && <Loader2 className="w-4 h-4 animate-spin" />}
            {submitting ? "Approving…" : `Approve ${shops.length}`}
          </button>
        </div>
      </div>
    </div>
  );
}

function KpiCard({
  icon, iconBg, label, value, subtitle, active, onClick,
}: {
  icon: React.ReactNode;
  iconBg: string;
  label: string;
  value: number;
  subtitle?: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`text-left bg-white rounded-xl p-5 border shadow-sm transition-all ${
        active
          ? "border-[#3c81c3] ring-2 ring-[#3c81c3]/30"
          : "border-gray-200 hover:border-gray-300 hover:shadow"
      }`}
    >
      <div className="flex items-center gap-3">
        <div className={`p-2 rounded-lg ${iconBg}`}>{icon}</div>
        <div className="min-w-0 flex-1">
          <p className="text-sm text-gray-500 truncate">{label}</p>
          <p className="text-2xl font-bold text-gray-900">{value.toLocaleString()}</p>
          {subtitle && <p className="text-xs text-gray-500 mt-0.5">{subtitle}</p>}
        </div>
        {active && (
          <span className="text-[10px] font-semibold text-[#3c81c3] uppercase tracking-wide">
            Filtering
          </span>
        )}
      </div>
    </button>
  );
}

interface ShopRowProps {
  shop: Shop;
  hideEnterpriseLine?: boolean;
  actionLoading: string | null;
  impersonating: number | null;
  expandedShop: string | null;
  setExpandedShop: (id: string | null) => void;
  openMenuShopId: string | null;
  setOpenMenuShopId: (id: string | null) => void;
  accessShop: (shopId: number | string) => void;
  openFeatureModal: (shop: Shop) => void;
  toggleLock: (shopId: number | string, isLocked: boolean) => void;
  deleteShop: (shop: Shop) => void;
  resendCardCaptureEmail: (shop: Shop) => void;
  triggerExtendTrial: (shop: Shop) => void;
  triggerVinModal: (shop: Shop, action: "addViews" | "setLimit" | "resetLimit") => void;
  triggerResetViews: (shop: Shop) => void;
  triggerApproveReview: (shop: Shop) => void;
  triggerFlagReview: (shop: Shop) => void;
}

function ShopRow(props: ShopRowProps) {
  const {
    shop, hideEnterpriseLine, actionLoading, impersonating, expandedShop, setExpandedShop,
    openMenuShopId, setOpenMenuShopId, accessShop, openFeatureModal,
    toggleLock, deleteShop, resendCardCaptureEmail, triggerExtendTrial,
    triggerVinModal, triggerResetViews, triggerApproveReview, triggerFlagReview,
  } = props;
  const reviewStatus = (shop.reviewStatus || "approved") as ShopReviewStatus;
  const needsReview = reviewStatus !== "approved";

  const isExpanded = expandedShop === shop._id;
  const stickerThisMonth = shop.stickerCountThisMonth || 0;
  const stickerTotal = shop.stickerCount || 0;
  const usagePct = Math.min(100, (shop.billing.vinViewCount / Math.max(1, shop.billing.vinLimit)) * 100);

  const lastEmail = shop.lastCardCaptureEmail || null;
  const sentAgo = lastEmail ? formatTimeAgo(lastEmail.sentAt) : null;

  return (
    <>
      <tr className="hover:bg-gray-50 align-top">
        {/* Shop cell */}
        <td className="px-4 py-3">
          <div className="flex items-start gap-3">
            <div className={`w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0 ${
              shop.isLocked ? "bg-red-100" : shop.enterpriseId ? "bg-blue-100" : "bg-[rgba(60,129,195,0.15)]"
            }`}>
              {shop.isLocked ? (
                <Lock className="w-4 h-4 text-red-600" />
              ) : (
                <Building2 className={`w-4 h-4 ${shop.enterpriseId ? "text-blue-600" : "text-[#3c81c3]"}`} />
              )}
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-1.5 flex-wrap">
                <span className={`font-medium text-sm break-words ${shop.isLocked ? "text-red-700" : "text-gray-900"}`}>
                  {shop.name}
                </span>
                {shop.locationIdentifier && (
                  <span className="px-1.5 py-0.5 bg-blue-50 text-blue-700 text-[11px] rounded font-medium">
                    {shop.locationIdentifier}
                  </span>
                )}
                {shop.isLocked && (
                  <span className="px-1.5 py-0.5 bg-red-100 text-red-700 text-[11px] rounded font-medium">
                    Locked
                  </span>
                )}
              </div>
              <div className="flex items-center gap-1.5 flex-wrap mt-1">
                <span className={`px-1.5 py-0.5 text-[11px] rounded font-medium ${planColors[shop.billing.plan] || planColors.trial}`}>
                  {planLabels[shop.billing.plan] || shop.billing.plan}
                </span>
                {typeof shop.billing.stripeSubscriptionAmount === "number" && shop.billing.stripeSubscriptionAmount > 0 && (
                  <span className="text-[11px] text-gray-500" title={shop.billing.stripeProductName || undefined}>
                    ${(shop.billing.stripeSubscriptionAmount / 100).toFixed(2)}/mo
                  </span>
                )}
                {shop.trial?.endsAt && <TrialBadge trial={shop.trial} />}
                {shop.cardOnFile ? (
                  <span className="px-1.5 py-0.5 bg-emerald-50 text-emerald-700 text-[11px] rounded font-medium inline-flex items-center gap-1" title="Payment method on file">
                    <CreditCard className="w-3 h-3" /> Card
                  </span>
                ) : shop.trial?.endsAt ? (
                  <span className="px-1.5 py-0.5 bg-orange-50 text-orange-700 text-[11px] rounded font-medium inline-flex items-center gap-1" title="No payment method on file yet">
                    <CreditCard className="w-3 h-3" /> No card
                  </span>
                ) : null}
                <ReviewBadges shop={shop} />
              </div>
              <div className="text-[11px] text-gray-500 mt-1 flex items-center gap-2 flex-wrap">
                <span>ID {shop.shopId}</span>
                <span className="text-gray-300">·</span>
                <span className="inline-flex items-center gap-1"><Users className="w-3 h-3" />{shop.userCount}</span>
                <span className="text-gray-300">·</span>
                <span className="inline-flex items-center gap-1"><Car className="w-3 h-3" />{shop.vehicleCount.toLocaleString()}</span>
                {shop.enterpriseName && !hideEnterpriseLine && (
                  <>
                    <span className="text-gray-300">·</span>
                    <span className="break-words">{shop.enterpriseName}</span>
                  </>
                )}
              </div>
            </div>
          </div>
        </td>

        {/* Usage cell */}
        <td className="px-4 py-3">
          <div className="space-y-1.5">
            <div>
              <div className={`text-sm font-medium ${
                shop.billing.vinViewCount >= shop.billing.vinLimit
                  ? "text-red-600"
                  : shop.billing.isPaid ? "text-green-600" : "text-gray-900"
              }`}>
                {shop.billing.vinViewCount} / {shop.billing.vinLimit} VINs
                {shop.billing.isPaid && <span className="ml-1 text-green-500 text-[11px]">(Paid)</span>}
              </div>
              <div className="w-32 h-1.5 bg-gray-200 rounded-full overflow-hidden mt-1">
                <div
                  className={`h-full transition-all ${
                    shop.billing.vinViewCount >= shop.billing.vinLimit
                      ? "bg-red-500"
                      : shop.billing.isPaid ? "bg-green-500" : "bg-[#3c81c3]"
                  }`}
                  style={{ width: `${usagePct}%` }}
                />
              </div>
            </div>
            <div className="text-[11px] text-gray-500">
              <span className="text-gray-700 font-medium">{stickerThisMonth}</span> stickers this month
              <span className="text-gray-400"> · {stickerTotal.toLocaleString()} total</span>
            </div>
          </div>
        </td>

        {/* Integrations cell */}
        <td className="px-4 py-3">
          {shop.integrations?.length > 0 ? (
            <button
              onClick={() => setExpandedShop(isExpanded ? null : shop._id)}
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
                    <span key={int} className={`px-2 py-0.5 text-[11px] rounded font-medium ${
                      int === "AutoVitals" ? "bg-orange-100 text-orange-700" : "bg-gray-100 text-gray-700"
                    }`}>
                      {int}
                    </span>
                  );
                })}
              </div>
              {shop.integrationDetails && (
                isExpanded ? (
                  <ChevronUp className="w-4 h-4 text-gray-400 flex-shrink-0" />
                ) : (
                  <ChevronDown className="w-4 h-4 text-gray-400 flex-shrink-0" />
                )
              )}
            </button>
          ) : (
            <span className="text-gray-400 text-sm">None</span>
          )}
        </td>

        {/* Backfill cell */}
        <td className="px-4 py-3 text-center">
          <BackfillCell backfill={shop.backfill || null} />
        </td>

        {/* Created cell */}
        <td className="px-4 py-3 text-gray-600 text-sm whitespace-nowrap">
          {new Date(shop.createdAt).toLocaleDateString()}
        </td>

        {/* Actions cell */}
        <td className="px-4 py-3 text-right">
          <div className="flex items-center justify-end gap-1.5">
            {sentAgo && shop.trial?.endsAt && (
              <span className="text-[11px] text-gray-500 hidden xl:inline" title={`Card-capture last sent ${sentAgo}`}>
                Email {sentAgo}
              </span>
            )}
            {needsReview && (
              <>
                <button
                  onClick={() => triggerApproveReview(shop)}
                  disabled={actionLoading !== null}
                  title="Approve shop (re-enables transactional email)"
                  className="p-1.5 text-emerald-600 hover:bg-emerald-50 rounded-lg disabled:opacity-50"
                >
                  {actionLoading === `${shop.shopId}-review-approve` ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    <ShieldCheck className="w-4 h-4" />
                  )}
                </button>
                <button
                  onClick={() => triggerFlagReview(shop)}
                  disabled={actionLoading !== null}
                  title="Flag shop with notes (keeps email suppressed)"
                  className="p-1.5 text-red-600 hover:bg-red-50 rounded-lg disabled:opacity-50"
                >
                  {actionLoading === `${shop.shopId}-review-flag` ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    <Flag className="w-4 h-4" />
                  )}
                </button>
              </>
            )}
            <button
              onClick={() => openFeatureModal(shop)}
              disabled={actionLoading !== null}
              title="Manage billing & features"
              className="p-1.5 text-gray-500 hover:text-[#3c81c3] hover:bg-[rgba(60,129,195,0.1)] rounded-lg transition-colors disabled:opacity-50"
            >
              <Settings className="w-4 h-4" />
            </button>
            <button
              onClick={() => accessShop(shop.shopId)}
              disabled={impersonating !== null || shop.isLocked}
              title={shop.isLocked ? "Shop is locked" : "Access this shop"}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-[rgba(60,129,195,0.85)] text-white text-sm font-medium rounded-lg hover:bg-[#3c81c3] disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {impersonating === shop.shopId ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <LogIn className="w-4 h-4" />
              )}
              Impersonate
            </button>
            <ShopRowMenu
              shop={shop}
              isOpen={openMenuShopId === shop._id}
              setOpen={(open) => setOpenMenuShopId(open ? shop._id : null)}
              actionLoading={actionLoading}
              triggerVinModal={triggerVinModal}
              triggerResetViews={triggerResetViews}
              triggerExtendTrial={triggerExtendTrial}
              resendCardCaptureEmail={resendCardCaptureEmail}
              toggleLock={toggleLock}
              deleteShop={deleteShop}
            />
          </div>
        </td>
      </tr>
      {isExpanded && shop.integrationDetails && (
        <tr className="bg-blue-50">
          <td colSpan={6} className="px-4 py-4">
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
      )}
    </>
  );
}

function ShopRowMenu({
  shop, isOpen, setOpen, actionLoading,
  triggerVinModal, triggerResetViews, triggerExtendTrial,
  resendCardCaptureEmail, toggleLock, deleteShop,
}: {
  shop: Shop;
  isOpen: boolean;
  setOpen: (open: boolean) => void;
  actionLoading: string | null;
  triggerVinModal: (shop: Shop, action: "addViews" | "setLimit" | "resetLimit") => void;
  triggerResetViews: (shop: Shop) => void;
  triggerExtendTrial: (shop: Shop) => void;
  resendCardCaptureEmail: (shop: Shop) => void;
  toggleLock: (shopId: number | string, isLocked: boolean) => void;
  deleteShop: (shop: Shop) => void;
}) {
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [isOpen, setOpen]);

  const close = () => setOpen(false);

  const item = (icon: React.ReactNode, label: string, onClick: () => void, danger = false) => (
    <button
      onClick={() => { close(); onClick(); }}
      disabled={actionLoading !== null}
      className={`w-full flex items-center gap-2 px-3 py-2 text-sm text-left transition-colors disabled:opacity-50 ${
        danger ? "text-red-600 hover:bg-red-50" : "text-gray-700 hover:bg-gray-50"
      }`}
    >
      <span className="w-4 h-4 flex items-center justify-center flex-shrink-0">{icon}</span>
      <span>{label}</span>
    </button>
  );

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen(!isOpen)}
        title="More actions"
        className={`p-1.5 rounded-lg transition-colors ${isOpen ? "bg-gray-100 text-gray-700" : "text-gray-500 hover:bg-gray-100 hover:text-gray-700"}`}
      >
        <MoreHorizontal className="w-4 h-4" />
      </button>
      {isOpen && (
        <div className="absolute right-0 top-full mt-1 z-30 w-56 bg-white border border-gray-200 rounded-lg shadow-lg py-1">
          {item(<Plus className="w-4 h-4 text-green-600" />, "Add VINs", () => triggerVinModal(shop, "addViews"))}
          {item(<Settings className="w-4 h-4 text-blue-600" />, "Set custom VIN limit", () => triggerVinModal(shop, "setLimit"))}
          {item(<X className="w-4 h-4 text-gray-500" />, "Reset VIN limit", () => triggerVinModal(shop, "resetLimit"))}
          {item(<RotateCcw className="w-4 h-4 text-orange-600" />, "Reset viewed VINs", () => triggerResetViews(shop))}
          {shop.trial?.endsAt && (
            <>
              <div className="border-t border-gray-100 my-1" />
              {item(<Clock className="w-4 h-4 text-blue-600" />, "Extend trial", () => triggerExtendTrial(shop))}
              {item(
                <Mail className={`w-4 h-4 ${shop.cardOnFile ? "text-gray-500" : "text-amber-600"}`} />,
                "Resend card-capture email",
                () => resendCardCaptureEmail(shop),
              )}
            </>
          )}
          <div className="border-t border-gray-100 my-1" />
          {item(
            shop.isLocked ? <Unlock className="w-4 h-4 text-green-600" /> : <Lock className="w-4 h-4 text-orange-600" />,
            shop.isLocked ? "Unlock shop" : "Lock shop",
            () => toggleLock(shop.shopId, !!shop.isLocked),
          )}
          {item(<Trash2 className="w-4 h-4" />, "Delete shop", () => deleteShop(shop), true)}
        </div>
      )}
    </div>
  );
}

function BackfillCell({ backfill }: { backfill: BackfillStatus | null }) {
  if (!backfill) return <span className="text-gray-300">—</span>;
  const count = backfill.totalJobsIndexed.toLocaleString();
  if (backfill.status === "completed") {
    return (
      <div className="flex items-center justify-center gap-1 text-green-600" title={`Completed: ${count} jobs indexed (${backfill.source || 'unknown'})`}>
        <CheckCircle2 className="w-4 h-4" />
        <span className="text-xs">{count}</span>
      </div>
    );
  }
  if (backfill.status === "active") {
    return (
      <div className="flex items-center justify-center gap-1 text-blue-600" title={`Active: ${backfill.processedCount.toLocaleString()} WOs processed, ${count} jobs indexed. Processing: ${backfill.currentChunkDate ? new Date(backfill.currentChunkDate).toLocaleDateString() : 'starting'}. Last activity: ${backfill.lastActivityAt ? new Date(backfill.lastActivityAt).toLocaleTimeString() : 'unknown'}`}>
        <Loader2 className="w-4 h-4 animate-spin" />
        <span className="text-xs">{count}</span>
      </div>
    );
  }
  if (backfill.status === "stale") {
    return (
      <div className="flex items-center justify-center gap-1 text-orange-600" title={`Stale (no activity in 5+ min): ${backfill.processedCount.toLocaleString()} WOs processed, ${count} jobs indexed. Last activity: ${backfill.lastActivityAt ? new Date(backfill.lastActivityAt).toLocaleString() : 'unknown'}`}>
        <AlertCircle className="w-4 h-4" />
        <span className="text-xs">{count}</span>
      </div>
    );
  }
  if (backfill.status === "error") {
    return (
      <div className="flex items-center justify-center gap-1 text-red-600" title={`Error: ${backfill.lastError || 'Unknown error'}. Last run: ${backfill.lastErrorAt ? new Date(backfill.lastErrorAt).toLocaleString() : 'unknown'}`}>
        <XCircle className="w-4 h-4" />
        <span className="text-xs">{count}</span>
      </div>
    );
  }
  return (
    <div className="flex items-center justify-center gap-1 text-amber-600" title={`Pending: ${backfill.processedCount.toLocaleString()} WOs processed, ${count} jobs indexed. Last run: ${backfill.lastAttemptedAt ? new Date(backfill.lastAttemptedAt).toLocaleString() : 'never'}`}>
      <Pause className="w-4 h-4" />
      <span className="text-xs">{count}</span>
    </div>
  );
}

function BulkCardCaptureConfirmDialog({
  shops, sending, onCancel, onConfirm,
}: {
  shops: Shop[];
  sending: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const sample = shops.slice(0, 5);
  const remaining = shops.length - sample.length;
  return (
    <div
      className="fixed inset-0 bg-black/50 flex items-center justify-center z-50"
      onClick={() => { if (!sending) onCancel(); }}
    >
      <div
        className="bg-white rounded-xl p-6 max-w-lg w-full mx-4 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="text-lg font-semibold text-gray-900 mb-2">
          Resend card-capture email to {shops.length} shop{shops.length === 1 ? "" : "s"}
        </h3>
        <p className="text-sm text-gray-600 mb-4">
          Each shop&apos;s owner will get a fresh Stripe card-setup link. Sends are
          rate-limited and you&apos;ll get a per-shop summary when finished.
        </p>
        <div className="border border-gray-200 rounded-lg divide-y divide-gray-100 mb-4 max-h-64 overflow-y-auto">
          {sample.map((s) => (
            <div key={String(s.shopId)} className="px-3 py-2 text-sm flex items-center justify-between">
              <span className="font-medium text-gray-800 truncate mr-2">{s.name}</span>
              <span className="text-xs text-gray-500 whitespace-nowrap">
                ID {s.shopId}
                {s.trial?.daysLeft !== undefined && s.trial?.daysLeft !== null
                  ? ` · ${s.trial.daysLeft}d left`
                  : ""}
              </span>
            </div>
          ))}
          {remaining > 0 && (
            <div className="px-3 py-2 text-xs text-gray-500 italic">
              …and {remaining} more
            </div>
          )}
        </div>
        <div className="flex gap-3 justify-end">
          <button
            onClick={onCancel}
            disabled={sending}
            className="px-4 py-2 text-gray-700 hover:bg-gray-100 rounded-lg disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            disabled={sending}
            className="px-4 py-2 bg-amber-600 text-white rounded-lg hover:bg-amber-700 disabled:opacity-50 flex items-center gap-2"
          >
            {sending && <Loader2 className="w-4 h-4 animate-spin" />}
            {sending ? "Sending…" : `Send ${shops.length} email${shops.length === 1 ? "" : "s"}`}
          </button>
        </div>
      </div>
    </div>
  );
}

function BulkCardCaptureResultsDialog({
  results, onClose,
}: {
  results: {
    requestedCount: number;
    succeeded: number;
    failed: number;
    results: {
      shopId: number | string;
      shopName?: string;
      ownerEmail?: string;
      ok: boolean;
      mode?: "reminder" | "suspended";
      error?: string;
    }[];
  };
  onClose: () => void;
}) {
  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={onClose}>
      <div
        className="bg-white rounded-xl p-6 max-w-2xl w-full mx-4 shadow-xl max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="text-lg font-semibold text-gray-900 mb-1">Bulk card-capture results</h3>
        <p className="text-sm text-gray-600 mb-4">
          {results.succeeded} sent, {results.failed} failed (out of {results.requestedCount}).
        </p>
        <div className="border border-gray-200 rounded-lg divide-y divide-gray-100 mb-4">
          {results.results.map((r) => (
            <div key={String(r.shopId)} className="px-3 py-2 text-sm flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="font-medium text-gray-800 truncate">
                  {r.shopName || `Shop ${r.shopId}`}
                  <span className="ml-2 text-xs text-gray-500">ID {r.shopId}</span>
                </div>
                {r.ownerEmail && (
                  <div className="text-xs text-gray-500 truncate">{r.ownerEmail}</div>
                )}
                {!r.ok && r.error && (
                  <div className="text-xs text-red-600 mt-0.5">{r.error}</div>
                )}
              </div>
              <span
                className={`px-2 py-0.5 text-xs rounded whitespace-nowrap ${
                  r.ok ? "bg-emerald-100 text-emerald-700" : "bg-red-100 text-red-700"
                }`}
              >
                {r.ok ? (r.mode === "suspended" ? "Sent (suspended)" : "Sent") : "Failed"}
              </span>
            </div>
          ))}
        </div>
        <div className="flex justify-end">
          <button
            onClick={onClose}
            className="px-4 py-2 bg-[#3c81c3] text-white rounded-lg hover:bg-[#2d6da8]"
          >
            Close
          </button>
        </div>
      </div>
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
  const label = expired ? "Trial ended" : `${daysLeft}d left`;
  const tip = `Trial ends ${new Date(trial.endsAt).toLocaleDateString()}${trial.days ? ` (${trial.days}-day trial)` : ""}`;
  return (
    <span className={`px-1.5 py-0.5 text-[11px] rounded font-medium ${cls}`} title={tip}>
      {label}
    </span>
  );
}
