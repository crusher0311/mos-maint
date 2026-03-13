"use client";

import React from "react";

interface HealthGaugeProps {
  score: number;
}

function getScoreInfo(score: number) {
  if (score >= 90) return { label: "Excellent", color: "#22c55e", description: "Your vehicle is in great shape! Keep up with regular maintenance." };
  if (score >= 80) return { label: "Good Condition", color: "#84cc16", description: "Your vehicle is in good condition with only minor items to address." };
  if (score >= 70) return { label: "Needs Attention", color: "#f59e0b", description: "Your vehicle is safe to drive, but needs maintenance soon to prevent larger repairs." };
  if (score >= 60) return { label: "Poor Condition", color: "#f97316", description: "Your vehicle has significant maintenance needs. We recommend scheduling service soon." };
  return { label: "Critical", color: "#ef4444", description: "Your vehicle requires immediate attention. Several critical systems need service." };
}

export default function HealthGauge({ score }: HealthGaugeProps) {
  const { label, color, description } = getScoreInfo(score);
  const clampedScore = Math.max(0, Math.min(100, score));
  const rotation = -90 + (clampedScore / 100) * 180;

  return (
    <div className="flex flex-col items-center gap-2">
      <div className="relative w-[240px] h-[150px] sm:w-[280px] sm:h-[170px]">
        <svg viewBox="0 0 280 170" className="w-full h-full">
          <defs>
            <linearGradient id="gaugeGradient" x1="0%" y1="0%" x2="100%" y2="0%">
              <stop offset="0%" stopColor="#ef4444" />
              <stop offset="20%" stopColor="#f97316" />
              <stop offset="40%" stopColor="#f59e0b" />
              <stop offset="60%" stopColor="#eab308" />
              <stop offset="80%" stopColor="#84cc16" />
              <stop offset="100%" stopColor="#22c55e" />
            </linearGradient>
          </defs>

          <path
            d="M 30 150 A 110 110 0 0 1 250 150"
            fill="none"
            stroke="#e5e7eb"
            strokeWidth="22"
            strokeLinecap="round"
          />
          <path
            d="M 30 150 A 110 110 0 0 1 250 150"
            fill="none"
            stroke="url(#gaugeGradient)"
            strokeWidth="22"
            strokeLinecap="round"
          />

          <g transform={`rotate(${rotation}, 140, 150)`}>
            <polygon points="140,50 136,145 144,145" fill="#1e3a5f" />
            <circle cx="140" cy="150" r="10" fill="#1e3a5f" />
            <circle cx="140" cy="150" r="5" fill="white" />
          </g>

          <text x="128" y="128" textAnchor="end" style={{ fontSize: "52px", fill: "#1e3a5f", fontFamily: "system-ui, sans-serif", fontWeight: 800 }}>
            {clampedScore}
          </text>
          <text x="130" y="118" textAnchor="start" style={{ fontSize: "22px", fill: "#9ca3af", fontFamily: "system-ui, sans-serif" }}>
            /100
          </text>
        </svg>
      </div>

      <p className="text-lg sm:text-xl font-bold -mt-2" style={{ color }}>{label}</p>
      <p className="text-xs sm:text-sm text-gray-500 text-center max-w-sm px-4">{description}</p>
    </div>
  );
}

export { getScoreInfo };
