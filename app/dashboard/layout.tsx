"use client";

import type { ReactNode } from "react";
import { useState, useEffect } from "react";
import { Sidebar } from "@/components/ui/Sidebar";

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
  enabledFeatures?: string[];
}

export default function DashboardLayout({ children }: { children: ReactNode }) {
  const [userInfo, setUserInfo] = useState<UserInfo | null>(null);

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
            
            if (featuresRes.ok) {
              const featuresData = await featuresRes.json();
              if (featuresData.enabledFeatureIds) {
                enabledFeatures = featuresData.enabledFeatureIds;
              }
            }
            
            setUserInfo({ ...authData, enabledFeatures });
          }
        }
      } catch (err) {
        console.error("Failed to fetch user info:", err);
      }
    }
    fetchUserInfo();
  }, []);

  const userInitials = userInfo?.email
    ? userInfo.email.substring(0, 2).toUpperCase()
    : "??";

  return (
    <div className="flex min-h-screen bg-gray-50">
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
      />
      <div className="flex-1 flex flex-col overflow-hidden">
        {children}
      </div>
    </div>
  );
}
