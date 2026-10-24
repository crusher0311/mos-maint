"use client";

import type { ReactNode } from "react";
import { useState, useEffect, useRef } from "react";
import { useRouter, usePathname } from "next/navigation";
import { Sidebar } from "@/components/ui/Sidebar";
import QuickStickerModal from "@/components/stickers/QuickStickerModal";
import SupportChatWidget from "@/components/ui/SupportChatWidget";
import { GhostModeBanner } from "@/components/ui/GhostModeBanner";
import { AnnouncementBanner } from "@/components/ui/AnnouncementBanner";
import { BillingStatusBanner, BillingStatus } from "@/components/ui/BillingStatusBanner";
import { Menu } from "lucide-react";
import TutorialHost from "@/components/tutorials/TutorialHost";
import "@/mos-tools-extension/tutorials.css";

interface TrialState {
  active: boolean;
  startedAt: string | null;
  endsAt: string | null;
  days: number | null;
  daysLeft: number | null;
  cardOnFile: boolean;
}

interface UserInfo {
  userId?: string;
  email: string;
  role: string;
  shopId: number;
  shopName: string;
  shopLogo?: string | null;
  locationIdentifier?: string | null;
  authenticated: boolean;
  isPlatformAdmin?: boolean;
  enterpriseId?: string | null;
  hasEnterpriseBilling?: boolean;
  enabledFeatures?: string[];
  billingStatus?: BillingStatus;
  gracePeriodEndsAt?: string | null;
  trial?: TrialState | null;
}

export default function DashboardLayout({ children }: { children: ReactNode }) {
  const [userInfo, setUserInfo] = useState<UserInfo | null>(null);
  const [quickStickerOpen, setQuickStickerOpen] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const router = useRouter();
  const pathname = usePathname();
  const authScope = useRef("");

  useEffect(() => {
    let disposed = false;
    let expiryTimer: ReturnType<typeof setTimeout>;
    let sequence = 0;
    async function fetchUserInfo() {
      const request = ++sequence;
      try {
        const [authRes, featuresRes] = await Promise.all([
          fetch("/api/auth/me"),
          fetch("/api/shop/features"),
        ]);
        
        if (authRes.ok) {
          const authData = await authRes.json();
          if (disposed || request !== sequence) return;
          if (!authData.authenticated) {
            setUserInfo(null);
            setQuickStickerOpen(false);
            window.dispatchEvent(new Event("mos:tutorial-scope-changing"));
            return;
          }
          const nextAuthScope = JSON.stringify([authData.userId, authData.email, authData.shopId, authData.role]);
          if (authScope.current && authScope.current !== nextAuthScope) {
            window.dispatchEvent(new Event("mos:tutorial-scope-changing"));
            setUserInfo(null);
          }
          authScope.current = nextAuthScope;
          if (authData.authenticated) {
            if (authData.needsSetup && pathname !== "/dashboard/setup-shop") {
              router.replace("/dashboard/setup-shop");
              return;
            }

            let enabledFeatures: string[] = [];
            
            let billingStatus: BillingStatus | undefined;
            let gracePeriodEndsAt: string | null = null;
            let trial: TrialState | null = null;
            
            if (!featuresRes.ok) return; // A lookup failure is not a new denial.
            if (featuresRes.ok) {
              const featuresData = await featuresRes.json();
              if (disposed || request !== sequence) return;
              clearTimeout(expiryTimer);
              const deadline = Date.parse(featuresData.eligibility?.eligibleUntil);
              if (Number.isFinite(deadline) && deadline > Date.now()) {
                const delay = deadline - Date.now();
                expiryTimer = setTimeout(() => {
                  if (delay <= 2147483647) {
                    const remaining = Object.entries(featuresData.postExpiryFeatures || {})
                      .filter(([, allowed]) => allowed === true).map(([key]) => key);
                    setUserInfo(previous => previous ? { ...previous, enabledFeatures: remaining } : previous);
                    setQuickStickerOpen(false);
                  }
                  void fetchUserInfo();
                }, Math.min(delay, 2147483647));
              }
              if (featuresData.enabledFeatureIds) {
                enabledFeatures = featuresData.enabledFeatureIds;
              }
              if (featuresData.billing) {
                billingStatus = featuresData.billing.status;
                gracePeriodEndsAt = featuresData.billing.gracePeriodEndsAt;
              }
              if (featuresData.trial) {
                trial = featuresData.trial;
              }
            }
            
            setUserInfo({ ...authData, enabledFeatures, billingStatus, gracePeriodEndsAt, trial });
          }
        } else if (authRes.status === 401 || authRes.status === 403) {
          if (disposed || request !== sequence) return;
          setUserInfo(null);
          window.dispatchEvent(new Event("mos:tutorial-scope-changing"));
        }
      } catch (err) {
        console.error("Failed to fetch user info:", err);
      }
    }
    fetchUserInfo();
    const interval = setInterval(fetchUserInfo, 60000);
    window.addEventListener("focus", fetchUserInfo);
    return () => {
      disposed = true;
      clearTimeout(expiryTimer);
      clearInterval(interval);
      window.removeEventListener("focus", fetchUserInfo);
    };
  }, [pathname, router]);

  useEffect(() => {
    if (mobileMenuOpen) {
      document.body.style.overflow = 'hidden';
    } else {
      document.body.style.overflow = '';
    }
    return () => {
      document.body.style.overflow = '';
    };
  }, [mobileMenuOpen]);

  const userInitials = userInfo?.email
    ? userInfo.email.substring(0, 2).toUpperCase()
    : "??";

  return (
    <>
      <GhostModeBanner />
      <div className="flex h-screen bg-gray-50 overflow-hidden">
      {/* Desktop Sidebar - hidden on mobile */}
      <div className="hidden md:block md:w-64 flex-shrink-0">
        <Sidebar 
          shopName={userInfo?.shopName || "Loading..."} 
          shopLogo={userInfo?.shopLogo}
          locationIdentifier={userInfo?.locationIdentifier}
          userEmail={userInfo?.email}
          userRole={userInfo?.role}
          userInitials={userInitials}
          isPlatformAdmin={userInfo?.isPlatformAdmin}
          currentShopId={userInfo?.shopId}
          enterpriseId={userInfo?.enterpriseId}
          enabledFeatures={userInfo?.enabledFeatures}
          onQuickStickerClick={() => setQuickStickerOpen(true)}
        />
      </div>

      {/* Mobile overlay */}
      {mobileMenuOpen && (
        <div 
          className="fixed inset-0 bg-black/50 z-40 md:hidden"
          onClick={() => setMobileMenuOpen(false)}
        />
      )}

      {/* Mobile Sidebar - slide-out drawer */}
      <div 
        className={`fixed inset-y-0 left-0 z-50 w-72 max-w-[85vw] transform transition-transform duration-300 ease-in-out md:hidden ${
          mobileMenuOpen ? 'translate-x-0' : '-translate-x-full'
        }`}
      >
        <Sidebar 
          shopName={userInfo?.shopName || "Loading..."} 
          shopLogo={userInfo?.shopLogo}
          locationIdentifier={userInfo?.locationIdentifier}
          userEmail={userInfo?.email}
          userRole={userInfo?.role}
          userInitials={userInitials}
          isPlatformAdmin={userInfo?.isPlatformAdmin}
          currentShopId={userInfo?.shopId}
          enterpriseId={userInfo?.enterpriseId}
          enabledFeatures={userInfo?.enabledFeatures}
          onQuickStickerClick={() => {
            setQuickStickerOpen(true);
            setMobileMenuOpen(false);
          }}
          onClose={() => setMobileMenuOpen(false)}
        />
      </div>

      {/* Main content area */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {/* Mobile header */}
        <header className="md:hidden flex items-center justify-between h-14 px-4 border-b border-gray-200 bg-white flex-shrink-0">
          <button
            onClick={() => setMobileMenuOpen(true)}
            className="p-2 -ml-2 rounded-lg text-gray-600 hover:bg-gray-100 active:bg-gray-200"
            aria-label="Open menu"
          >
            <Menu className="w-6 h-6" />
          </button>
          <div className="flex items-center gap-2 min-w-0 flex-1 justify-center">
            {userInfo?.shopLogo && (
              <img 
                src={userInfo.shopLogo} 
                alt="" 
                className="h-8 w-auto max-w-[40px] object-contain"
              />
            )}
            <span className="font-semibold text-gray-900 truncate">
              {userInfo?.shopName || "Loading..."}
            </span>
          </div>
          <div className="w-10" /> {/* Spacer for balance */}
        </header>

        {/* Scrollable content */}
        <div className="flex-1 overflow-y-auto">
          <div className="px-4 pt-4 sm:px-6 sm:pt-6">
            <AnnouncementBanner />
            {userInfo?.billingStatus && (
              <BillingStatusBanner 
                status={userInfo.billingStatus}
                gracePeriodEndsAt={userInfo.gracePeriodEndsAt}
                shopName={userInfo.shopName}
              />
            )}
          </div>
          <TutorialHost
            authenticated={userInfo?.authenticated === true}
            identity={`${userInfo?.userId || userInfo?.email || ""}|${userInfo?.shopId || ""}|${userInfo?.role || ""}`}
            enabledFeatures={userInfo?.enabledFeatures || []}
          />
          {children}
        </div>
      </div>

      <QuickStickerModal 
        isOpen={quickStickerOpen} 
        vin={pathname?.match(/^\/dashboard\/(?:vehicles|analyzer)\/([A-HJ-NPR-Z0-9]{17})(?:\/|$)/i)?.[1]}
        onClose={() => setQuickStickerOpen(false)} 
      />

      <SupportChatWidget />
    </div>
    </>
  );
}
