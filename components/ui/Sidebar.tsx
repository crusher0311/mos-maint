"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useState, useEffect, useRef } from "react";
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
  Search,
  HelpCircle,
  Shield,
  DollarSign,
  Building2,
  Check,
  BarChart3,
  LogOut,
  RefreshCw
} from "lucide-react";
// import { PlanLauncher } from "./PlanLauncher"; // Hidden - replaced by standalone VIN lookup

interface NavItem {
  name: string;
  href: string;
  icon: React.ReactNode;
  featureId?: string;
  children?: { name: string; href: string; featureId?: string }[];
}

interface ShopOption {
  shopId: number;
  name: string;
}

interface SidebarProps {
  shopName?: string;
  userEmail?: string;
  userRole?: string;
  userInitials?: string;
  isPlatformAdmin?: boolean;
  currentShopId?: number;
  enterpriseId?: string | null;
  enabledFeatures?: string[];
}

export function Sidebar({ shopName = "My Shop", userEmail, userRole, userInitials = "MS", isPlatformAdmin, currentShopId, enterpriseId, enabledFeatures = ["maintenance"] }: SidebarProps) {
  const pathname = usePathname();
  const router = useRouter();
  const [expandedSections, setExpandedSections] = useState<Set<string>>(new Set(["Settings"]));
  const [searchQuery, setSearchQuery] = useState("");
  const [shopDropdownOpen, setShopDropdownOpen] = useState(false);
  const [shops, setShops] = useState<ShopOption[]>([]);
  const [switching, setSwitching] = useState(false);
  const [shopSearch, setShopSearch] = useState("");
  const [loggingOut, setLoggingOut] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const shopSearchRef = useRef<HTMLInputElement>(null);

  async function handleLogout() {
    setLoggingOut(true);
    try {
      const res = await fetch("/api/auth/logout", { method: "POST" });
      const data = await res.json().catch(() => ({}));
      window.location.href = data?.redirect || "/login";
    } finally {
      setLoggingOut(false);
    }
  }

  useEffect(() => {
    fetch("/api/user/shops")
      .then((res) => res.json())
      .then((data) => {
        if (data.shops) setShops(data.shops);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setShopDropdownOpen(false);
        setShopSearch("");
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  useEffect(() => {
    if (shopDropdownOpen && shopSearchRef.current) {
      setTimeout(() => shopSearchRef.current?.focus(), 50);
    }
  }, [shopDropdownOpen]);

  async function switchShop(shopId: number) {
    if (switching || shopId === currentShopId) {
      setShopDropdownOpen(false);
      return;
    }
    setSwitching(true);
    try {
      const res = await fetch("/api/user/switch-shop", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ shopId }),
      });
      if (res.ok) {
        router.refresh();
        window.location.href = "/dashboard";
      }
    } finally {
      setSwitching(false);
      setShopDropdownOpen(false);
    }
  }

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

  const hasMultipleShops = shops.length > 1;

  const navItems: NavItem[] = [
    {
      name: "Dashboard",
      href: "/dashboard",
      icon: <LayoutDashboard className="w-5 h-5" />
    },
    {
      name: "Reporting",
      href: "/dashboard/reporting",
      icon: <BarChart3 className="w-5 h-5" />
    },
    {
      name: "Job Lookup",
      href: "/dashboard/jobs",
      icon: <Search className="w-5 h-5" />,
      featureId: "job_lookup",
    },
    {
      name: "Part Cross-Ref",
      href: "/dashboard/parts",
      icon: <RefreshCw className="w-5 h-5" />,
      featureId: "part_xref",
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
        { name: "Preferences", href: "/dashboard/settings/preferences" },
        { name: "Shop Branding", href: "/dashboard/settings/branding" },
        { name: "Billing", href: "/dashboard/settings/billing" },
        { name: "Users", href: "/dashboard/settings/users" },
        { name: "Maintenance Thresholds", href: "/dashboard/settings/maintenance" },
        { name: "Shop Intervals", href: "/dashboard/settings/intervals" },
        { name: "Canned Jobs", href: "/dashboard/settings/canned-jobs" },
        { name: "Inspection Maintenance", href: "/dashboard/settings/inspection" },
        { name: "Integrations", href: "/dashboard/settings/integrations" }
      ]
    }
  ];

  const filteredNavItems = navItems.filter(item => {
    if (!item.featureId) return true;
    return enabledFeatures.includes(item.featureId);
  }).map(item => {
    if (item.children) {
      return {
        ...item,
        children: item.children.filter(child => {
          if (!child.featureId) return true;
          return enabledFeatures.includes(child.featureId);
        }),
      };
    }
    return item;
  });

  return (
    <aside className="w-64 min-h-screen flex flex-col print:hidden" style={{ backgroundColor: '#3C81C3' }}>
      <div className="p-4 border-b border-white/20 relative" ref={dropdownRef}>
        <button 
          onClick={() => hasMultipleShops && setShopDropdownOpen(!shopDropdownOpen)}
          className={`w-full flex items-center justify-between text-white rounded-lg p-2 transition-colors ${
            hasMultipleShops ? "hover:bg-white/10 cursor-pointer" : "cursor-default"
          }`}
        >
          <span className="font-medium truncate">{shopName}</span>
          {hasMultipleShops && (
            <ChevronDown className={`w-4 h-4 text-mos-silver transition-transform ${shopDropdownOpen ? "rotate-180" : ""}`} />
          )}
        </button>
        
        {shopDropdownOpen && hasMultipleShops && (
          <div className="absolute left-4 right-4 top-full mt-1 bg-mos-blue-dark rounded-lg shadow-lg border border-white/20 z-50 overflow-hidden">
            {shops.length > 5 && (
              <div className="p-2 border-b border-white/20">
                <div className="relative">
                  <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-white/70" />
                  <input
                    ref={shopSearchRef}
                    type="text"
                    placeholder="Search locations..."
                    value={shopSearch}
                    onChange={(e) => setShopSearch(e.target.value)}
                    className="w-full bg-white/10 text-white placeholder-white/50 rounded-md py-1.5 pl-8 pr-3 text-sm focus:outline-none focus:ring-1 focus:ring-white/30 border border-white/20"
                  />
                </div>
              </div>
            )}
            <div className="max-h-64 overflow-y-auto py-1">
              {shops
                .filter((shop) => 
                  !shopSearch || 
                  shop.name.toLowerCase().includes(shopSearch.toLowerCase()) ||
                  String(shop.shopId).includes(shopSearch)
                )
                .map((shop) => (
                  <button
                    key={shop.shopId}
                    onClick={() => switchShop(shop.shopId)}
                    disabled={switching}
                    className={`w-full flex items-center justify-between px-3 py-2 text-sm transition-colors ${
                      shop.shopId === currentShopId
                        ? "text-white bg-white/20"
                        : "text-white/70 hover:bg-white/10 hover:text-white"
                    }`}
                  >
                    <span className="truncate">{shop.name}</span>
                    {shop.shopId === currentShopId && <Check className="w-4 h-4 flex-shrink-0" />}
                  </button>
                ))}
              {shops.filter((shop) => 
                !shopSearch || 
                shop.name.toLowerCase().includes(shopSearch.toLowerCase()) ||
                String(shop.shopId).includes(shopSearch)
              ).length === 0 && (
                <div className="px-3 py-2 text-sm text-white/50 text-center">No locations found</div>
              )}
            </div>
          </div>
        )}
      </div>

      <div className="p-4 space-y-3">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-white/70" />
          <input
            type="text"
            placeholder="Search"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full bg-white/10 text-white placeholder-white/50 rounded-lg py-2 pl-10 pr-4 text-sm focus:outline-none focus:ring-2 focus:ring-white/30 border border-white/20"
          />
        </div>
      </div>

      <nav className="flex-1 px-3 pb-4 overflow-y-auto">
        <ul className="space-y-1">
          {filteredNavItems.map((item) => (
            <li key={item.name}>
              {item.children ? (
                <div>
                  <button
                    onClick={() => toggleSection(item.name)}
                    className={`w-full flex items-center justify-between px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
                      isActive(item.href)
                        ? "bg-white/20 text-white"
                        : "text-white/80 hover:bg-white/10 hover:text-white"
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
                    <ul className="mt-1 ml-4 space-y-1 border-l border-white/20 pl-4">
                      {item.children.map((child) => (
                        <li key={child.name}>
                          <Link
                            href={child.href}
                            className={`block px-3 py-2 rounded-lg text-sm transition-colors ${
                              isActive(child.href)
                                ? "bg-white/20 text-white font-medium"
                                : "text-white/70 hover:bg-white/10 hover:text-white"
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
                      ? "bg-white/20 text-white"
                      : "text-white/80 hover:bg-white/10 hover:text-white"
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

      <div className="p-4 border-t border-white/20">
        {enterpriseId && (userRole === "owner" || userRole === "admin") && (
          <Link
            href="/dashboard/enterprise"
            className={`flex items-center gap-3 px-3 py-2 mb-3 rounded-lg text-sm font-medium transition-colors ${
              pathname?.startsWith("/dashboard/enterprise")
                ? "bg-white/20 text-white"
                : "text-white/80 hover:bg-white/10 hover:text-white"
            }`}
          >
            <Building2 className="w-5 h-5" />
            <span>Enterprise</span>
          </Link>
        )}
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-full bg-white/20 flex items-center justify-center text-white text-sm font-medium">
            {userInitials}
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium text-white truncate">{userEmail || "Account"}</p>
            {userRole && (
              <p className="text-xs text-white/60 capitalize">{userRole}</p>
            )}
          </div>
          <button 
            onClick={handleLogout}
            disabled={loggingOut}
            className="p-1.5 text-white/70 hover:text-white rounded-lg hover:bg-white/10 transition-colors disabled:opacity-50"
            title="Log out"
          >
            <LogOut className="w-5 h-5" />
          </button>
        </div>
      </div>
    </aside>
  );
}
