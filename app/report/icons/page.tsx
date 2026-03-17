"use client";

import React from "react";
import ServiceIcon from "@/components/vehicle-health-report/ServiceIcon";

const allIcons = [
  { key: "brake_pads_front", label: "Front Brake Pads", mappedTitles: "brake pad, front brake" },
  { key: "brake_pads_rear", label: "Rear Brake Pads", mappedTitles: "rear brake, brake shoe" },
  { key: "brake_fluid", label: "Brake Fluid", mappedTitles: "brake fluid" },
  { key: "transmission_fluid", label: "Transmission Fluid", mappedTitles: "transmission, trans fluid, atf" },
  { key: "engine_air_filter", label: "Engine Air Filter", mappedTitles: "air filter, engine filter" },
  { key: "cabin_air_filter", label: "Cabin Air Filter", mappedTitles: "cabin filter, cabin air" },
  { key: "spark_plugs", label: "Spark Plugs", mappedTitles: "spark plug, ignition" },
  { key: "oil_change", label: "Oil Change", mappedTitles: "oil change, engine oil, motor oil, oil filter" },
  { key: "tires_rotate", label: "Tire Rotation", mappedTitles: "tire rotat, rotate tire" },
  { key: "coolant", label: "Coolant Service", mappedTitles: "coolant, antifreeze" },
  { key: "wiper_blades", label: "Wiper Blades", mappedTitles: "wiper, windshield wiper" },
  { key: "differential_front", label: "Front Differential", mappedTitles: "differential front, front differential" },
  { key: "differential_rear", label: "Rear Differential", mappedTitles: "differential rear, rear differential, differential" },
  { key: "serpentine_belt", label: "Serpentine Belt", mappedTitles: "serpentine, drive belt, accessory belt, v-belt, timing belt" },
  { key: "transfer_case", label: "Transfer Case", mappedTitles: "transfer case" },
  { key: "battery", label: "Battery", mappedTitles: "battery" },
  { key: "power_steering", label: "Power Steering", mappedTitles: "power steering, steering fluid" },
  { key: "fuel_system", label: "Fuel System", mappedTitles: "fuel system, fuel inject, fuel filter, fuel induction" },
  { key: "coolant_hoses", label: "Coolant Hoses", mappedTitles: "coolant hose, radiator hose, heater hose" },
  { key: "front_shocks", label: "Front Shocks / Struts", mappedTitles: "shock, strut, suspension" },
  { key: "rear_shocks", label: "Rear Shocks / Struts", mappedTitles: "(same icon as front shocks)" },
  { key: "wheel_alignment", label: "Wheel Alignment", mappedTitles: "wheel align, alignment" },
  { key: "lubricate", label: "Lubrication", mappedTitles: "propeller shaft, prop shaft, driveshaft, lubricate" },
  { key: "bolt_torque", label: "Bolt / Torque", mappedTitles: "torque, re-torque, bolt, nut" },
  { key: "oil_reminder", label: "Oil Reminder / Reset", mappedTitles: "oil reminder, maint reqd, oil reset" },
  { key: "chassis_body", label: "Chassis / Body", mappedTitles: "chassis, body, tighten" },
  { key: "general_service", label: "General Service", mappedTitles: "inspect, check, examine, visual" },
  { key: "dvi_finding", label: "DVI Finding", mappedTitles: "dvi findings, inspection alerts" },
];

export default function IconReferencePage() {
  return (
    <div className="min-h-screen bg-gray-50 py-8 px-4">
      <div className="max-w-5xl mx-auto">
        <h1 className="text-2xl font-bold text-gray-900 mb-2">Service Icon Reference</h1>
        <p className="text-sm text-gray-500 mb-6">
          All available icons for the Vehicle Health Report. Each icon auto-maps to service items by matching the title keywords shown below.
        </p>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {allIcons.map((icon) => (
            <div key={icon.key} className="bg-white rounded-lg border border-gray-200 p-4 flex items-start gap-4">
              <div className="flex flex-col items-center gap-1 flex-shrink-0">
                <div className="w-14 h-14 rounded-lg bg-gray-100 flex items-center justify-center text-gray-700">
                  <ServiceIcon serviceKey={icon.key} size={36} />
                </div>
                <div className="w-14 h-14 rounded-lg bg-red-50 flex items-center justify-center text-red-600">
                  <ServiceIcon serviceKey={icon.key} size={36} />
                </div>
                <div className="w-14 h-14 rounded-lg bg-green-50 flex items-center justify-center text-green-600">
                  <ServiceIcon serviceKey={icon.key} size={36} />
                </div>
              </div>
              <div className="flex-1 min-w-0">
                <h3 className="font-semibold text-sm text-gray-900">{icon.label}</h3>
                <p className="text-[11px] text-gray-400 font-mono mt-0.5">{icon.key}</p>
                <p className="text-xs text-gray-500 mt-2 leading-relaxed">
                  <span className="font-medium text-gray-600">Matches: </span>
                  {icon.mappedTitles}
                </p>
              </div>
            </div>
          ))}
        </div>

        <div className="mt-8 bg-white rounded-lg border border-gray-200 p-5">
          <h2 className="font-bold text-gray-900 mb-2">Default Fallback Icon</h2>
          <div className="flex items-center gap-4">
            <div className="w-14 h-14 rounded-lg bg-gray-100 flex items-center justify-center text-gray-700">
              <ServiceIcon serviceKey="__unknown__" size={36} />
            </div>
            <p className="text-sm text-gray-600">
              Any service item that doesn&apos;t match a keyword above gets this generic service icon.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
