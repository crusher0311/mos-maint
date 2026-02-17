"use client";

import { useState, useEffect, ReactNode } from "react";
import Image from "next/image";
import { PlatformAdminSidebar } from "./PlatformAdminSidebar";
import { Menu } from "lucide-react";

interface PlatformAdminLayoutClientProps {
  children: ReactNode;
  userEmail?: string;
}

export function PlatformAdminLayoutClient({ 
  children, 
  userEmail 
}: PlatformAdminLayoutClientProps) {
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);

  useEffect(() => {
    if (isMobileMenuOpen) {
      document.body.style.overflow = "hidden";
    } else {
      document.body.style.overflow = "";
    }
    return () => {
      document.body.style.overflow = "";
    };
  }, [isMobileMenuOpen]);

  return (
    <div className="flex h-screen bg-gray-50 overflow-hidden">
      {/* Mobile Header */}
      <div className="fixed top-0 left-0 right-0 h-14 bg-slate-900 border-b border-slate-700 flex items-center px-4 z-40 md:hidden">
        <button
          onClick={() => setIsMobileMenuOpen(true)}
          className="p-2 text-slate-300 hover:text-white hover:bg-slate-800 rounded-lg transition-colors"
          aria-label="Open menu"
        >
          <Menu className="w-6 h-6" />
        </button>
        <div className="flex items-center gap-2 ml-3">
          <Image 
            src="/mos-logo.png" 
            alt="MOS Tools" 
            width={32} 
            height={32} 
            className="rounded-lg"
          />
          <span className="text-white font-semibold">MOS Admin</span>
        </div>
      </div>

      {/* Mobile Drawer Overlay */}
      {isMobileMenuOpen && (
        <div
          className="fixed inset-0 bg-black/50 z-40 md:hidden"
          onClick={() => setIsMobileMenuOpen(false)}
        />
      )}

      {/* Mobile Sidebar Drawer */}
      <div
        className={`fixed inset-y-0 left-0 z-50 w-[85vw] max-w-[280px] transform transition-transform duration-300 ease-in-out md:hidden ${
          isMobileMenuOpen ? "translate-x-0" : "-translate-x-full"
        }`}
      >
        <PlatformAdminSidebar 
          userEmail={userEmail} 
          isMobile={true}
          onClose={() => setIsMobileMenuOpen(false)}
        />
      </div>

      {/* Desktop Sidebar */}
      <div className="hidden md:block md:w-64 flex-shrink-0">
        <PlatformAdminSidebar userEmail={userEmail} />
      </div>

      {/* Main Content */}
      <main className="flex-1 overflow-auto pt-14 md:pt-0">
        {children}
      </main>
    </div>
  );
}
