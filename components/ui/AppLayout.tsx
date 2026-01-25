"use client";

import React, { useState } from "react";
import Link from "next/link";
import { Sidebar } from "./Sidebar";
import { HelpCircle, Menu } from "lucide-react";

interface AppLayoutProps {
  children: React.ReactNode;
  title?: string;
  titleIcon?: React.ReactNode;
  shopName?: string;
  userInitials?: string;
  actions?: React.ReactNode;
  enabledFeatures?: string[];
  shopLogo?: string | null;
  locationIdentifier?: string | null;
  userEmail?: string;
  userRole?: string;
  isPlatformAdmin?: boolean;
  currentShopId?: number;
  enterpriseId?: string | null;
}

export function AppLayout({ 
  children, 
  title, 
  titleIcon,
  shopName,
  userInitials,
  actions,
  enabledFeatures,
  shopLogo,
  locationIdentifier,
  userEmail,
  userRole,
  isPlatformAdmin,
  currentShopId,
  enterpriseId
}: AppLayoutProps) {
  const [sidebarOpen, setSidebarOpen] = useState(false);

  return (
    <div className="flex min-h-screen bg-gray-50">
      {/* Mobile sidebar backdrop */}
      {sidebarOpen && (
        <div 
          className="fixed inset-0 bg-black/50 z-40 lg:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      {/* Sidebar - hidden on mobile, shown on lg+ */}
      <div className={`
        fixed inset-y-0 left-0 z-50 transform transition-transform duration-300 ease-in-out lg:relative lg:transform-none
        ${sidebarOpen ? 'translate-x-0' : '-translate-x-full lg:translate-x-0'}
      `}>
        <Sidebar 
          shopName={shopName} 
          userInitials={userInitials} 
          enabledFeatures={enabledFeatures}
          shopLogo={shopLogo}
          locationIdentifier={locationIdentifier}
          userEmail={userEmail}
          userRole={userRole}
          isPlatformAdmin={isPlatformAdmin}
          currentShopId={currentShopId}
          enterpriseId={enterpriseId}
          onClose={() => setSidebarOpen(false)}
        />
      </div>
      
      <div className="flex-1 flex flex-col min-w-0">
        <header className="bg-white border-b border-gray-200 px-4 sm:px-6 py-3 sm:py-4">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2 sm:gap-3 min-w-0">
              {/* Mobile hamburger */}
              <button
                onClick={() => setSidebarOpen(true)}
                className="lg:hidden p-2 -ml-2 text-gray-500 hover:text-gray-700 hover:bg-gray-100 rounded-lg"
              >
                <Menu className="w-5 h-5" />
              </button>
              {titleIcon && (
                <span className="text-slate-600 hidden sm:block">{titleIcon}</span>
              )}
              {title && (
                <h1 className="text-lg sm:text-xl font-semibold text-gray-900 truncate">{title}</h1>
              )}
            </div>
            <div className="flex items-center gap-2 sm:gap-4 flex-shrink-0">
              {actions}
              <Link 
                href="/dashboard/help" 
                className="p-2 text-gray-400 hover:text-gray-600 rounded-lg hover:bg-gray-100 transition-colors hidden sm:block"
                title="Help Center"
              >
                <HelpCircle className="w-5 h-5" />
              </Link>
              <div className="w-7 h-7 sm:w-8 sm:h-8 rounded-full bg-blue-600 flex items-center justify-center text-white text-xs sm:text-sm font-medium">
                {userInitials || "U"}
              </div>
            </div>
          </div>
        </header>
        
        <main className="flex-1 p-4 sm:p-6 overflow-auto">
          {children}
        </main>
      </div>
    </div>
  );
}
