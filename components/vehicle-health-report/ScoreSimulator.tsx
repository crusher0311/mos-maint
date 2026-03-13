"use client";

import React, { useState, useMemo } from "react";
import type { PlanItem, VHIData } from "./VehicleHealthReport";
import { computeScore } from "./VehicleHealthReport";
import { getScoreInfo } from "./HealthGauge";
import ServiceIcon from "./ServiceIcon";

interface ScoreSimulatorProps {
  data: VHIData;
  currentScore: number;
}

export default function ScoreSimulator({ data, currentScore }: ScoreSimulatorProps) {
  const actionableItems = useMemo(() => {
    return [
      ...data.buckets.overdue.map((item) => ({ ...item, bucket: "overdue" as const })),
      ...data.buckets.dueSoon.map((item) => ({ ...item, bucket: "dueSoon" as const })),
    ];
  }, [data]);

  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());

  const toggleItem = (key: string) => {
    setSelectedKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const selectAll = () => {
    setSelectedKeys(new Set(actionableItems.map((i) => i.key)));
  };

  const clearAll = () => {
    setSelectedKeys(new Set());
  };

  const projectedScore = useMemo(() => {
    if (selectedKeys.size === 0) return currentScore;

    const simulatedData: VHIData = {
      ...data,
      buckets: {
        overdue: data.buckets.overdue.filter((i) => !selectedKeys.has(i.key)),
        dueSoon: data.buckets.dueSoon.filter((i) => !selectedKeys.has(i.key)),
        upcoming: [
          ...data.buckets.upcoming,
          ...data.buckets.overdue.filter((i) => selectedKeys.has(i.key)).map((i) => ({
            ...i,
            bump: null as null,
            milesToGo: i.intervalMiles || 10000,
            daysToGo: i.intervalMonths ? i.intervalMonths * 30 : 365,
            declined: false,
          })),
          ...data.buckets.dueSoon.filter((i) => selectedKeys.has(i.key)).map((i) => ({
            ...i,
            bump: null as null,
            milesToGo: i.intervalMiles || 10000,
            daysToGo: i.intervalMonths ? i.intervalMonths * 30 : 365,
            declined: false,
          })),
        ],
      },
    };

    return computeScore(simulatedData);
  }, [data, selectedKeys, currentScore]);

  const improvement = projectedScore - currentScore;
  const projectedInfo = getScoreInfo(projectedScore);
  const hasSelection = selectedKeys.size > 0;

  if (actionableItems.length === 0) return null;

  return (
    <div className="px-4 py-5 border-b border-gray-100">
      <div className="flex items-center gap-2 mb-1">
        <div className="w-6 h-6 rounded-full bg-blue-500 flex items-center justify-center flex-shrink-0">
          <svg width="14" height="14" viewBox="0 0 14 14" fill="white">
            <path d="M7 1 L7 13 M1 7 L13 7" stroke="white" strokeWidth="2" strokeLinecap="round" />
          </svg>
        </div>
        <h3 className="text-base sm:text-lg font-bold text-blue-600">
          What If You Repair Today?
        </h3>
      </div>
      <p className="text-xs text-gray-500 mb-4 ml-8">
        Select items to see how your score improves.
      </p>

      <div className="space-y-2 mb-4">
        {actionableItems.map((item) => {
          const isSelected = selectedKeys.has(item.key);
          const isOverdue = item.bucket === "overdue";

          return (
            <button
              key={item.key}
              onClick={() => toggleItem(item.key)}
              className={`w-full flex items-center gap-3 p-3 rounded-lg border text-left transition-all ${
                isSelected
                  ? "border-green-400 bg-green-50 ring-1 ring-green-200"
                  : isOverdue
                  ? "border-red-200 bg-white hover:bg-red-50/50"
                  : "border-amber-200 bg-white hover:bg-amber-50/50"
              }`}
            >
              <div className={`w-5 h-5 rounded-md border-2 flex items-center justify-center flex-shrink-0 transition-colors ${
                isSelected ? "bg-green-500 border-green-500" : "border-gray-300"
              }`}>
                {isSelected && (
                  <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                    <polyline points="2.5,6 5,8.5 9.5,3.5" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                )}
              </div>
              <div className={`flex-shrink-0 ${isSelected ? "text-green-500" : isOverdue ? "text-red-500" : "text-amber-500"}`}>
                <ServiceIcon serviceKey={item.serviceKey ?? item.key} size={22} />
              </div>
              <div className="flex-1 min-w-0">
                <span className={`text-sm font-medium ${isSelected ? "text-green-700 line-through" : "text-gray-800"}`}>
                  {item.title}
                </span>
              </div>
              <div className={`text-[10px] font-bold uppercase px-1.5 py-0.5 rounded flex-shrink-0 ${
                isOverdue ? "bg-red-100 text-red-600" : "bg-amber-100 text-amber-600"
              }`}>
                {isOverdue ? "Overdue" : "Due Soon"}
              </div>
            </button>
          );
        })}
      </div>

      <div className="flex gap-2 mb-4">
        <button
          onClick={selectAll}
          className="text-xs text-blue-600 font-medium hover:underline"
        >
          Select All
        </button>
        <span className="text-gray-300">|</span>
        <button
          onClick={clearAll}
          className="text-xs text-gray-500 font-medium hover:underline"
        >
          Clear
        </button>
      </div>

      {hasSelection && (() => {
        const remainingOverdue = data.buckets.overdue.filter((i) => !selectedKeys.has(i.key));
        const hasRemainingOverdue = remainingOverdue.length > 0;

        const bgTint = hasRemainingOverdue
          ? (projectedScore >= 50 ? "from-amber-50 to-yellow-50 border-amber-200"
            : projectedScore >= 30 ? "from-orange-50 to-amber-50 border-orange-200"
            : "from-red-50 to-orange-50 border-red-200")
          : (projectedScore >= 85 ? "from-green-50 to-emerald-50 border-green-200"
            : projectedScore >= 70 ? "from-lime-50 to-green-50 border-lime-200"
            : projectedScore >= 50 ? "from-amber-50 to-yellow-50 border-amber-200"
            : projectedScore >= 30 ? "from-orange-50 to-amber-50 border-orange-200"
            : "from-red-50 to-orange-50 border-red-200");

        const displayColor = hasRemainingOverdue
          ? (projectedScore >= 50 ? "#f59e0b" : projectedScore >= 30 ? "#f97316" : "#ef4444")
          : projectedInfo.color;

        return (
          <div className={`bg-gradient-to-r ${bgTint} rounded-xl p-4 transition-all border`}>
            <div className="flex items-center justify-between mb-3">
              <div className="text-center flex-1">
                <p className="text-[10px] uppercase tracking-wide text-gray-500 font-medium">Current</p>
                <p className="text-2xl font-bold text-gray-400 mt-0.5">{currentScore}</p>
              </div>

              <div className="flex items-center gap-2 px-3">
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" style={{ color: displayColor }}>
                  <path d="M5 12 L19 12" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
                  <path d="M14 7 L19 12 L14 17" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </div>

              <div className="text-center flex-1">
                <p className="text-[10px] uppercase tracking-wide text-gray-500 font-medium">After Repair</p>
                <p className="text-2xl font-bold mt-0.5" style={{ color: displayColor }}>{projectedScore}</p>
              </div>
            </div>

            <div className="bg-white/70 rounded-lg p-2.5 text-center">
              <p className="text-sm font-semibold" style={{ color: displayColor }}>
                +{improvement} point{improvement !== 1 ? "s" : ""} improvement
              </p>
              <p className="text-xs text-gray-500 mt-0.5">
                {selectedKeys.size} item{selectedKeys.size !== 1 ? "s" : ""} selected &middot; Score moves to &ldquo;{projectedInfo.label}&rdquo;
              </p>
            </div>
          </div>
        );
      })()}

      {!hasSelection && (
        <div className="bg-gray-50 border border-gray-200 rounded-xl p-4 text-center">
          <p className="text-sm text-gray-400">
            Tap items above to see your projected score improvement
          </p>
        </div>
      )}
    </div>
  );
}
