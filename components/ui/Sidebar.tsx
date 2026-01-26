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
  RefreshCw,
  X,
  Printer,
  CalendarCheck
} from "lucide-react";
import { NotificationBell } from "./NotificationBell";
// import { PlanLauncher } from "./PlanLauncher"; // Hidden - replaced by standalone VIN lookup

interface NavChild {
  name: string;
  href: string;
  featureId?: string;
  isModal?: boolean;
  children?: { name: string; href: string; featureId?: string; isModal?: boolean }[];
}

interface NavItem {
  name: string;
  href: string;
  icon: React.ReactNode;
  featureId?: string;
  isModal?: boolean;
  children?: NavChild[];
}

interface ShopOption {
  shopId: number;
  name: string;
  locationIdentifier?: string | null;
  displayName: string;
}

interface SidebarProps {
  shopName?: string;
  shopLogo?: string | null;
  locationIdentifier?: string | null;
  userEmail?: string;
  userRole?: string;
  userInitials?: string;
  isPlatformAdmin?: boolean;
  currentShopId?: number;
  enterpriseId?: string | null;
  hasEnterpriseBilling?: boolean;
  enabledFeatures?: string[];
  onClose?: () => void;
  onQuickStickerClick?: () => void;
}

function getInitialExpandedSections(pathname: string | null): Set<string> {
  const sections = new Set<string>();
  if (pathname?.startsWith("/dashboard/settings")) {
    sections.add("Settings");
  }
  if (pathname?.startsWith("/dashboard/settings/branding") || 
      pathname?.startsWith("/dashboard/settings/stickers") ||
      pathname?.startsWith("/dashboard/settings/keytags") ||
      pathname?.startsWith("/dashboard/settings/preferences")) {
    sections.add("Preferences");
  }
  if (pathname?.startsWith("/dashboard/enterprise")) {
    sections.add("Enterprise");
  }
  return sections;
}

export function Sidebar({ shopName = "My Shop", shopLogo, locationIdentifier, userEmail, userRole, userInitials = "MS", isPlatformAdmin, currentShopId, enterpriseId, hasEnterpriseBilling = false, enabledFeatures = ["maintenance"], onClose, onQuickStickerClick }: SidebarProps) {
  const pathname = usePathname();
  const router = useRouter();
  const [expandedSections, setExpandedSections] = useState<Set<string>>(() => getInitialExpandedSections(pathname));
  const [searchQuery, setSearchQuery] = useState("");
  const [shopDropdownOpen, setShopDropdownOpen] = useState(false);
  const [shops, setShops] = useState<ShopOption[]>([]);
  const [switching, setSwitching] = useState(false);
  const [shopSearch, setShopSearch] = useState("");
  const [loggingOut, setLoggingOut] = useState(false);
  const [pendingBookingsCount, setPendingBookingsCount] = useState(0);
  const [showBookingBadge, setShowBookingBadge] = useState(false);
  const [openSupportTickets, setOpenSupportTickets] = useState(0);
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

  const refreshPendingCount = () => {
    if (enabledFeatures.includes("auto_booking")) {
      fetch("/api/settings/auto-booking/pending-count")
        .then((res) => res.json())
        .then((data) => {
          setPendingBookingsCount(data.count || 0);
          setShowBookingBadge(data.showBadge || false);
        })
        .catch(() => {});
    }
  };

  useEffect(() => {
    refreshPendingCount();
  }, [enabledFeatures]);

  useEffect(() => {
    const fetchSupportTicketCount = async () => {
      try {
        const res = await fetch("/api/support/tickets/count");
        const data = await res.json();
        if (data.ok) {
          setOpenSupportTickets(data.openCount);
        }
      } catch (error) {
        console.error("Error fetching support ticket count:", error);
      }
    };

    fetchSupportTicketCount();
    const interval = setInterval(fetchSupportTicketCount, 60000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    const handleRefresh = () => refreshPendingCount();
    window.addEventListener("refreshBookingCount", handleRefresh);
    return () => window.removeEventListener("refreshBookingCount", handleRefresh);
  }, [enabledFeatures]);

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

  useEffect(() => {
    if (!pathname) return;
    
    setExpandedSections(prev => {
      const newExpanded = new Set(prev);
      let changed = false;
      
      if (pathname.startsWith("/dashboard/settings") && !newExpanded.has("Settings")) {
        newExpanded.add("Settings");
        changed = true;
      }
      if ((pathname.startsWith("/dashboard/settings/branding") || 
           pathname.startsWith("/dashboard/settings/stickers") ||
           pathname.startsWith("/dashboard/settings/keytags") ||
           pathname.startsWith("/dashboard/settings/preferences")) && !newExpanded.has("Preferences")) {
        newExpanded.add("Preferences");
        changed = true;
      }
      if (pathname.startsWith("/dashboard/enterprise") && !newExpanded.has("Enterprise")) {
        newExpanded.add("Enterprise");
        changed = true;
      }
      
      return changed ? newExpanded : prev;
    });
  }, [pathname]);

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
      name: "Booking Review",
      href: "/dashboard/settings/auto-booking/queue",
      icon: <CalendarCheck className="w-5 h-5" />,
      featureId: "auto_booking"
    },
    {
      name: "Quick Sticker",
      href: "#quick-sticker",
      icon: <Printer className="w-5 h-5" />,
      featureId: "oil_sticker",
      isModal: true
    },
    // Reporting page hidden until we have enough data to verify with live users
    // {
    //   name: "Reporting",
    //   href: "/dashboard/reporting",
    //   icon: <BarChart3 className="w-5 h-5" />
    // },
    {
      name: "Part Cross-Ref",
      href: "/dashboard/parts",
      icon: <RefreshCw className="w-5 h-5" />,
      featureId: "part_xref",
    },
    {
      name: "Settings",
      href: "/dashboard/settings",
      icon: <Settings className="w-5 h-5" />,
      children: [
        { 
          name: "Preferences", 
          href: "/dashboard/settings/preferences",
          children: [
            { name: "Shop Branding", href: "/dashboard/settings/branding" },
            { name: "Oil Stickers", href: "/dashboard/settings/stickers", featureId: "oil_sticker" },
            { name: "Keytags", href: "/dashboard/settings/keytags", featureId: "keytags" }
          ]
        },
        ...(hasEnterpriseBilling ? [] : [{ name: "Billing", href: "/dashboard/settings/billing" }]),
        { name: "Users", href: "/dashboard/settings/users" },
        { name: "Maintenance Thresholds", href: "/dashboard/settings/maintenance" },
        { name: "Shop Intervals", href: "/dashboard/settings/intervals" },
        { name: "Canned Jobs", href: "/dashboard/settings/canned-jobs" },
        { name: "Inspection Maintenance", href: "/dashboard/settings/inspection" },
        { name: "Auto Booking", href: "/dashboard/settings/auto-booking", featureId: "auto_booking" },
        { name: "Integrations", href: "/dashboard/settings/integrations" }
      ]
    },
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
        }).map(child => {
          if (child.children) {
            return {
              ...child,
              children: child.children.filter(grandchild => {
                if (!grandchild.featureId) return true;
                return enabledFeatures.includes(grandchild.featureId);
              }),
            };
          }
          return child;
        }).filter(child => {
          if (child.children && child.children.length === 0) return false;
          return true;
        }),
      };
    }
    return item;
  });

  return (
    <aside className="w-full h-full min-h-screen flex flex-col print:hidden" style={{ backgroundColor: '#3C81C3' }}>
      {/* Mobile close button */}
      {onClose && (
        <button
          onClick={onClose}
          className="absolute top-3 right-3 p-2 text-white/70 hover:text-white hover:bg-white/10 rounded-lg z-10"
          aria-label="Close menu"
        >
          <X className="w-6 h-6" />
        </button>
      )}
      <div className="p-4 border-b border-white/20 relative" ref={dropdownRef}>
        <div className="flex items-center justify-between gap-2">
          <button 
            onClick={() => hasMultipleShops && setShopDropdownOpen(!shopDropdownOpen)}
            className={`flex-1 flex items-center justify-between text-white rounded-lg p-2 transition-colors ${
              hasMultipleShops ? "hover:bg-white/10 cursor-pointer" : "cursor-default"
            }`}
          >
            <div className="flex items-center gap-3 min-w-0">
            {shopLogo && (
              <img 
                src={shopLogo} 
                alt="" 
                className="h-10 w-auto max-w-[48px] object-contain flex-shrink-0"
              />
            )}
            <div className="min-w-0 flex-1">
              <span className="font-medium text-sm leading-tight block break-words">{shopName}</span>
              {locationIdentifier && (
                <span className="text-xs text-white/70 block break-words">{locationIdentifier}</span>
              )}
            </div>
          </div>
          {hasMultipleShops && (
            <ChevronDown className={`w-4 h-4 text-mos-silver transition-transform flex-shrink-0 ${shopDropdownOpen ? "rotate-180" : ""}`} />
          )}
          </button>
          <NotificationBell isPlatformAdmin={false} />
        </div>
        
        {shopDropdownOpen && hasMultipleShops && (
          <div className="absolute left-4 right-4 top-full mt-1 bg-white rounded-lg shadow-xl border border-gray-200 z-50 overflow-hidden">
            {shops.length > 5 && (
              <div className="p-2 border-b border-gray-200">
                <div className="relative">
                  <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-400" />
                  <input
                    ref={shopSearchRef}
                    type="text"
                    placeholder="Search locations..."
                    value={shopSearch}
                    onChange={(e) => setShopSearch(e.target.value)}
                    className="w-full bg-gray-50 text-gray-900 placeholder-gray-400 rounded-md py-1.5 pl-8 pr-3 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 border border-gray-200"
                  />
                </div>
              </div>
            )}
            <div className="max-h-64 overflow-y-auto py-1">
              {shops
                .filter((shop) => 
                  !shopSearch || 
                  shop.displayName.toLowerCase().includes(shopSearch.toLowerCase()) ||
                  shop.name.toLowerCase().includes(shopSearch.toLowerCase()) ||
                  String(shop.shopId).includes(shopSearch)
                )
                .map((shop) => (
                  <button
                    key={shop.shopId}
                    onClick={() => switchShop(shop.shopId)}
                    disabled={switching}
                    className={`w-full flex items-center justify-between px-3 py-2.5 text-sm transition-colors ${
                      shop.shopId === currentShopId
                        ? "text-blue-600 bg-blue-50 font-medium"
                        : "text-gray-700 hover:bg-gray-100"
                    }`}
                  >
                    <span className="truncate">{shop.displayName}</span>
                    {shop.shopId === currentShopId && <Check className="w-4 h-4 flex-shrink-0 text-blue-600" />}
                  </button>
                ))}
              {shops.filter((shop) => 
                !shopSearch || 
                shop.displayName.toLowerCase().includes(shopSearch.toLowerCase()) ||
                shop.name.toLowerCase().includes(shopSearch.toLowerCase()) ||
                String(shop.shopId).includes(shopSearch)
              ).length === 0 && (
                <div className="px-3 py-2 text-sm text-gray-500 text-center">No locations found</div>
              )}
            </div>
          </div>
        )}
      </div>

      <div className="p-4">
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
                          {child.children && child.children.length > 0 ? (
                            <div>
                              <div className="flex items-center">
                                <Link
                                  href={child.href}
                                  className={`flex-1 px-3 py-2 rounded-l-lg text-sm transition-colors ${
                                    isActive(child.href) && !child.children.some(gc => isActive(gc.href))
                                      ? "bg-white/20 text-white font-medium"
                                      : child.children.some(gc => isActive(gc.href))
                                        ? "bg-white/10 text-white"
                                        : "text-white/70 hover:bg-white/10 hover:text-white"
                                  }`}
                                >
                                  {child.name}
                                </Link>
                                <button
                                  onClick={() => toggleSection(child.name)}
                                  className={`px-2 py-2 rounded-r-lg text-sm transition-colors ${
                                    child.children.some(gc => isActive(gc.href))
                                      ? "bg-white/10 text-white"
                                      : "text-white/70 hover:bg-white/10 hover:text-white"
                                  }`}
                                >
                                  {expandedSections.has(child.name) ? (
                                    <ChevronDown className="w-3 h-3" />
                                  ) : (
                                    <ChevronRight className="w-3 h-3" />
                                  )}
                                </button>
                              </div>
                              {expandedSections.has(child.name) && (
                                <ul className="mt-1 ml-3 space-y-1 border-l border-white/15 pl-3">
                                  {child.children.map((grandchild) => (
                                    <li key={grandchild.name}>
                                      {grandchild.isModal ? (
                                        <button
                                          onClick={() => {
                                            if (grandchild.href === "#quick-sticker" && onQuickStickerClick) {
                                              onQuickStickerClick();
                                            }
                                          }}
                                          className="w-full text-left block px-3 py-1.5 rounded-lg text-sm transition-colors text-white/60 hover:bg-white/10 hover:text-white"
                                        >
                                          {grandchild.name}
                                        </button>
                                      ) : (
                                        <Link
                                          href={grandchild.href}
                                          className={`block px-3 py-1.5 rounded-lg text-sm transition-colors ${
                                            isActive(grandchild.href)
                                              ? "bg-white/20 text-white font-medium"
                                              : "text-white/60 hover:bg-white/10 hover:text-white"
                                          }`}
                                        >
                                          {grandchild.name}
                                        </Link>
                                      )}
                                    </li>
                                  ))}
                                </ul>
                              )}
                            </div>
                          ) : (
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
                          )}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              ) : item.isModal ? (
                <button
                  onClick={() => {
                    if (item.href === "#quick-sticker" && onQuickStickerClick) {
                      onQuickStickerClick();
                    }
                  }}
                  className="w-full flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium transition-colors text-white/80 hover:bg-white/10 hover:text-white"
                >
                  {item.icon}
                  <span>{item.name}</span>
                </button>
              ) : (
                <Link
                  href={item.href}
                  className={`flex items-center justify-between px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
                    isActive(item.href)
                      ? "bg-white/20 text-white"
                      : "text-white/80 hover:bg-white/10 hover:text-white"
                  }`}
                >
                  <div className="flex items-center gap-3">
                    {item.icon}
                    <span>{item.name}</span>
                  </div>
                  {item.name === "Booking Review" && showBookingBadge && pendingBookingsCount > 0 && (
                    <span className="flex items-center justify-center min-w-[20px] h-5 px-1.5 text-xs font-bold bg-red-500 text-white rounded-full">
                      {pendingBookingsCount > 99 ? "99+" : pendingBookingsCount}
                    </span>
                  )}
                </Link>
              )}
            </li>
          ))}
        </ul>
      </nav>

      <div className="px-3 pb-2 space-y-1">
        <Link
          href="/dashboard/support"
          className={`flex items-center justify-between px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
            isActive("/dashboard/support")
              ? "bg-white/20 text-white"
              : "text-white/80 hover:bg-white/10 hover:text-white"
          }`}
        >
          <div className="flex items-center gap-3">
            <img src="/icons/support-agent.png" alt="" className="w-5 h-5 invert" />
            <span>Support</span>
          </div>
          {openSupportTickets > 0 && (
            <span className="flex items-center justify-center min-w-[20px] h-5 px-1.5 text-xs font-bold bg-blue-500 text-white rounded-full">
              {openSupportTickets > 99 ? "99+" : openSupportTickets}
            </span>
          )}
        </Link>
        {isPlatformAdmin && (
          <Link
            href="/platform-admin"
            className="flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium transition-colors"
            style={{ backgroundColor: 'rgba(96, 99, 100, 0.3)', color: 'rgba(255, 255, 255, 0.9)' }}
          >
            <Shield className="w-5 h-5" />
            <span>MOS Admin Panel</span>
          </Link>
        )}
      </div>

      <div className="p-4 border-t border-white/20">
        {enterpriseId && (userRole === "owner" || userRole === "admin") && (
          <div className="mb-3">
            <button
              onClick={() => toggleSection("Enterprise")}
              className={`w-full flex items-center justify-between px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
                pathname?.startsWith("/dashboard/enterprise")
                  ? "bg-white/20 text-white"
                  : "text-white/80 hover:bg-white/10 hover:text-white"
              }`}
            >
              <div className="flex items-center gap-3">
                <Building2 className="w-5 h-5" />
                <span>Enterprise</span>
              </div>
              {expandedSections.has("Enterprise") ? (
                <ChevronDown className="w-4 h-4" />
              ) : (
                <ChevronRight className="w-4 h-4" />
              )}
            </button>
            {expandedSections.has("Enterprise") && (
              <ul className="mt-1 ml-4 space-y-1 border-l border-white/20 pl-4">
                <li>
                  <Link
                    href="/dashboard/enterprise"
                    className={`block px-3 py-2 rounded-lg text-sm transition-colors ${
                      pathname === "/dashboard/enterprise"
                        ? "bg-white/20 text-white font-medium"
                        : "text-white/70 hover:bg-white/10 hover:text-white"
                    }`}
                  >
                    Overview
                  </Link>
                </li>
                <li>
                  <Link
                    href="/dashboard/enterprise/billing"
                    className={`block px-3 py-2 rounded-lg text-sm transition-colors ${
                      pathname === "/dashboard/enterprise/billing"
                        ? "bg-white/20 text-white font-medium"
                        : "text-white/70 hover:bg-white/10 hover:text-white"
                    }`}
                  >
                    Billing
                  </Link>
                </li>
              </ul>
            )}
          </div>
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
