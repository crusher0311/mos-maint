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
  differential_front: (
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
  serpentine_belt: (
    <g>
      <circle cx="10" cy="10" r="4" fill="none" stroke="currentColor" strokeWidth="2" />
      <circle cx="22" cy="10" r="4" fill="none" stroke="currentColor" strokeWidth="2" />
      <circle cx="16" cy="22" r="4" fill="none" stroke="currentColor" strokeWidth="2" />
      <path d="M14 10 L18 10 M12 14 L12 19 M20 14 L20 19" stroke="currentColor" strokeWidth="1.5" />
    </g>
  ),
  transfer_case: (
    <g>
      <rect x="8" y="10" width="16" height="12" rx="2" fill="none" stroke="currentColor" strokeWidth="2" />
      <line x1="4" y1="16" x2="8" y2="16" stroke="currentColor" strokeWidth="2" />
      <line x1="24" y1="16" x2="28" y2="16" stroke="currentColor" strokeWidth="2" />
      <circle cx="16" cy="16" r="3" fill="none" stroke="currentColor" strokeWidth="1.5" />
    </g>
  ),
  battery: (
    <g>
      <rect x="8" y="10" width="16" height="16" rx="2" fill="none" stroke="currentColor" strokeWidth="2" />
      <rect x="12" y="6" width="3" height="4" rx="1" fill="currentColor" />
      <rect x="18" y="6" width="3" height="4" rx="1" fill="currentColor" />
      <line x1="12" y1="18" x2="20" y2="18" stroke="currentColor" strokeWidth="2" />
      <line x1="16" y1="15" x2="16" y2="21" stroke="currentColor" strokeWidth="2" />
    </g>
  ),
  power_steering: (
    <g>
      <circle cx="16" cy="16" r="10" fill="none" stroke="currentColor" strokeWidth="2" />
      <path d="M11 16 C11 16 13 12 16 12 C19 12 21 16 21 16" stroke="currentColor" strokeWidth="2" fill="none" />
      <line x1="16" y1="16" x2="16" y2="22" stroke="currentColor" strokeWidth="2" />
      <line x1="13" y1="22" x2="19" y2="22" stroke="currentColor" strokeWidth="2" />
    </g>
  ),
  fuel_system: (
    <g>
      <rect x="8" y="6" width="16" height="20" rx="3" fill="none" stroke="currentColor" strokeWidth="2" />
      <rect x="12" y="12" width="8" height="10" rx="1" fill="currentColor" opacity="0.2" />
      <line x1="14" y1="4" x2="14" y2="6" stroke="currentColor" strokeWidth="2" />
      <line x1="18" y1="4" x2="18" y2="6" stroke="currentColor" strokeWidth="2" />
    </g>
  ),
  coolant_hoses: (
    <g>
      <path d="M6 12 Q10 8 16 12 Q22 16 26 12" stroke="currentColor" strokeWidth="2" fill="none" />
      <path d="M6 20 Q10 16 16 20 Q22 24 26 20" stroke="currentColor" strokeWidth="2" fill="none" />
    </g>
  ),
  front_shocks: (
    <g>
      <line x1="16" y1="4" x2="16" y2="28" stroke="currentColor" strokeWidth="2" />
      <path d="M12 8 L20 12 L12 16 L20 20" stroke="currentColor" strokeWidth="2" fill="none" />
      <rect x="12" y="24" width="8" height="4" rx="1" fill="currentColor" opacity="0.3" />
    </g>
  ),
  rear_shocks: (
    <g>
      <line x1="16" y1="4" x2="16" y2="28" stroke="currentColor" strokeWidth="2" />
      <path d="M12 8 L20 12 L12 16 L20 20" stroke="currentColor" strokeWidth="2" fill="none" />
      <rect x="12" y="24" width="8" height="4" rx="1" fill="currentColor" opacity="0.3" />
    </g>
  ),
  wheel_alignment: (
    <g>
      <circle cx="16" cy="16" r="11" fill="none" stroke="currentColor" strokeWidth="2" />
      <line x1="16" y1="5" x2="16" y2="27" stroke="currentColor" strokeWidth="1" strokeDasharray="2 2" />
      <line x1="5" y1="16" x2="27" y2="16" stroke="currentColor" strokeWidth="1" strokeDasharray="2 2" />
      <circle cx="16" cy="16" r="3" fill="currentColor" opacity="0.4" />
    </g>
  ),
  lubricate: (
    <g>
      <path d="M16 4 C16 4 22 10 22 16 C22 20 19 24 16 24 C13 24 10 20 10 16 C10 10 16 4 16 4Z" fill="currentColor" opacity="0.15" stroke="currentColor" strokeWidth="2" />
      <line x1="16" y1="14" x2="16" y2="20" stroke="currentColor" strokeWidth="1.5" />
      <circle cx="16" cy="12" r="1.5" fill="currentColor" />
    </g>
  ),
  bolt_torque: (
    <g>
      <circle cx="16" cy="16" r="6" fill="none" stroke="currentColor" strokeWidth="2" />
      <path d="M16 10 L16 4 M16 22 L16 28 M10 16 L4 16 M22 16 L28 16" stroke="currentColor" strokeWidth="2" />
      <circle cx="16" cy="16" r="2" fill="currentColor" />
    </g>
  ),
  oil_reminder: (
    <g>
      <rect x="8" y="6" width="16" height="20" rx="2" fill="none" stroke="currentColor" strokeWidth="2" />
      <line x1="12" y1="12" x2="20" y2="12" stroke="currentColor" strokeWidth="1.5" />
      <line x1="12" y1="16" x2="20" y2="16" stroke="currentColor" strokeWidth="1.5" />
      <line x1="12" y1="20" x2="17" y2="20" stroke="currentColor" strokeWidth="1.5" />
    </g>
  ),
  chassis_body: (
    <g>
      <rect x="4" y="14" width="24" height="8" rx="2" fill="none" stroke="currentColor" strokeWidth="2" />
      <circle cx="10" cy="24" r="3" fill="none" stroke="currentColor" strokeWidth="2" />
      <circle cx="22" cy="24" r="3" fill="none" stroke="currentColor" strokeWidth="2" />
      <line x1="8" y1="14" x2="10" y2="8" stroke="currentColor" strokeWidth="2" />
      <line x1="24" y1="14" x2="22" y2="8" stroke="currentColor" strokeWidth="2" />
      <line x1="10" y1="8" x2="22" y2="8" stroke="currentColor" strokeWidth="2" />
    </g>
  ),
  general_service: (
    <g>
      <path d="M10 6 L22 6 L26 12 L26 24 L6 24 L6 12 Z" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
      <circle cx="16" cy="16" r="4" fill="none" stroke="currentColor" strokeWidth="2" />
      <line x1="16" y1="12" x2="16" y2="10" stroke="currentColor" strokeWidth="1.5" />
    </g>
  ),
};

const titleKeywordMap: Array<[string[], string]> = [
  [["propeller shaft", "prop shaft", "driveshaft", "drive shaft", "lubricate"], "lubricate"],
  [["torque", "re-torque", "retorque", "bolt", "nut"], "bolt_torque"],
  [["oil reminder", "maint reqd", "oil reset", "reset oil", "oil replacement reminder"], "oil_reminder"],
  [["chassis", "body", "tighten"], "chassis_body"],
  [["serpentine", "drive belt", "accessory belt", "v-belt", "timing belt"], "serpentine_belt"],
  [["transfer case"], "transfer_case"],
  [["differential front", "front differential"], "differential_front"],
  [["differential rear", "rear differential"], "differential_rear"],
  [["differential"], "differential_rear"],
  [["transmission", "trans fluid", "atf"], "transmission_fluid"],
  [["coolant hose", "radiator hose", "heater hose"], "coolant_hoses"],
  [["coolant", "antifreeze"], "coolant"],
  [["brake pad", "front brake", "rear brake", "brake shoe"], "brake_pads_front"],
  [["brake fluid"], "brake_fluid"],
  [["air filter", "engine filter"], "engine_air_filter"],
  [["cabin filter", "cabin air"], "cabin_air_filter"],
  [["spark plug", "ignition"], "spark_plugs"],
  [["oil change", "engine oil", "motor oil", "oil filter"], "oil_change"],
  [["tire rotat", "rotate tire"], "tires_rotate"],
  [["wiper", "windshield wiper"], "wiper_blades"],
  [["battery"], "battery"],
  [["power steering", "steering fluid"], "power_steering"],
  [["fuel system", "fuel inject", "fuel filter", "fuel induction"], "fuel_system"],
  [["shock", "strut", "suspension"], "front_shocks"],
  [["wheel align", "alignment"], "wheel_alignment"],
  [["inspect", "check", "examine", "visual"], "general_service"],
];

const imageIcons: Record<string, string> = {
  brake_pads_front: "/icons/service/brakes.svg",
  brake_pads_rear: "/icons/service/brakes.svg",
  brake_fluid: "/icons/service/brake_fluid.svg",
  wiper_blades: "/icons/service/wiper_blades.svg",
  transmission_fluid: "/icons/service/transmission_fluid.svg",
  engine_air_filter: "/icons/service/air_filter.svg",
  cabin_air_filter: "/icons/service/cabin_air_filter.svg",
  spark_plugs: "/icons/service/spark_plugs.svg",
  engine_oil: "/icons/service/oil_change.svg",
  oil_change: "/icons/service/oil_change.svg",
  tires_rotate: "/icons/service/tire_rotation.svg",
  coolant: "/icons/service/coolant.svg",
  differential_rear: "/icons/service/differential.svg",
  differential_front: "/icons/service/differential.svg",
  serpentine_belt: "/icons/service/serpentine_belt.svg",
  transfer_case: "/icons/service/transfer_case.svg",
  battery: "/icons/service/battery.svg",
  power_steering: "/icons/service/power_steering.svg",
  fuel_system: "/icons/service/fuel_system.svg",
  coolant_hoses: "/icons/service/coolant_hoses.svg",
  front_shocks: "/icons/service/shocks.svg",
  rear_shocks: "/icons/service/shocks.svg",
  wheel_alignment: "/icons/service/wheel_alignment.svg",
  lubricate: "/icons/service/lubricate.svg",
  bolt_torque: "/icons/service/bolt_torque.svg",
};

function resolveIconKey(serviceKey: string | null, title?: string): string {
  if (!serviceKey && !title) return "";

  if (serviceKey?.startsWith("dvi_finding") || serviceKey?.startsWith("dvi_unmapped")) return "dvi_finding";

  if (serviceKey && (imageIcons[serviceKey] || iconPaths[serviceKey])) return serviceKey;

  const titleLower = (title || serviceKey || "").toLowerCase();
  for (const [keywords, iconKey] of titleKeywordMap) {
    if (keywords.some(kw => titleLower.includes(kw))) return iconKey;
  }

  return "";
}

const defaultIcon = (
  <g>
    <path d="M10 6 L22 6 L26 12 L26 24 L6 24 L6 12 Z" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
    <circle cx="16" cy="16" r="4" fill="none" stroke="currentColor" strokeWidth="2" />
    <line x1="16" y1="12" x2="16" y2="10" stroke="currentColor" strokeWidth="1.5" />
  </g>
);

interface ServiceIconProps {
  serviceKey: string | null;
  title?: string;
  className?: string;
  size?: number;
}

export default function ServiceIcon({ serviceKey, title, className = "", size = 32 }: ServiceIconProps) {
  const key = resolveIconKey(serviceKey, title);

  const imgSrc = imageIcons[key];
  if (imgSrc) {
    return (
      <img
        src={imgSrc}
        alt=""
        width={size}
        height={size}
        className={`inline-block ${className}`}
        style={{ width: size, height: size, objectFit: "contain" }}
      />
    );
  }

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
