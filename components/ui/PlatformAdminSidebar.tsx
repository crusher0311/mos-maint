"use client";

import Link from "next/link";
import Image from "next/image";
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
  Megaphone,
  BookOpen,
  ArrowRightLeft
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
  const [enterprisesExpanded, setEnterprisesExpanded] = useState(false);
  const [shopsExpanded, setShopsExpanded] = useState(false);

  const isTicketsSection = pathname?.startsWith("/platform-admin/tickets") || 
                           pathname?.startsWith("/platform-admin/cobrowse") ||
                           pathname?.startsWith("/platform-admin/database");
  const isSettingsSection = pathname?.startsWith("/platform-admin/settings") || 
                            pathname?.startsWith("/platform-admin/announcements") ||
                            pathname?.startsWith("/platform-admin/features") ||
                            pathname?.startsWith("/platform-admin/plan-features") ||
                            pathname?.startsWith("/platform-admin/service-mappings");
  const isEnterprisesSection = pathname?.startsWith("/platform-admin/enterprises") ||
                               pathname?.startsWith("/platform-admin/shops") ||
                               pathname?.startsWith("/platform-admin/users") ||
                               pathname?.startsWith("/platform-admin/hovercode");
  const isShopsSection = pathname?.startsWith("/platform-admin/shops") ||
                         pathname?.startsWith("/platform-admin/users") ||
                         pathname?.startsWith("/platform-admin/hovercode");

  useEffect(() => {
    if (isTicketsSection) setTicketsExpanded(true);
    if (isSettingsSection) setSettingsExpanded(true);
    if (isEnterprisesSection) setEnterprisesExpanded(true);
    if (isShopsSection) setShopsExpanded(true);
  }, [isTicketsSection, isSettingsSection, isEnterprisesSection, isShopsSection]);

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

  const handleNavClick = () => {
    if (isMobile && onClose) {
      onClose();
    }
  };

  return (
    <aside className={`bg-slate-900 flex flex-col ${isMobile ? 'w-full h-full' : 'w-64 h-screen sticky top-0'}`}>
      <div className="p-4 border-b border-slate-700">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Image 
              src="/mos-logo.png" 
              alt="MOS Tools" 
              width={40} 
              height={40} 
              className="rounded-lg"
            />
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

      <nav className="flex-1 p-4 overflow-y-auto">
        <ul className="space-y-1">
          {/* Overview */}
          <li>
            <Link
              href="/platform-admin"
              onClick={handleNavClick}
              className={`flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors ${
                isActive("/platform-admin")
                  ? "bg-[rgba(60,129,195,0.75)] text-white"
                  : "text-slate-300 hover:bg-slate-800 hover:text-white"
              }`}
            >
              <LayoutDashboard className="w-5 h-5" />
              <span>Overview</span>
            </Link>
          </li>

          {/* Enterprises with Shops submenu */}
          <li>
            <button
              onClick={() => setEnterprisesExpanded(!enterprisesExpanded)}
              className={`w-full flex items-center justify-between px-3 py-2.5 rounded-lg text-sm font-medium transition-colors ${
                isEnterprisesSection
                  ? "text-[#7ab3e0]"
                  : "text-slate-300 hover:bg-slate-800 hover:text-white"
              }`}
              style={isEnterprisesSection ? { backgroundColor: 'rgba(60, 129, 195, 0.2)' } : undefined}
            >
              <div className="flex items-center gap-3">
                <Shield className="w-5 h-5" />
                <span>Enterprises</span>
              </div>
              {enterprisesExpanded ? (
                <ChevronDown className="w-4 h-4" />
              ) : (
                <ChevronRight className="w-4 h-4" />
              )}
            </button>
            {enterprisesExpanded && (
              <ul className="ml-4 mt-1 space-y-1">
                <li>
                  <Link
                    href="/platform-admin/enterprises"
                    onClick={handleNavClick}
                    className={`flex items-center gap-2 px-3 py-2 rounded-lg text-sm transition-colors ${
                      isActive("/platform-admin/enterprises")
                        ? "bg-[rgba(60,129,195,0.75)] text-white"
                        : "text-slate-400 hover:bg-slate-800 hover:text-white"
                    }`}
                  >
                    <Shield className="w-4 h-4" />
                    <span>All Enterprises</span>
                  </Link>
                </li>
                {/* Shops submenu under Enterprises */}
                <li>
                  <button
                    onClick={() => setShopsExpanded(!shopsExpanded)}
                    className={`w-full flex items-center justify-between px-3 py-2 rounded-lg text-sm transition-colors ${
                      isShopsSection
                        ? "text-[#7ab3e0]"
                        : "text-slate-400 hover:bg-slate-800 hover:text-white"
                    }`}
                    style={isShopsSection ? { backgroundColor: 'rgba(60, 129, 195, 0.15)' } : undefined}
                  >
                    <div className="flex items-center gap-2">
                      <Building2 className="w-4 h-4" />
                      <span>Shops</span>
                    </div>
                    {shopsExpanded ? (
                      <ChevronDown className="w-4 h-4" />
                    ) : (
                      <ChevronRight className="w-4 h-4" />
                    )}
                  </button>
                  {shopsExpanded && (
                    <ul className="ml-4 mt-1 space-y-1">
                      <li>
                        <Link
                          href="/platform-admin/shops"
                          onClick={handleNavClick}
                          className={`flex items-center gap-2 px-3 py-2 rounded-lg text-sm transition-colors ${
                            isActive("/platform-admin/shops")
                              ? "bg-[rgba(60,129,195,0.75)] text-white"
                              : "text-slate-400 hover:bg-slate-800 hover:text-white"
                          }`}
                        >
                          <Building2 className="w-4 h-4" />
                          <span>All Shops</span>
                        </Link>
                      </li>
                      <li>
                        <Link
                          href="/platform-admin/users"
                          onClick={handleNavClick}
                          className={`flex items-center gap-2 px-3 py-2 rounded-lg text-sm transition-colors ${
                            isActive("/platform-admin/users")
                              ? "bg-[rgba(60,129,195,0.75)] text-white"
                              : "text-slate-400 hover:bg-slate-800 hover:text-white"
                          }`}
                        >
                          <Users className="w-4 h-4" />
                          <span>Users</span>
                        </Link>
                      </li>
                      <li>
                        <Link
                          href="/platform-admin/hovercode"
                          onClick={handleNavClick}
                          className={`flex items-center gap-2 px-3 py-2 rounded-lg text-sm transition-colors ${
                            isActive("/platform-admin/hovercode")
                              ? "bg-[rgba(60,129,195,0.75)] text-white"
                              : "text-slate-400 hover:bg-slate-800 hover:text-white"
                          }`}
                        >
                          <QrCode className="w-4 h-4" />
                          <span>HoverCode QRs</span>
                        </Link>
                      </li>
                    </ul>
                  )}
                </li>
              </ul>
            )}
          </li>

          {/* Usage & Costs */}
          <li>
            <Link
              href="/platform-admin/usage"
              onClick={handleNavClick}
              className={`flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors ${
                isActive("/platform-admin/usage")
                  ? "bg-[rgba(60,129,195,0.75)] text-white"
                  : "text-slate-300 hover:bg-slate-800 hover:text-white"
              }`}
            >
              <DollarSign className="w-5 h-5" />
              <span>Usage & Costs</span>
            </Link>
          </li>

          {/* Client Billing */}
          <li>
            <Link
              href="/platform-admin/billing"
              onClick={handleNavClick}
              className={`flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors ${
                isActive("/platform-admin/billing")
                  ? "bg-[rgba(60,129,195,0.75)] text-white"
                  : "text-slate-300 hover:bg-slate-800 hover:text-white"
              }`}
            >
              <CreditCard className="w-5 h-5" />
              <span>Client Billing</span>
            </Link>
          </li>

          {/* API Traffic */}
          <li>
            <Link
              href="/platform-admin/api-usage"
              onClick={handleNavClick}
              className={`flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors ${
                isActive("/platform-admin/api-usage")
                  ? "bg-[rgba(60,129,195,0.75)] text-white"
                  : "text-slate-300 hover:bg-slate-800 hover:text-white"
              }`}
            >
              <Activity className="w-5 h-5" />
              <span>API Traffic</span>
            </Link>
          </li>

          {/* Job Analytics */}
          <li>
            <Link
              href="/platform-admin/job-analytics"
              onClick={handleNavClick}
              className={`flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors ${
                isActive("/platform-admin/job-analytics")
                  ? "bg-[rgba(60,129,195,0.75)] text-white"
                  : "text-slate-300 hover:bg-slate-800 hover:text-white"
              }`}
            >
              <BarChart3 className="w-5 h-5" />
              <span>Job Analytics</span>
            </Link>
          </li>

          {/* Render Logs */}
          <li>
            <Link
              href="/platform-admin/render"
              onClick={handleNavClick}
              className={`flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors ${
                isActive("/platform-admin/render")
                  ? "bg-[rgba(60,129,195,0.75)] text-white"
                  : "text-slate-300 hover:bg-slate-800 hover:text-white"
              }`}
            >
              <FileText className="w-5 h-5" />
              <span>Render Logs</span>
            </Link>
          </li>

          {/* Support Tickets with Database */}
          <li>
            <button
              onClick={() => setTicketsExpanded(!ticketsExpanded)}
              className={`w-full flex items-center justify-between px-3 py-2.5 rounded-lg text-sm font-medium transition-colors ${
                isTicketsSection
                  ? "text-[#7ab3e0]"
                  : "text-slate-300 hover:bg-slate-800 hover:text-white"
              }`}
              style={isTicketsSection ? { backgroundColor: 'rgba(60, 129, 195, 0.2)' } : undefined}
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
                <li>
                  <Link
                    href="/platform-admin/tickets"
                    onClick={handleNavClick}
                    className={`flex items-center gap-2 px-3 py-2 rounded-lg text-sm transition-colors ${
                      isActive("/platform-admin/tickets")
                        ? "bg-[rgba(60,129,195,0.75)] text-white"
                        : "text-slate-400 hover:bg-slate-800 hover:text-white"
                    }`}
                  >
                    <Ticket className="w-4 h-4" />
                    <span>All Tickets</span>
                  </Link>
                </li>
                <li>
                  <Link
                    href="/platform-admin/tickets/reports"
                    onClick={handleNavClick}
                    className={`flex items-center gap-2 px-3 py-2 rounded-lg text-sm transition-colors ${
                      isActive("/platform-admin/tickets/reports")
                        ? "bg-[rgba(60,129,195,0.75)] text-white"
                        : "text-slate-400 hover:bg-slate-800 hover:text-white"
                    }`}
                  >
                    <BarChart3 className="w-4 h-4" />
                    <span>Reports</span>
                  </Link>
                </li>
                <li>
                  <Link
                    href="/platform-admin/cobrowse"
                    onClick={handleNavClick}
                    className={`flex items-center gap-2 px-3 py-2 rounded-lg text-sm transition-colors ${
                      isActive("/platform-admin/cobrowse")
                        ? "bg-[rgba(60,129,195,0.75)] text-white"
                        : "text-slate-400 hover:bg-slate-800 hover:text-white"
                    }`}
                  >
                    <Monitor className="w-4 h-4" />
                    <span>Remote Support</span>
                  </Link>
                </li>
                <li>
                  <Link
                    href="/platform-admin/database"
                    onClick={handleNavClick}
                    className={`flex items-center gap-2 px-3 py-2 rounded-lg text-sm transition-colors ${
                      isActive("/platform-admin/database")
                        ? "bg-[rgba(60,129,195,0.75)] text-white"
                        : "text-slate-400 hover:bg-slate-800 hover:text-white"
                    }`}
                  >
                    <Database className="w-4 h-4" />
                    <span>Database</span>
                  </Link>
                </li>
              </ul>
            )}
          </li>

          {/* Knowledge Base */}
          <li>
            <Link
              href="/platform-admin/knowledge-base"
              onClick={handleNavClick}
              className={`flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors ${
                isActive("/platform-admin/knowledge-base")
                  ? "bg-[rgba(60,129,195,0.75)] text-white"
                  : "text-slate-300 hover:bg-slate-800 hover:text-white"
              }`}
            >
              <BookOpen className="w-5 h-5" />
              <span>Knowledge Base</span>
            </Link>
          </li>

          {/* Settings with Features */}
          <li>
            <button
              onClick={() => setSettingsExpanded(!settingsExpanded)}
              className={`w-full flex items-center justify-between px-3 py-2.5 rounded-lg text-sm font-medium transition-colors ${
                isSettingsSection
                  ? "text-[#7ab3e0]"
                  : "text-slate-300 hover:bg-slate-800 hover:text-white"
              }`}
              style={isSettingsSection ? { backgroundColor: 'rgba(60, 129, 195, 0.2)' } : undefined}
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
                <li>
                  <Link
                    href="/platform-admin/settings"
                    onClick={handleNavClick}
                    className={`flex items-center gap-2 px-3 py-2 rounded-lg text-sm transition-colors ${
                      isActive("/platform-admin/settings")
                        ? "bg-[rgba(60,129,195,0.75)] text-white"
                        : "text-slate-400 hover:bg-slate-800 hover:text-white"
                    }`}
                  >
                    <Settings className="w-4 h-4" />
                    <span>General</span>
                  </Link>
                </li>
                <li>
                  <Link
                    href="/platform-admin/announcements"
                    onClick={handleNavClick}
                    className={`flex items-center gap-2 px-3 py-2 rounded-lg text-sm transition-colors ${
                      isActive("/platform-admin/announcements")
                        ? "bg-[rgba(60,129,195,0.75)] text-white"
                        : "text-slate-400 hover:bg-slate-800 hover:text-white"
                    }`}
                  >
                    <Megaphone className="w-4 h-4" />
                    <span>Announcements</span>
                  </Link>
                </li>
                <li>
                  <Link
                    href="/platform-admin/features"
                    onClick={handleNavClick}
                    className={`flex items-center gap-2 px-3 py-2 rounded-lg text-sm transition-colors ${
                      isActive("/platform-admin/features")
                        ? "bg-[rgba(60,129,195,0.75)] text-white"
                        : "text-slate-400 hover:bg-slate-800 hover:text-white"
                    }`}
                  >
                    <Package className="w-4 h-4" />
                    <span>Features</span>
                  </Link>
                </li>
                <li>
                  <Link
                    href="/platform-admin/plan-features"
                    onClick={handleNavClick}
                    className={`flex items-center gap-2 px-3 py-2 rounded-lg text-sm transition-colors ${
                      isActive("/platform-admin/plan-features")
                        ? "bg-[rgba(60,129,195,0.75)] text-white"
                        : "text-slate-400 hover:bg-slate-800 hover:text-white"
                    }`}
                  >
                    <Grid3X3 className="w-4 h-4" />
                    <span>Plan Features</span>
                  </Link>
                </li>
                <li>
                  <Link
                    href="/platform-admin/service-mappings"
                    onClick={handleNavClick}
                    className={`flex items-center gap-2 px-3 py-2 rounded-lg text-sm transition-colors ${
                      isActive("/platform-admin/service-mappings")
                        ? "bg-[rgba(60,129,195,0.75)] text-white"
                        : "text-slate-400 hover:bg-slate-800 hover:text-white"
                    }`}
                  >
                    <ArrowRightLeft className="w-4 h-4" />
                    <span>Service Mappings</span>
                  </Link>
                </li>
              </ul>
            )}
          </li>
        </ul>
      </nav>

      <div className="p-4 border-t border-slate-700">
        <div className="flex items-center gap-3 mb-3">
          <div className="w-8 h-8 rounded-full flex items-center justify-center text-white text-sm font-medium" style={{ backgroundColor: 'rgba(60, 129, 195, 0.75)' }}>
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
