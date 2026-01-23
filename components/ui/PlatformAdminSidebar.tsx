"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { 
  Building2, 
  Users, 
  DollarSign, 
  LayoutDashboard,
  LogOut,
  Shield,
  Settings,
  QrCode,
  Activity,
  CreditCard,
  Database,
  FileText,
  X
} from "lucide-react";

interface PlatformAdminSidebarProps {
  userEmail?: string;
  isMobile?: boolean;
  onClose?: () => void;
}

export function PlatformAdminSidebar({ userEmail, isMobile, onClose }: PlatformAdminSidebarProps) {
  const pathname = usePathname();

  const isActive = (href: string) => {
    return pathname === href || pathname?.startsWith(href + "/");
  };

  const navItems = [
    {
      name: "Overview",
      href: "/platform-admin",
      icon: <LayoutDashboard className="w-5 h-5" />
    },
    {
      name: "Shops",
      href: "/platform-admin/shops",
      icon: <Building2 className="w-5 h-5" />
    },
    {
      name: "Enterprises",
      href: "/platform-admin/enterprises",
      icon: <Shield className="w-5 h-5" />
    },
    {
      name: "Users",
      href: "/platform-admin/users",
      icon: <Users className="w-5 h-5" />
    },
    {
      name: "Usage & Costs",
      href: "/platform-admin/usage",
      icon: <DollarSign className="w-5 h-5" />
    },
    {
      name: "Billing",
      href: "/platform-admin/billing",
      icon: <CreditCard className="w-5 h-5" />
    },
    {
      name: "API Traffic",
      href: "/platform-admin/api-usage",
      icon: <Activity className="w-5 h-5" />
    },
    {
      name: "Render Logs",
      href: "/platform-admin/render",
      icon: <FileText className="w-5 h-5" />
    },
    {
      name: "HoverCode QRs",
      href: "/platform-admin/hovercode",
      icon: <QrCode className="w-5 h-5" />
    },
    {
      name: "Database",
      href: "/platform-admin/database",
      icon: <Database className="w-5 h-5" />
    },
    {
      name: "Settings",
      href: "/platform-admin/settings",
      icon: <Settings className="w-5 h-5" />
    }
  ];

  const handleNavClick = () => {
    if (isMobile && onClose) {
      onClose();
    }
  };

  return (
    <aside className={`bg-slate-900 flex flex-col ${isMobile ? 'w-full h-full' : 'w-64 min-h-screen'}`}>
      <div className="p-4 border-b border-slate-700">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-purple-600 rounded-lg flex items-center justify-center">
              <Shield className="w-6 h-6 text-white" />
            </div>
            <div>
              <h1 className="text-white font-bold">MOS Admin</h1>
              <p className="text-slate-400 text-xs">Platform Management</p>
            </div>
          </div>
          {isMobile && onClose && (
            <button
              onClick={onClose}
              className="p-2 text-slate-400 hover:text-white hover:bg-slate-800 rounded-lg transition-colors"
              aria-label="Close menu"
            >
              <X className="w-6 h-6" />
            </button>
          )}
        </div>
      </div>

      <nav className="flex-1 p-4">
        <ul className="space-y-1">
          {navItems.map((item) => (
            <li key={item.name}>
              <Link
                href={item.href}
                onClick={handleNavClick}
                className={`flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors ${
                  isActive(item.href)
                    ? "bg-purple-600 text-white"
                    : "text-slate-300 hover:bg-slate-800 hover:text-white"
                }`}
              >
                {item.icon}
                <span>{item.name}</span>
              </Link>
            </li>
          ))}
        </ul>
      </nav>

      <div className="p-4 border-t border-slate-700">
        <div className="flex items-center gap-3 mb-3">
          <div className="w-8 h-8 rounded-full bg-purple-600 flex items-center justify-center text-white text-sm font-medium">
            {userEmail?.charAt(0).toUpperCase() || "A"}
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium text-white truncate">{userEmail || "Admin"}</p>
            <p className="text-xs text-slate-400">Platform Admin</p>
          </div>
        </div>
        <Link
          href="/dashboard"
          className="flex items-center gap-2 text-slate-400 hover:text-white text-sm transition-colors"
        >
          <LogOut className="w-4 h-4" />
          <span>Back to Dashboard</span>
        </Link>
      </div>
    </aside>
  );
}
