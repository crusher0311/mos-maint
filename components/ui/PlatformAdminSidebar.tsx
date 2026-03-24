"use client";

import Link from "next/link";
import Image from "next/image";
import { usePathname } from "next/navigation";
import { useState, useEffect } from "react";
import { 
  Building2, 
  Users, 
  LayoutDashboard,
  LogOut,
  Shield,
  Settings,
  QrCode,
  Activity,
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
  ArrowRightLeft,
  KeyRound,
  MessageSquare,
  Voicemail,
  Phone,
  Bot,
  Network,
  Store,
  MapPin,
  Database,
  Wrench,
  Headphones,
  Clock,
  MessageCircle,
  ClipboardList,
  Navigation,
  Flag,
  Link2
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
  const [crmExpanded, setCrmExpanded] = useState(false);
  const [opsExpanded, setOpsExpanded] = useState(false);
  const [commsExpanded, setCommsExpanded] = useState(false);
  const [enterprisesExpanded, setEnterprisesExpanded] = useState(false);
  const [shopsExpanded, setShopsExpanded] = useState(false);
  const [ticketsExpanded, setTicketsExpanded] = useState(false);
  const [settingsExpanded, setSettingsExpanded] = useState(false);

  const crmPaths = [
    "/platform-admin/crm",
    "/platform-admin/conversations",
    "/platform-admin/voicemails",
    "/platform-admin/call-logs",
    "/platform-admin/rescue-rover",
    "/platform-admin/phone-numbers",
    "/platform-admin/agent-groups",
    "/platform-admin/time-tracking",
    "/platform-admin/call-dashboard",
    "/platform-admin/canned-messages",
    "/platform-admin/onboarding",
    "/platform-admin/tours",
    "/platform-admin/guides",
    "/platform-admin/banners",
    "/platform-admin/content-assignments",
  ];
  const opsPaths = [
    "/platform-admin/enterprises",
    "/platform-admin/shops",
    "/platform-admin/users",
    "/platform-admin/hovercode",
    "/platform-admin/api-usage",
    "/platform-admin/partner-keys",
    "/platform-admin/job-analytics",
    "/platform-admin/render",
    "/platform-admin/tickets",
    "/platform-admin/cobrowse",
    "/platform-admin/database",
    "/platform-admin/knowledge-base",
    "/platform-admin/settings",
    "/platform-admin/announcements",
    "/platform-admin/features",
    "/platform-admin/plan-features",
    "/platform-admin/service-mappings",
  ];

  const isCrmSection = crmPaths.some(p => pathname?.startsWith(p));
  const isOpsSection = opsPaths.some(p => pathname?.startsWith(p));
  const isCommsSection = ["/platform-admin/conversations", "/platform-admin/voicemails", "/platform-admin/call-logs", "/platform-admin/rescue-rover", "/platform-admin/phone-numbers", "/platform-admin/agent-groups", "/platform-admin/time-tracking", "/platform-admin/call-dashboard", "/platform-admin/canned-messages"].some(p => pathname?.startsWith(p));
  const isEnterprisesSection = ["/platform-admin/enterprises", "/platform-admin/shops", "/platform-admin/users", "/platform-admin/hovercode"].some(p => pathname?.startsWith(p));
  const isShopsSection = ["/platform-admin/shops", "/platform-admin/users", "/platform-admin/hovercode"].some(p => pathname?.startsWith(p));
  const isTicketsSection = ["/platform-admin/tickets", "/platform-admin/cobrowse", "/platform-admin/database"].some(p => pathname?.startsWith(p));
  const isSettingsSection = ["/platform-admin/settings", "/platform-admin/announcements", "/platform-admin/features", "/platform-admin/plan-features", "/platform-admin/service-mappings"].some(p => pathname?.startsWith(p));

  useEffect(() => {
    if (isCrmSection) setCrmExpanded(true);
    if (isOpsSection) setOpsExpanded(true);
    if (isCommsSection) setCommsExpanded(true);
    if (isEnterprisesSection) setEnterprisesExpanded(true);
    if (isShopsSection) setShopsExpanded(true);
    if (isTicketsSection) setTicketsExpanded(true);
    if (isSettingsSection) setSettingsExpanded(true);
  }, [isCrmSection, isOpsSection, isCommsSection, isEnterprisesSection, isShopsSection, isTicketsSection, isSettingsSection]);

  useEffect(() => {
    const fetchTicketCount = async () => {
      try {
        const res = await fetch("/api/platform-admin/tickets/count");
        const data = await res.json();
        if (data.ok) setOpenTicketCount(data.openCount);
      } catch (error) {
        console.error("Error fetching ticket count:", error);
      }
    };
    fetchTicketCount();
    const interval = setInterval(fetchTicketCount, 15000);
    return () => clearInterval(interval);
  }, []);

  const isActive = (href: string) => pathname === href;

  const handleNavClick = () => {
    if (isMobile && onClose) onClose();
  };

  const activeClass = "bg-[rgba(60,129,195,0.75)] text-white";
  const inactiveClass = "text-slate-400 hover:bg-slate-800 hover:text-white";
  const sectionActiveClass = "text-[#7ab3e0]";
  const sectionInactiveClass = "text-slate-300 hover:bg-slate-800 hover:text-white";

  const NavLink = ({ href, icon: Icon, label, indent = false }: { href: string; icon: any; label: string; indent?: boolean }) => (
    <li>
      <Link href={href} onClick={handleNavClick}
        className={`flex items-center gap-2 px-3 ${indent ? "py-2" : "py-2.5"} rounded-lg text-sm ${indent ? "" : "font-medium"} transition-colors ${
          isActive(href) ? activeClass : indent ? inactiveClass : sectionInactiveClass
        }`}>
        <Icon className={`${indent ? "w-4 h-4" : "w-5 h-5"}`} />
        <span>{label}</span>
      </Link>
    </li>
  );

  return (
    <aside className={`bg-slate-900 flex flex-col ${isMobile ? 'w-full h-full' : 'w-64 h-screen sticky top-0'}`}>
      <div className="p-4 border-b border-slate-700">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Image src="/mos-logo.png" alt="MOS Tools" width={40} height={40} className="rounded-lg" />
            <div>
              <h1 className="text-white font-bold">MOS Admin</h1>
              <p className="text-slate-400 text-xs">Platform Management</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <NotificationBell isPlatformAdmin={true} />
            {isMobile && onClose && (
              <button onClick={onClose} className="p-2 text-slate-400 hover:text-white hover:bg-slate-800 rounded-lg transition-colors" aria-label="Close menu">
                <X className="w-6 h-6" />
              </button>
            )}
          </div>
        </div>
      </div>

      <nav className="flex-1 p-4 overflow-y-auto">
        <ul className="space-y-1">
          <NavLink href="/platform-admin" icon={LayoutDashboard} label="Overview" />

          {/* ─── CRM Section ─── */}
          <li>
            <div className="mt-4 mb-1 px-3 text-[10px] font-bold uppercase tracking-widest text-slate-500">CRM</div>
          </li>
          <li>
            <button onClick={() => setCrmExpanded(!crmExpanded)}
              className={`w-full flex items-center justify-between px-3 py-2.5 rounded-lg text-sm font-medium transition-colors ${
                isCrmSection && !isCommsSection ? sectionActiveClass : sectionInactiveClass
              }`}
              style={isCrmSection && !isCommsSection ? { backgroundColor: 'rgba(60, 129, 195, 0.2)' } : undefined}>
              <div className="flex items-center gap-3">
                <Store className="w-5 h-5" />
                <span>Account Hierarchy</span>
              </div>
              {crmExpanded ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
            </button>
            {crmExpanded && (
              <ul className="ml-4 mt-1 space-y-1">
                <NavLink href="/platform-admin/crm/agencies" icon={Building2} label="Agencies" indent />
                <NavLink href="/platform-admin/crm/parent-orgs" icon={Network} label="Parent Orgs" indent />
                <NavLink href="/platform-admin/crm/accounts" icon={Store} label="Accounts" indent />
                <NavLink href="/platform-admin/crm/locations" icon={MapPin} label="Locations" indent />
                <NavLink href="/platform-admin/crm/user-types" icon={Users} label="User Types" indent />
              </ul>
            )}
          </li>

          {/* Communications under CRM */}
          <li>
            <button onClick={() => setCommsExpanded(!commsExpanded)}
              className={`w-full flex items-center justify-between px-3 py-2.5 rounded-lg text-sm font-medium transition-colors ${
                isCommsSection ? sectionActiveClass : sectionInactiveClass
              }`}
              style={isCommsSection ? { backgroundColor: 'rgba(60, 129, 195, 0.2)' } : undefined}>
              <div className="flex items-center gap-3">
                <MessageSquare className="w-5 h-5" />
                <span>Communications</span>
              </div>
              {commsExpanded ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
            </button>
            {commsExpanded && (
              <ul className="ml-4 mt-1 space-y-1">
                <NavLink href="/platform-admin/conversations" icon={MessageSquare} label="Conversations" indent />
                <NavLink href="/platform-admin/voicemails" icon={Voicemail} label="Voicemails" indent />
                <NavLink href="/platform-admin/call-logs" icon={Phone} label="Call Logs" indent />
                <NavLink href="/platform-admin/rescue-rover" icon={Bot} label="Rescue Rover" indent />
                <NavLink href="/platform-admin/phone-numbers" icon={Phone} label="Phone Numbers" indent />
                <NavLink href="/platform-admin/agent-groups" icon={Users} label="Agent Groups" indent />
                <NavLink href="/platform-admin/time-tracking" icon={Clock} label="Time Tracking" indent />
                <NavLink href="/platform-admin/call-dashboard" icon={Headphones} label="Call Dashboard" indent />
                <NavLink href="/platform-admin/canned-messages" icon={MessageCircle} label="Canned Messages" indent />
              </ul>
            )}
          </li>

          <NavLink href="/platform-admin/onboarding" icon={ClipboardList} label="Onboarding Board" />
          <NavLink href="/platform-admin/onboarding/stages" icon={ClipboardList} label="Stages" />
          <NavLink href="/platform-admin/tours" icon={Navigation} label="Tours" />
          <NavLink href="/platform-admin/guides" icon={BookOpen} label="Guides" />
          <NavLink href="/platform-admin/banners" icon={Flag} label="Banners" />
          <NavLink href="/platform-admin/content-assignments" icon={Link2} label="Content Assignments" />

          {/* ─── OPS Section ─── */}
          <li>
            <div className="mt-4 mb-1 px-3 text-[10px] font-bold uppercase tracking-widest text-slate-500">OPS</div>
          </li>

          {/* Enterprises with Shops submenu */}
          <li>
            <button onClick={() => setEnterprisesExpanded(!enterprisesExpanded)}
              className={`w-full flex items-center justify-between px-3 py-2.5 rounded-lg text-sm font-medium transition-colors ${
                isEnterprisesSection ? sectionActiveClass : sectionInactiveClass
              }`}
              style={isEnterprisesSection ? { backgroundColor: 'rgba(60, 129, 195, 0.2)' } : undefined}>
              <div className="flex items-center gap-3">
                <Shield className="w-5 h-5" />
                <span>Enterprises</span>
              </div>
              {enterprisesExpanded ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
            </button>
            {enterprisesExpanded && (
              <ul className="ml-4 mt-1 space-y-1">
                <NavLink href="/platform-admin/enterprises" icon={Shield} label="All Enterprises" indent />
                <li>
                  <button onClick={() => setShopsExpanded(!shopsExpanded)}
                    className={`w-full flex items-center justify-between px-3 py-2 rounded-lg text-sm transition-colors ${
                      isShopsSection ? sectionActiveClass : inactiveClass
                    }`}
                    style={isShopsSection ? { backgroundColor: 'rgba(60, 129, 195, 0.15)' } : undefined}>
                    <div className="flex items-center gap-2">
                      <Building2 className="w-4 h-4" />
                      <span>Shops</span>
                    </div>
                    {shopsExpanded ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
                  </button>
                  {shopsExpanded && (
                    <ul className="ml-4 mt-1 space-y-1">
                      <NavLink href="/platform-admin/shops" icon={Building2} label="All Shops" indent />
                      <NavLink href="/platform-admin/users" icon={Users} label="Users" indent />
                      <NavLink href="/platform-admin/hovercode" icon={QrCode} label="HoverCode QRs" indent />
                    </ul>
                  )}
                </li>
              </ul>
            )}
          </li>

          <NavLink href="/platform-admin/api-usage" icon={Activity} label="API Traffic" />
          <NavLink href="/platform-admin/partner-keys" icon={KeyRound} label="Partner Keys" />
          <NavLink href="/platform-admin/job-analytics" icon={BarChart3} label="Job Analytics" />
          <NavLink href="/platform-admin/render" icon={FileText} label="Render Logs" />

          {/* Support Tickets */}
          <li>
            <button onClick={() => setTicketsExpanded(!ticketsExpanded)}
              className={`w-full flex items-center justify-between px-3 py-2.5 rounded-lg text-sm font-medium transition-colors ${
                isTicketsSection ? sectionActiveClass : sectionInactiveClass
              }`}
              style={isTicketsSection ? { backgroundColor: 'rgba(60, 129, 195, 0.2)' } : undefined}>
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
                {ticketsExpanded ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
              </div>
            </button>
            {ticketsExpanded && (
              <ul className="ml-4 mt-1 space-y-1">
                <NavLink href="/platform-admin/tickets" icon={Ticket} label="All Tickets" indent />
                <NavLink href="/platform-admin/tickets/reports" icon={BarChart3} label="Reports" indent />
                <NavLink href="/platform-admin/cobrowse" icon={Monitor} label="Remote Support" indent />
                <NavLink href="/platform-admin/database" icon={Database} label="Database" indent />
              </ul>
            )}
          </li>

          <NavLink href="/platform-admin/knowledge-base" icon={BookOpen} label="Knowledge Base" />

          {/* Settings */}
          <li>
            <button onClick={() => setSettingsExpanded(!settingsExpanded)}
              className={`w-full flex items-center justify-between px-3 py-2.5 rounded-lg text-sm font-medium transition-colors ${
                isSettingsSection ? sectionActiveClass : sectionInactiveClass
              }`}
              style={isSettingsSection ? { backgroundColor: 'rgba(60, 129, 195, 0.2)' } : undefined}>
              <div className="flex items-center gap-3">
                <Settings className="w-5 h-5" />
                <span>Settings</span>
              </div>
              {settingsExpanded ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
            </button>
            {settingsExpanded && (
              <ul className="ml-4 mt-1 space-y-1">
                <NavLink href="/platform-admin/settings" icon={Settings} label="General" indent />
                <NavLink href="/platform-admin/announcements" icon={Megaphone} label="Announcements" indent />
                <NavLink href="/platform-admin/features" icon={Package} label="Features" indent />
                <NavLink href="/platform-admin/plan-features" icon={Grid3X3} label="Plan Features" indent />
                <NavLink href="/platform-admin/service-mappings" icon={ArrowRightLeft} label="Service Mappings" indent />
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
        <Link href="/dashboard" className="flex items-center gap-2 text-slate-400 hover:text-white text-sm transition-colors">
          <LogOut className="w-4 h-4" />
          <span>Back to Dashboard</span>
        </Link>
      </div>
    </aside>
  );
}
