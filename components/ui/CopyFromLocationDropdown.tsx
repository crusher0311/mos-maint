"use client";

import { useState, useEffect } from "react";
import { Copy, ChevronDown, Loader2, Check, Building2 } from "lucide-react";
import {
  ENTERPRISE_SETTING_CATEGORY_DETAILS,
  type EnterpriseSettingCategory,
} from "@/lib/enterprise-settings-catalog";

type EnterpriseLocation = {
  shopId: number;
  name: string;
};

type Props = {
  settingType: SettingType;
  onCopyComplete: () => void;
  disabled?: boolean;
};

export type SettingType = EnterpriseSettingCategory;

export default function CopyFromLocationDropdown({ settingType, onCopyComplete, disabled }: Props) {
  const [loading, setLoading] = useState(true);
  const [copying, setCopying] = useState(false);
  const [locations, setLocations] = useState<EnterpriseLocation[]>([]);
  const [canManageLaborRates, setCanManageLaborRates] = useState(true);
  const [destinationName, setDestinationName] = useState("the current location");
  const [isOpen, setIsOpen] = useState(false);
  const [message, setMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);

  useEffect(() => {
    fetchEnterpriseLocations();
  }, []);

  async function fetchEnterpriseLocations() {
    try {
      const [res, shopsRes] = await Promise.all([
        fetch("/api/enterprise/locations"),
        fetch("/api/user/shops"),
      ]);
      if (res.ok) {
        const data = await res.json();
        setLocations(data.locations || []);
        setCanManageLaborRates(data.canManageLaborRates !== false);
      }
      if (shopsRes?.ok) {
        const shopsData = await shopsRes.json();
        const current = (shopsData.shops || []).find(
          (shop: EnterpriseLocation) => Number(shop.shopId) === Number(shopsData.currentShopId)
        );
        if (current?.name) setDestinationName(current.name);
      }
    } catch (err) {
      console.error("Failed to fetch enterprise locations:", err);
    } finally {
      setLoading(false);
    }
  }

  async function copyFromLocation(sourceShopId: number) {
    const source = locations.find((location) => location.shopId === sourceShopId);
    if (!confirm(
      `Copy ${ENTERPRISE_SETTING_CATEGORY_DETAILS[settingType].label} from ${source?.name || "this location"} to ${destinationName}?\n\nThe destination category will be replaced. Empty source values will clear existing destination values.`
    )) {
      return;
    }
    setCopying(true);
    setMessage(null);
    setIsOpen(false);

    try {
      const res = await fetch("/api/enterprise/copy-settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sourceShopId,
          settingTypes: [settingType],
        }),
      });

      const data = await res.json();

      if (res.ok && data.ok !== false) {
        setMessage({
          type: "success",
          text: `${ENTERPRISE_SETTING_CATEGORY_DETAILS[settingType].label} copied from ${source?.name || "source location"} to ${destinationName}.`,
        });
        onCopyComplete();
      } else {
        setMessage({ type: "error", text: data.error || "Failed to copy settings" });
      }
    } catch (err) {
      setMessage({ type: "error", text: "Failed to copy settings" });
    } finally {
      setCopying(false);
    }
  }

  if (loading) {
    return null;
  }

  if (
    locations.length === 0 ||
    (settingType === "laborRates" && !canManageLaborRates)
  ) {
    return null;
  }

  return (
    <div className="relative">
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => setIsOpen(!isOpen)}
          disabled={disabled || copying}
          className="inline-flex items-center gap-2 px-3 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {copying ? (
            <Loader2 className="w-4 h-4 animate-spin" />
          ) : (
            <Copy className="w-4 h-4" />
          )}
          Copy from Location
          <ChevronDown className="w-4 h-4" />
        </button>

        {message && (
          <span
            className={`text-sm ${
              message.type === "success" ? "text-green-600" : "text-red-600"
            }`}
          >
            {message.type === "success" && <Check className="w-4 h-4 inline mr-1" />}
            {message.text}
          </span>
        )}
      </div>

      {isOpen && (
        <>
          <div
            className="fixed inset-0 z-10"
            onClick={() => setIsOpen(false)}
          />
          <div className="absolute top-full left-0 mt-2 w-64 bg-white border border-gray-200 rounded-lg shadow-lg z-20 py-1">
            <div className="px-3 py-2 border-b border-gray-100">
              <p className="text-xs text-gray-500 font-medium">Enterprise Locations</p>
            </div>
            {locations.map((loc) => (
              <button
                key={loc.shopId}
                type="button"
                onClick={() => copyFromLocation(loc.shopId)}
                className="w-full flex items-center gap-2 px-3 py-2 text-sm text-gray-700 hover:bg-gray-50 text-left"
              >
                <Building2 className="w-4 h-4 text-gray-400" />
                <span className="truncate">{loc.name}</span>
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

export function CopySettingsToAllButton({
  settingType,
  onCopyComplete,
  disabled,
}: {
  settingType: SettingType;
  onCopyComplete: () => void;
  disabled?: boolean;
}) {
  const [source, setSource] = useState<EnterpriseLocation | null>(null);
  const [siblingCount, setSiblingCount] = useState(0);
  const [canManage, setCanManage] = useState(false);
  const [copying, setCopying] = useState(false);
  const [message, setMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);

  useEffect(() => {
    Promise.all([
      fetch("/api/user/shops").then((res) => res.ok ? res.json() : Promise.reject()),
      fetch("/api/enterprise/locations").then((res) => res.ok ? res.json() : Promise.reject()),
    ])
      .then(([shopsData, enterpriseData]) => {
        const currentShopId = Number(shopsData.currentShopId);
        const current = (shopsData.shops || []).find(
          (shop: EnterpriseLocation) => Number(shop.shopId) === currentShopId
        );
        if (currentShopId) {
          setSource({ shopId: currentShopId, name: current?.name || `Location ${currentShopId}` });
        }
        setSiblingCount((enterpriseData.locations || []).length);
        setCanManage(
          enterpriseData.canManageSettings === true &&
          (settingType !== "laborRates" || enterpriseData.canManageLaborRates === true)
        );
      })
      .catch(() => {
        setSource(null);
        setSiblingCount(0);
        setCanManage(false);
      });
  }, [settingType]);

  async function copyToAll() {
    if (!source) return;
    if (
      !confirm(
        `Copy ${ENTERPRISE_SETTING_CATEGORY_DETAILS[settingType].label} from ${source.name} to all ${siblingCount} other enterprise location${siblingCount === 1 ? "" : "s"}?\n\nThis replaces the selected category at every destination. Empty source values intentionally clear stale destination values.`
      )
    ) {
      return;
    }
    setCopying(true);
    setMessage(null);
    try {
      const res = await fetch("/api/enterprise/copy-settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sourceShopId: source.shopId,
          current: source.shopId,
          settingTypes: [settingType],
          destination: "allOther",
        }),
      });
      const data = await res.json();
      if (!res.ok || data.ok === false) {
        throw new Error(data.error || data.message || `Failed to copy ${ENTERPRISE_SETTING_CATEGORY_DETAILS[settingType].label}`);
      }
      const appliedCount = data.matchedCount ?? siblingCount;
      setMessage({
        type: "success",
        text: `Copied ${ENTERPRISE_SETTING_CATEGORY_DETAILS[settingType].label} from ${source.name} to ${appliedCount} other location${appliedCount === 1 ? "" : "s"}${data.failCount ? `; ${data.failCount} failed` : ""}.`,
      });
      onCopyComplete();
    } catch (error) {
      setMessage({
        type: "error",
        text: error instanceof Error ? error.message : `Failed to copy ${ENTERPRISE_SETTING_CATEGORY_DETAILS[settingType].label}`,
      });
    } finally {
      setCopying(false);
    }
  }

  if (!source || siblingCount === 0 || !canManage) return null;

  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        onClick={copyToAll}
        disabled={disabled || copying}
        className="inline-flex items-center gap-2 px-3 py-2 text-sm font-medium text-white bg-blue-600 rounded-lg hover:bg-blue-700 disabled:opacity-50"
      >
        {copying ? <Loader2 className="w-4 h-4 animate-spin" /> : <Building2 className="w-4 h-4" />}
        Copy to all other locations
      </button>
      {message && (
        <span className={`text-sm ${message.type === "success" ? "text-green-600" : "text-red-600"}`}>
          {message.type === "success" && <Check className="w-4 h-4 inline mr-1" />}
          {message.text}
        </span>
      )}
    </div>
  );
}

export function CopyLaborRatesToAllButton(props: {
  onCopyComplete: () => void;
  disabled?: boolean;
}) {
  return <CopySettingsToAllButton settingType="laborRates" {...props} />;
}
