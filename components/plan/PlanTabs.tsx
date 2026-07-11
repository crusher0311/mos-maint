"use client";

import { useState, type ReactNode } from "react";

type TabDef = { id: string; label: string };

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
              {t.label}
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
