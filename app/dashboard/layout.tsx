"use client";

import type { ReactNode } from "react";
import { Sidebar } from "@/components/ui/Sidebar";

export default function DashboardLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-screen bg-gray-50">
      <Sidebar shopName="My Auto Shop" userInitials="MS" />
      <div className="flex-1 flex flex-col overflow-hidden">
        {children}
      </div>
    </div>
  );
}
