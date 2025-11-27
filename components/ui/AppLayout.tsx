"use client";

import { ReactNode } from "react";
import { Sidebar } from "./Sidebar";
import { HelpCircle } from "lucide-react";

interface AppLayoutProps {
  children: ReactNode;
  title?: string;
  titleIcon?: ReactNode;
  shopName?: string;
  userInitials?: string;
  actions?: ReactNode;
}

export function AppLayout({ 
  children, 
  title, 
  titleIcon,
  shopName,
  userInitials,
  actions 
}: AppLayoutProps) {
  return (
    <div className="flex min-h-screen bg-gray-50">
      <Sidebar shopName={shopName} userInitials={userInitials} />
      
      <div className="flex-1 flex flex-col">
        <header className="bg-white border-b border-gray-200 px-6 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              {titleIcon && (
                <span className="text-slate-600">{titleIcon}</span>
              )}
              {title && (
                <h1 className="text-xl font-semibold text-gray-900">{title}</h1>
              )}
            </div>
            <div className="flex items-center gap-4">
              {actions}
              <button className="p-2 text-gray-400 hover:text-gray-600 rounded-lg hover:bg-gray-100 transition-colors">
                <HelpCircle className="w-5 h-5" />
              </button>
              <div className="w-8 h-8 rounded-full bg-blue-600 flex items-center justify-center text-white text-sm font-medium">
                {userInitials || "U"}
              </div>
            </div>
          </div>
        </header>
        
        <main className="flex-1 p-6 overflow-auto">
          {children}
        </main>
      </div>
    </div>
  );
}
