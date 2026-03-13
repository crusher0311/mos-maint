"use client";

import React from "react";

const iconPaths: Record<string, JSX.Element> = {
  brake_pads_front: (
    <g>
      <circle cx="16" cy="16" r="12" fill="none" stroke="currentColor" strokeWidth="2" />
      <circle cx="16" cy="16" r="6" fill="none" stroke="currentColor" strokeWidth="2" />
      <rect x="14" y="2" width="4" height="6" rx="1" fill="currentColor" opacity="0.5" />
    </g>
  ),
  brake_pads_rear: (
    <g>
      <circle cx="16" cy="16" r="12" fill="none" stroke="currentColor" strokeWidth="2" />
      <circle cx="16" cy="16" r="6" fill="none" stroke="currentColor" strokeWidth="2" />
      <rect x="14" y="2" width="4" height="6" rx="1" fill="currentColor" opacity="0.5" />
    </g>
  ),
  brake_fluid: (
    <g>
      <rect x="10" y="4" width="12" height="24" rx="2" fill="none" stroke="currentColor" strokeWidth="2" />
      <rect x="12" y="16" width="8" height="10" rx="1" fill="currentColor" opacity="0.3" />
      <line x1="12" y1="10" x2="20" y2="10" stroke="currentColor" strokeWidth="1" />
    </g>
  ),
  transmission_fluid: (
    <g>
      <circle cx="16" cy="16" r="10" fill="none" stroke="currentColor" strokeWidth="2" />
      <path d="M12 12 L20 20 M20 12 L12 20" stroke="currentColor" strokeWidth="2" />
      <circle cx="16" cy="16" r="3" fill="currentColor" opacity="0.3" />
    </g>
  ),
  engine_air_filter: (
    <g>
      <rect x="6" y="8" width="20" height="16" rx="2" fill="none" stroke="currentColor" strokeWidth="2" />
      <line x1="10" y1="11" x2="10" y2="21" stroke="currentColor" strokeWidth="1.5" />
      <line x1="14" y1="11" x2="14" y2="21" stroke="currentColor" strokeWidth="1.5" />
      <line x1="18" y1="11" x2="18" y2="21" stroke="currentColor" strokeWidth="1.5" />
      <line x1="22" y1="11" x2="22" y2="21" stroke="currentColor" strokeWidth="1.5" />
    </g>
  ),
  cabin_air_filter: (
    <g>
      <rect x="6" y="8" width="20" height="16" rx="2" fill="none" stroke="currentColor" strokeWidth="2" />
      <line x1="10" y1="11" x2="10" y2="21" stroke="currentColor" strokeWidth="1.5" />
      <line x1="14" y1="11" x2="14" y2="21" stroke="currentColor" strokeWidth="1.5" />
      <line x1="18" y1="11" x2="18" y2="21" stroke="currentColor" strokeWidth="1.5" />
      <line x1="22" y1="11" x2="22" y2="21" stroke="currentColor" strokeWidth="1.5" />
    </g>
  ),
  spark_plugs: (
    <g>
      <rect x="13" y="2" width="6" height="10" rx="1" fill="none" stroke="currentColor" strokeWidth="2" />
      <line x1="16" y1="12" x2="16" y2="22" stroke="currentColor" strokeWidth="2" />
      <path d="M13 22 L16 28 L19 22" fill="none" stroke="currentColor" strokeWidth="2" />
    </g>
  ),
  oil_change: (
    <g>
      <path d="M16 4 C16 4 22 10 22 16 C22 20 19 24 16 24 C13 24 10 20 10 16 C10 10 16 4 16 4Z" fill="currentColor" opacity="0.2" stroke="currentColor" strokeWidth="2" />
    </g>
  ),
  tires_rotate: (
    <g>
      <circle cx="16" cy="16" r="11" fill="none" stroke="currentColor" strokeWidth="2" />
      <circle cx="16" cy="16" r="5" fill="none" stroke="currentColor" strokeWidth="2" />
      <circle cx="16" cy="16" r="2" fill="currentColor" />
    </g>
  ),
  coolant: (
    <g>
      <rect x="11" y="4" width="10" height="22" rx="2" fill="none" stroke="currentColor" strokeWidth="2" />
      <path d="M14 8 L18 8 M14 12 L18 12 M14 16 L18 16" stroke="currentColor" strokeWidth="1.5" />
      <rect x="13" y="18" width="6" height="6" rx="1" fill="currentColor" opacity="0.3" />
    </g>
  ),
  wiper_blades: (
    <g>
      <line x1="16" y1="28" x2="16" y2="8" stroke="currentColor" strokeWidth="2" />
      <rect x="12" y="6" width="8" height="4" rx="1" fill="none" stroke="currentColor" strokeWidth="2" />
    </g>
  ),
  differential_rear: (
    <g>
      <circle cx="16" cy="16" r="10" fill="none" stroke="currentColor" strokeWidth="2" />
      <circle cx="16" cy="16" r="4" fill="none" stroke="currentColor" strokeWidth="2" />
      <line x1="6" y1="16" x2="12" y2="16" stroke="currentColor" strokeWidth="2" />
      <line x1="20" y1="16" x2="26" y2="16" stroke="currentColor" strokeWidth="2" />
    </g>
  ),
  dvi_finding: (
    <g>
      <path d="M16 4 L28 26 L4 26 Z" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
      <line x1="16" y1="12" x2="16" y2="19" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
      <circle cx="16" cy="23" r="1.5" fill="currentColor" />
    </g>
  ),
};

const defaultIcon = (
  <g>
    <circle cx="16" cy="16" r="10" fill="none" stroke="currentColor" strokeWidth="2" />
    <path d="M13 13 C13 10 19 10 19 13 C19 15 16 15 16 18" stroke="currentColor" strokeWidth="2" fill="none" strokeLinecap="round" />
    <circle cx="16" cy="22" r="1.5" fill="currentColor" />
  </g>
);

interface ServiceIconProps {
  serviceKey: string | null;
  className?: string;
  size?: number;
}

export default function ServiceIcon({ serviceKey, className = "", size = 32 }: ServiceIconProps) {
  const key = serviceKey?.startsWith("dvi_finding") ? "dvi_finding" : serviceKey ?? "";
  const icon = iconPaths[key] || defaultIcon;

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      className={className}
      fill="none"
    >
      {icon}
    </svg>
  );
}
