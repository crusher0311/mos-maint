"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState, useEffect } from "react";
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
  Ticket,
  BarChart3,
  ChevronDown,
  ChevronRight,
  Monitor,
  X,
  Package,
  Grid3X3,
  Megaphone
} from "lucide-react";
import { NotificationBell } from "./NotificationBell";

interface PlatformAdminSidebarProps {
  userEmail?: string;
  isMobile?: boolean;
  onClose?: () => void;
}

export function PlatformAdminSidebar({ userEmail, isMobile, onClose }: PlatformAdminSidebarProps) {
  const pathname = usePathname();
  const [openTicketCount, setOpenTicketCount] = useState(0);
  const [ticketsExpanded, setTicketsExpanded] = useState(false);
  const [settingsExpanded, setSettingsExpanded] = useState(false);

  const isTicketsSection = pathname?.startsWith("/platform-admin/tickets");
  const isSettingsSection = pathname?.startsWith("/platform-admin/settings") || pathname?.startsWith("/platform-admin/announcements");

  useEffect(() => {
    if (isTicketsSection) {
      setTicketsExpanded(true);
    }
    if (isSettingsSection) {
      setSettingsExpanded(true);
    }
  }, [isTicketsSection, isSettingsSection]);

  useEffect(() => {
    const fetchTicketCount = async () => {
      try {
        const res = await fetch("/api/platform-admin/tickets/count");
        const data = await res.json();
        if (data.ok) {
          setOpenTicketCount(data.openCount);
        }
      } catch (error) {
        console.error("Error fetching ticket count:", error);
      }
    };

    fetchTicketCount();
    const interval = setInterval(fetchTicketCount, 15000);
    return () => clearInterval(interval);
  }, []);

  const isActive = (href: string) => {
    return pathname === href;
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
      name: "Features",
      href: "/platform-admin/features",
      icon: <Package className="w-5 h-5" />
    },
    {
      name: "Plan Features",
      href: "/platform-admin/plan-features",
      icon: <Grid3X3 className="w-5 h-5" />
    }
  ];

  const settingsSubItems = [
    { name: "General", href: "/platform-admin/settings", icon: Settings },
    { name: "Announcements", href: "/platform-admin/announcements", icon: Megaphone }
  ];

  const ticketSubItems = [
    { name: "All Tickets", href: "/platform-admin/tickets" },
    { name: "Reports", href: "/platform-admin/tickets/reports" },
    { name: "Remote Support", href: "/platform-admin/cobrowse" }
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
          <div className="flex items-center gap-2">
            <NotificationBell isPlatformAdmin={true} />
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
      </div>

      <nav className="flex-1 p-4">
        <ul className="space-y-1">
          {navItems.slice(0, 8).map((item) => (
            <li key={item.name}>
              <Link
                href={item.href}
                onClick={handleNavClick}
                className={`flex items-center justify-between px-3 py-2.5 rounded-lg text-sm font-medium transition-colors ${
                  isActive(item.href)
                    ? "bg-purple-600 text-white"
                    : "text-slate-300 hover:bg-slate-800 hover:text-white"
                }`}
              >
                <div className="flex items-center gap-3">
                  {item.icon}
                  <span>{item.name}</span>
                </div>
              </Link>
            </li>
          ))}

          <li>
            <button
              onClick={() => setTicketsExpanded(!ticketsExpanded)}
              className={`w-full flex items-center justify-between px-3 py-2.5 rounded-lg text-sm font-medium transition-colors ${
                isTicketsSection
                  ? "bg-purple-600/20 text-purple-300"
                  : "text-slate-300 hover:bg-slate-800 hover:text-white"
              }`}
            >
              <div className="flex items-center gap-3">
                <Ticket className="w-5 h-5" />
                <span>Support Tickets</span>
              </div>
              <div className="flex items-center gap-2">
                {openTicketCount > 0 && (
                  <span className="px-2 py-0.5 text-xs font-bold bg-red-500 text-white rounded-full min-w-[20px] text-center">
                    {openTicketCount > 99 ? "99+" : openTicketCount}
                  </span>
                )}
                {ticketsExpanded ? (
                  <ChevronDown className="w-4 h-4" />
                ) : (
                  <ChevronRight className="w-4 h-4" />
                )}
              </div>
            </button>
            {ticketsExpanded && (
              <ul className="ml-8 mt-1 space-y-1">
                {ticketSubItems.map((subItem) => (
                  <li key={subItem.name}>
                    <Link
                      href={subItem.href}
                      onClick={handleNavClick}
                      className={`flex items-center gap-2 px-3 py-2 rounded-lg text-sm transition-colors ${
                        isActive(subItem.href)
                          ? "bg-purple-600 text-white"
                          : "text-slate-400 hover:bg-slate-800 hover:text-white"
                      }`}
                    >
                      {subItem.name === "Reports" ? (
                        <BarChart3 className="w-4 h-4" />
                      ) : subItem.name === "Remote Support" ? (
                        <Monitor className="w-4 h-4" />
                      ) : (
                        <Ticket className="w-4 h-4" />
                      )}
                      <span>{subItem.name}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </li>

          {/* Settings Submenu */}
          <li>
            <button
              onClick={() => setSettingsExpanded(!settingsExpanded)}
              className={`w-full flex items-center justify-between px-3 py-2.5 rounded-lg text-sm font-medium transition-colors ${
                isSettingsSection
                  ? "bg-purple-600/20 text-purple-300"
                  : "text-slate-300 hover:bg-slate-800 hover:text-white"
              }`}
            >
              <div className="flex items-center gap-3">
                <Settings className="w-5 h-5" />
                <span>Settings</span>
              </div>
              {settingsExpanded ? (
                <ChevronDown className="w-4 h-4" />
              ) : (
                <ChevronRight className="w-4 h-4" />
              )}
            </button>
            {settingsExpanded && (
              <ul className="ml-8 mt-1 space-y-1">
                {settingsSubItems.map((subItem) => {
                  const Icon = subItem.icon;
                  return (
                    <li key={subItem.name}>
                      <Link
                        href={subItem.href}
                        onClick={handleNavClick}
                        className={`flex items-center gap-2 px-3 py-2 rounded-lg text-sm transition-colors ${
                          isActive(subItem.href)
                            ? "bg-purple-600 text-white"
                            : "text-slate-400 hover:bg-slate-800 hover:text-white"
                        }`}
                      >
                        <Icon className="w-4 h-4" />
                        <span>{subItem.name}</span>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            )}
          </li>

          {navItems.slice(8).map((item) => (
            <li key={item.name}>
              <Link
                href={item.href}
                onClick={handleNavClick}
                className={`flex items-center justify-between px-3 py-2.5 rounded-lg text-sm font-medium transition-colors ${
                  isActive(item.href)
                    ? "bg-purple-600 text-white"
                    : "text-slate-300 hover:bg-slate-800 hover:text-white"
                }`}
              >
                <div className="flex items-center gap-3">
                  {item.icon}
                  <span>{item.name}</span>
                </div>
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
