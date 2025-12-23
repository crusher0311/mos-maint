"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { 
  Car, 
  Users, 
  Settings, 
  ChevronDown, 
  ChevronRight,
  LayoutDashboard,
  FileText,
  CreditCard,
  Wrench,
  ClipboardCheck,
  Puzzle,
  Workflow,
  Search,
  HelpCircle,
  Shield,
  DollarSign,
  Building2
} from "lucide-react";
import { PlanLauncher } from "./PlanLauncher";

interface NavItem {
  name: string;
  href: string;
  icon: React.ReactNode;
  children?: { name: string; href: string }[];
}

interface SidebarProps {
  shopName?: string;
  userEmail?: string;
  userRole?: string;
  userInitials?: string;
  isPlatformAdmin?: boolean;
}

export function Sidebar({ shopName = "My Shop", userEmail, userRole, userInitials = "MS", isPlatformAdmin }: SidebarProps) {
  const pathname = usePathname();
  const [expandedSections, setExpandedSections] = useState<Set<string>>(new Set(["Settings"]));
  const [searchQuery, setSearchQuery] = useState("");

  const toggleSection = (name: string) => {
    const newExpanded = new Set(expandedSections);
    if (newExpanded.has(name)) {
      newExpanded.delete(name);
    } else {
      newExpanded.add(name);
    }
    setExpandedSections(newExpanded);
  };

  const isActive = (href: string) => {
    return pathname === href || pathname?.startsWith(href + "/");
  };

  const navItems: NavItem[] = [
    {
      name: "Vehicles",
      href: "/dashboard",
      icon: <Car className="w-5 h-5" />
    },
    {
      name: "Customer Workflows",
      href: "/dashboard/workflows",
      icon: <Workflow className="w-5 h-5" />
    },
    {
      name: "Shop Onboarding",
      href: "/dashboard/onboarding",
      icon: <ClipboardCheck className="w-5 h-5" />
    },
    {
      name: "Settings",
      href: "/dashboard/settings",
      icon: <Settings className="w-5 h-5" />,
      children: [
        { name: "Configurations", href: "/dashboard/settings" },
        { name: "Billing", href: "/dashboard/settings/billing" },
        { name: "Users", href: "/dashboard/settings/users" },
        { name: "Maintenance Thresholds", href: "/dashboard/settings/maintenance" },
        { name: "Shop Intervals", href: "/dashboard/settings/intervals" },
        { name: "Inspection Maintenance", href: "/dashboard/settings/inspection" },
        { name: "Extension Abilities", href: "/dashboard/settings/extensions" },
        { name: "Customer Workflows", href: "/dashboard/settings/workflows" },
        { name: "Integrations", href: "/dashboard/settings/integrations" }
      ]
    }
  ];

  return (
    <aside className="w-64 bg-slate-900 min-h-screen flex flex-col">
      <div className="p-4 border-b border-slate-700">
        <button className="w-full flex items-center justify-between text-white hover:bg-slate-800 rounded-lg p-2 transition-colors">
          <span className="font-medium truncate">{shopName}</span>
          <ChevronDown className="w-4 h-4 text-slate-400" />
        </button>
      </div>

      <div className="p-4 space-y-3">
        <PlanLauncher />
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
          <input
            type="text"
            placeholder="Search"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full bg-slate-800 text-white placeholder-slate-400 rounded-lg py-2 pl-10 pr-4 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 border border-slate-700"
          />
        </div>
      </div>

      <nav className="flex-1 px-3 pb-4 overflow-y-auto">
        <ul className="space-y-1">
          {navItems.map((item) => (
            <li key={item.name}>
              {item.children ? (
                <div>
                  <button
                    onClick={() => toggleSection(item.name)}
                    className={`w-full flex items-center justify-between px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
                      isActive(item.href)
                        ? "bg-blue-600 text-white"
                        : "text-slate-300 hover:bg-slate-800 hover:text-white"
                    }`}
                  >
                    <div className="flex items-center gap-3">
                      {item.icon}
                      <span>{item.name}</span>
                    </div>
                    {expandedSections.has(item.name) ? (
                      <ChevronDown className="w-4 h-4" />
                    ) : (
                      <ChevronRight className="w-4 h-4" />
                    )}
                  </button>
                  {expandedSections.has(item.name) && (
                    <ul className="mt-1 ml-4 space-y-1 border-l border-slate-700 pl-4">
                      {item.children.map((child) => (
                        <li key={child.name}>
                          <Link
                            href={child.href}
                            className={`block px-3 py-2 rounded-lg text-sm transition-colors ${
                              isActive(child.href)
                                ? "bg-blue-600/20 text-blue-400 font-medium"
                                : "text-slate-400 hover:bg-slate-800 hover:text-white"
                            }`}
                          >
                            {child.name}
                          </Link>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              ) : (
                <Link
                  href={item.href}
                  className={`flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
                    isActive(item.href)
                      ? "bg-blue-600 text-white"
                      : "text-slate-300 hover:bg-slate-800 hover:text-white"
                  }`}
                >
                  {item.icon}
                  <span>{item.name}</span>
                </Link>
              )}
            </li>
          ))}
        </ul>
      </nav>

      {isPlatformAdmin && (
        <div className="px-3 pb-2">
          <Link
            href="/platform-admin"
            className="flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium bg-purple-600/20 text-purple-400 hover:bg-purple-600/30 transition-colors"
          >
            <Shield className="w-5 h-5" />
            <span>MOS Admin Panel</span>
          </Link>
        </div>
      )}

      <div className="p-4 border-t border-slate-700">
        <Link href="/dashboard/settings/users" className="flex items-center gap-3 hover:bg-slate-800 rounded-lg p-2 -m-2 transition-colors">
          <div className="w-8 h-8 rounded-full bg-blue-600 flex items-center justify-center text-white text-sm font-medium">
            {userInitials}
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium text-white truncate">{userEmail || "Account"}</p>
            {userRole && (
              <p className="text-xs text-slate-400 capitalize">{userRole}</p>
            )}
          </div>
          <button className="p-1.5 text-slate-400 hover:text-white rounded-lg hover:bg-slate-800 transition-colors">
            <HelpCircle className="w-5 h-5" />
          </button>
        </Link>
      </div>
    </aside>
  );
}
