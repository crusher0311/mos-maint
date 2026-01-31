"use client";

import type { ReactNode } from "react";
import { useState, useEffect } from "react";
import { Sidebar } from "@/components/ui/Sidebar";
import QuickStickerModal from "@/components/stickers/QuickStickerModal";
import SupportChatWidget from "@/components/ui/SupportChatWidget";
import { GhostModeBanner } from "@/components/ui/GhostModeBanner";
import { AnnouncementBanner } from "@/components/ui/AnnouncementBanner";
import { BillingStatusBanner, BillingStatus } from "@/components/ui/BillingStatusBanner";
import { Menu } from "lucide-react";

interface UserInfo {
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
}

export default function DashboardLayout({ children }: { children: ReactNode }) {
  const [userInfo, setUserInfo] = useState<UserInfo | null>(null);
  const [quickStickerOpen, setQuickStickerOpen] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  useEffect(() => {
    async function fetchUserInfo() {
      try {
        const [authRes, featuresRes] = await Promise.all([
          fetch("/api/auth/me"),
          fetch("/api/shop/features"),
        ]);
        
        if (authRes.ok) {
          const authData = await authRes.json();
          if (authData.authenticated) {
            let enabledFeatures = ["maintenance"];
            
            let billingStatus: BillingStatus | undefined;
            let gracePeriodEndsAt: string | null = null;
            
            if (featuresRes.ok) {
              const featuresData = await featuresRes.json();
              if (featuresData.enabledFeatureIds) {
                enabledFeatures = featuresData.enabledFeatureIds;
              }
              if (featuresData.billing) {
                billingStatus = featuresData.billing.status;
                gracePeriodEndsAt = featuresData.billing.gracePeriodEndsAt;
              }
            }
            
            setUserInfo({ ...authData, enabledFeatures, billingStatus, gracePeriodEndsAt });
          }
        }
      } catch (err) {
        console.error("Failed to fetch user info:", err);
      }
    }
    fetchUserInfo();
  }, []);

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
          hasEnterpriseBilling={userInfo?.hasEnterpriseBilling}
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
          hasEnterpriseBilling={userInfo?.hasEnterpriseBilling}
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
          {children}
        </div>
      </div>

      <QuickStickerModal 
        isOpen={quickStickerOpen} 
        onClose={() => setQuickStickerOpen(false)} 
      />

      <SupportChatWidget />
    </div>
    </>
  );
}
