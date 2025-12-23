"use client";

import type { ReactNode } from "react";
import { useState, useEffect } from "react";
import { Sidebar } from "@/components/ui/Sidebar";

interface UserInfo {
  email: string;
  role: string;
  shopName: string;
  authenticated: boolean;
  isPlatformAdmin?: boolean;
}

export default function DashboardLayout({ children }: { children: ReactNode }) {
  const [userInfo, setUserInfo] = useState<UserInfo | null>(null);

  useEffect(() => {
    async function fetchUserInfo() {
      try {
        const res = await fetch("/api/auth/me");
        if (res.ok) {
          const data = await res.json();
          if (data.authenticated) {
            setUserInfo(data);
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
        userEmail={userInfo?.email}
        userRole={userInfo?.role}
        userInitials={userInitials}
        isPlatformAdmin={userInfo?.isPlatformAdmin}
      />
      <div className="flex-1 flex flex-col overflow-hidden">
        {children}
      </div>
    </div>
  );
}
