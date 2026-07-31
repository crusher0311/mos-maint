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
  FileSearch,
  ClipboardCheck,
  KeyRound,
  MessageSquare,
  Voicemail,
  Phone,
  Database,
  Wrench,
  Headphones,
  Clock,
  MessageCircle,
  HeartPulse,
  ScrollText,
  CreditCard,
  Printer,
  Boxes,
  GraduationCap,
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

  const [commsExpanded, setCommsExpanded] = useState(false);
  const [enterprisesExpanded, setEnterprisesExpanded] = useState(false);
  const [shopsExpanded, setShopsExpanded] = useState(false);
  const [ticketsExpanded, setTicketsExpanded] = useState(false);
  const [settingsExpanded, setSettingsExpanded] = useState(false);

  const isCommsSection = ["/platform-admin/conversations", "/platform-admin/voicemails", "/platform-admin/call-logs", "/platform-admin/phone-numbers", "/platform-admin/time-tracking", "/platform-admin/call-dashboard", "/platform-admin/canned-messages"].some(p => pathname?.startsWith(p));
  const isEnterprisesSection = ["/platform-admin/enterprises", "/platform-admin/shops", "/platform-admin/users", "/platform-admin/hovercode"].some(p => pathname?.startsWith(p));
  const isShopsSection = ["/platform-admin/shops", "/platform-admin/users", "/platform-admin/hovercode"].some(p => pathname?.startsWith(p));
  const isTicketsSection = ["/platform-admin/tickets", "/platform-admin/cobrowse", "/platform-admin/database"].some(p => pathname?.startsWith(p));
  const isSettingsSection = ["/platform-admin/settings", "/platform-admin/announcements", "/platform-admin/features", "/platform-admin/plan-features", "/platform-admin/service-mappings", "/platform-admin/engine-risk-overrides"].some(p => pathname?.startsWith(p));

  useEffect(() => {
    if (isCommsSection) setCommsExpanded(true);
    if (isEnterprisesSection) setEnterprisesExpanded(true);
    if (isShopsSection) setShopsExpanded(true);
    if (isTicketsSection) setTicketsExpanded(true);
    if (isSettingsSection) setSettingsExpanded(true);
  }, [isCommsSection, isEnterprisesSection, isShopsSection, isTicketsSection, isSettingsSection]);

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

  const NavLink = ({ href, icon: Icon, label, indent = false, badge }: { href: string; icon: any; label: string; indent?: boolean; badge?: number }) => (
    <li>
      <Link href={href} onClick={handleNavClick}
        className={`flex items-center gap-2 px-3 ${indent ? "py-2" : "py-2.5"} rounded-lg text-sm ${indent ? "" : "font-medium"} transition-colors ${
          isActive(href) ? activeClass : indent ? inactiveClass : sectionInactiveClass
        }`}>
        <Icon className={`${indent ? "w-4 h-4" : "w-5 h-5"}`} />
        <span className="flex-1">{label}</span>
        {badge !== undefined && badge > 0 && (
          <span className="px-2 py-0.5 text-xs font-bold bg-red-500 text-white rounded-full min-w-[20px] text-center">
            {badge > 99 ? "99+" : badge}
          </span>
        )}
      </Link>
    </li>
  );

  const CollapsibleSection = ({
    label, icon: Icon, expanded, onToggle, isSection, children
  }: {
    label: string; icon: any; expanded: boolean; onToggle: () => void; isSection: boolean; children: React.ReactNode
  }) => (
    <li>
      <button onClick={onToggle}
        className={`w-full flex items-center justify-between px-3 py-2.5 rounded-lg text-sm font-medium transition-colors ${
          isSection ? sectionActiveClass : sectionInactiveClass
        }`}
        style={isSection ? { backgroundColor: 'rgba(60, 129, 195, 0.2)' } : undefined}>
        <div className="flex items-center gap-3">
          <Icon className="w-5 h-5" />
          <span>{label}</span>
        </div>
        {expanded ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
      </button>
      {expanded && (
        <ul className="ml-4 mt-1 space-y-1">
          {children}
        </ul>
      )}
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

      <nav className="flex-1 p-4 pt-2 overflow-y-auto">
        <ul className="space-y-1">
          <NavLink href="/platform-admin" icon={LayoutDashboard} label="Overview" />

          <CollapsibleSection label="Communications" icon={MessageSquare} expanded={commsExpanded} onToggle={() => setCommsExpanded(!commsExpanded)} isSection={isCommsSection}>
            <NavLink href="/platform-admin/conversations" icon={MessageSquare} label="Conversations" indent />
            <NavLink href="/platform-admin/voicemails" icon={Voicemail} label="Voicemails" indent />
            <NavLink href="/platform-admin/call-logs" icon={Phone} label="Call Logs" indent />
            <NavLink href="/platform-admin/phone-numbers" icon={Phone} label="Phone Numbers" indent />
            <NavLink href="/platform-admin/time-tracking" icon={Clock} label="Time Tracking" indent />
            <NavLink href="/platform-admin/call-dashboard" icon={Headphones} label="Call Dashboard" indent />
            <NavLink href="/platform-admin/canned-messages" icon={MessageCircle} label="Canned Messages" indent />
          </CollapsibleSection>

          <CollapsibleSection label="Enterprises" icon={Shield} expanded={enterprisesExpanded} onToggle={() => setEnterprisesExpanded(!enterprisesExpanded)} isSection={isEnterprisesSection}>
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
                  <NavLink href="/platform-admin/autoflow-numbers" icon={Building2} label="AutoFlow v4 Numbers" indent />
                </ul>
              )}
            </li>
          </CollapsibleSection>

          <NavLink href="/platform-admin/billing" icon={CreditCard} label="Billing" />
          <NavLink href="/platform-admin/client-health" icon={HeartPulse} label="Client Health" />
          <NavLink href="/platform-admin/sync-health" icon={Activity} label="Sync Health" />
          <NavLink href="/platform-admin/queues" icon={Boxes} label="Backfill Queue" />
          <NavLink href="/platform-admin/zink-print" icon={Printer} label="ZINK Print" />
          <NavLink href="/platform-admin/tekmetric-webhook-health" icon={Activity} label="Tek Webhook Health" />
          <NavLink href="/platform-admin/dvi-links" icon={ClipboardCheck} label="DVI Links" />
          <NavLink href="/platform-admin/concern-skip-stats" icon={MessageCircle} label="Concern Skip Stats" />
          <NavLink href="/platform-admin/tekmetric-migrations" icon={ArrowRightLeft} label="Tek Migrations" />
          <NavLink href="/platform-admin/api-usage" icon={Activity} label="API Traffic" />
          <NavLink href="/platform-admin/partner-keys" icon={KeyRound} label="Partner Keys" />
          <NavLink href="/platform-admin/job-analytics" icon={BarChart3} label="Job Analytics" />
          <NavLink href="/platform-admin/vhi-analytics" icon={BarChart3} label="VHI Analytics" />
          <NavLink href="/platform-admin/render" icon={FileText} label="Render Logs" />
          <NavLink href="/platform-admin/logs" icon={ScrollText} label="Production Logs" />

          <CollapsibleSection label="Support Tickets" icon={Ticket} expanded={ticketsExpanded} onToggle={() => setTicketsExpanded(!ticketsExpanded)} isSection={isTicketsSection}>
            <NavLink href="/platform-admin/tickets" icon={Ticket} label="All Tickets" indent badge={openTicketCount} />
            <NavLink href="/platform-admin/tickets/reports" icon={BarChart3} label="Reports" indent />
            <NavLink href="/platform-admin/cobrowse" icon={Monitor} label="Remote Support" indent />
            <NavLink href="/platform-admin/database" icon={Database} label="Database" indent />
          </CollapsibleSection>

          <NavLink href="/platform-admin/knowledge-base" icon={BookOpen} label="Knowledge Base" />
          <NavLink href="/platform-admin/sales-coach" icon={GraduationCap} label="Sales Coach" />

          <CollapsibleSection label="Settings" icon={Settings} expanded={settingsExpanded} onToggle={() => setSettingsExpanded(!settingsExpanded)} isSection={isSettingsSection}>
            <NavLink href="/platform-admin/settings" icon={Settings} label="General" indent />
            <NavLink href="/platform-admin/announcements" icon={Megaphone} label="Announcements" indent />
            <NavLink href="/platform-admin/features" icon={Package} label="Features" indent />
            <NavLink href="/platform-admin/plan-features" icon={Grid3X3} label="Plan Features" indent />
            <NavLink href="/platform-admin/service-mappings" icon={ArrowRightLeft} label="Service Mappings" indent />
            <NavLink href="/platform-admin/carfax-match" icon={FileSearch} label="CARFAX Match" indent />
            <NavLink href="/platform-admin/interval-import-match" icon={FileSearch} label="Interval Import Match" indent />
            <NavLink href="/platform-admin/engine-risk-overrides" icon={Wrench} label="Engine Risk Overrides" indent />
          </CollapsibleSection>
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
