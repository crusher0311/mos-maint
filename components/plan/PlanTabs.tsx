"use client";

import { useState, type ReactNode } from "react";

/**
 * Task #804: optional status badge rendered inside the tab button
 * (protection-plan Enrolled / At risk / Eligible pills).
 */
export type TabBadge = { text: string; tone: "green" | "amber" | "red" | "blue" };

type TabDef = { id: string; label: string; badge?: TabBadge | null };

const BADGE_TONE_CLASSES: Record<TabBadge["tone"], string> = {
  green: "bg-green-100 text-green-800",
  amber: "bg-amber-100 text-amber-800",
  red: "bg-red-100 text-red-800",
  blue: "bg-blue-100 text-blue-800",
};

/**
 * Task #803: client-side tab switcher for the multi-plan (OE / Shop /
 * chemical-provider) vehicle plan view. All panels are server-rendered once
 * and passed in as ReactNodes; switching tabs only toggles CSS visibility so
 * it is instant (no refetch, no re-render of the expensive plan sections).
 * In print, every panel is hidden except the active one (same CSS rule).
 */
export default function PlanTabs({
  tabs,
  panels,
  defaultTabId,
}: {
  tabs: TabDef[];
  panels: ReactNode[];
  defaultTabId?: string;
}) {
  const [activeId, setActiveId] = useState<string>(() =>
    defaultTabId && tabs.some((t) => t.id === defaultTabId)
      ? defaultTabId
      : tabs[0]?.id ?? ""
  );

  return (
    <div className="space-y-6">
      <div
        role="tablist"
        aria-label="Maintenance plan"
        className="flex flex-wrap gap-1 border-b border-neutral-200 print:hidden"
      >
        {tabs.map((t) => {
          const active = t.id === activeId;
          return (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => setActiveId(t.id)}
              className={`px-4 py-2 -mb-px text-sm font-medium rounded-t-lg border-b-2 transition-colors ${
                active
                  ? "border-blue-600 text-blue-700 bg-blue-50/60"
                  : "border-transparent text-neutral-500 hover:text-neutral-800 hover:bg-neutral-50"
              }`}
            >
              <span className="inline-flex items-center gap-1.5">
                {t.label}
                {t.badge && (
                  <span
                    className={`px-1.5 py-0.5 rounded-full text-[10px] font-semibold leading-none ${BADGE_TONE_CLASSES[t.badge.tone]}`}
                  >
                    {t.badge.text}
                  </span>
                )}
              </span>
            </button>
          );
        })}
      </div>
      {tabs.map((t, i) => (
        <div
          key={t.id}
          role="tabpanel"
          hidden={t.id !== activeId}
          className={t.id === activeId ? "space-y-8" : "hidden"}
        >
          {panels[i]}
        </div>
      ))}
    </div>
  );
}
