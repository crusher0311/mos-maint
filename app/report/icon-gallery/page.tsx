"use client";
import { useState } from "react";

const sheet1Icons = [
  { name: "s1_0_0_car_diagnostics__outline_", label: "Car Diagnostics (outline)" },
  { name: "s1_0_1_wrench__outline_", label: "Wrench (outline)" },
  { name: "s1_0_2_clock_timing__outline_", label: "Clock/Timing (outline)" },
  { name: "s1_0_3_shield_drivetrain__outline_", label: "Shield+Drivetrain (outline)" },
  { name: "s1_0_4_steering_wheel__outline_", label: "Steering Wheel (outline)" },
  { name: "s1_0_5_car_diagnostics__filled_", label: "Car Diagnostics (filled)" },
  { name: "s1_0_6_wrench__filled_", label: "Wrench (filled)" },
  { name: "s1_0_7_clock_timing__filled_", label: "Clock/Timing (filled)" },
  { name: "s1_0_8_shield_drivetrain__filled_", label: "Shield+Drivetrain (filled)" },
  { name: "s1_0_9_steering_wheel__filled_", label: "Steering Wheel (filled)" },
  { name: "s1_1_0_heart_engine__outline_", label: "Heart/Engine (outline)" },
  { name: "s1_1_1_spark_plug__outline_", label: "Spark Plug (outline)" },
  { name: "s1_1_2_car_door_lock__outline_", label: "Car Door+Lock (outline)" },
  { name: "s1_1_3_exhaust_wind__outline_", label: "Exhaust/Wind (outline)" },
  { name: "s1_1_4_nut_wrench__outline_", label: "Nut+Wrench (outline)" },
  { name: "s1_1_5_heart_engine__filled_", label: "Heart/Engine (filled)" },
  { name: "s1_1_6_spark_plug__filled_", label: "Spark Plug (filled)" },
  { name: "s1_1_7_car_door_lock__filled_", label: "Car Door+Lock (filled)" },
  { name: "s1_1_8_exhaust_wind__filled_", label: "Exhaust/Wind (filled)" },
  { name: "s1_1_9_magnifying_glass__filled_", label: "Magnifying Glass (filled)" },
  { name: "s1_2_0_crossed_wrenches__outline_", label: "Crossed Wrenches (outline)" },
  { name: "s1_2_1_alignment_target__outline_", label: "Alignment Target (outline)" },
  { name: "s1_2_2_key_fob__outline_", label: "Key Fob (outline)" },
  { name: "s1_2_3_spring_coil__outline_", label: "Spring/Coil (outline)" },
  { name: "s1_2_4_feather__outline_", label: "Feather (outline)" },
  { name: "s1_2_5_nut_bolt__outline_", label: "Nut/Bolt (outline)" },
  { name: "s1_2_6_crossed_wrenches__filled_", label: "Crossed Wrenches (filled)" },
  { name: "s1_2_7_alignment_target__filled_", label: "Alignment Target (filled)" },
  { name: "s1_2_8_key_fob__filled_", label: "Key Fob (filled)" },
  { name: "s1_2_9_spring_nut__filled_", label: "Spring+Nut (filled)" },
];

const sheet2Icons = [
  { name: "s2_0_0_engine_motor", label: "Engine/Motor" },
  { name: "s2_0_1_shock_absorber", label: "Shock Absorber" },
  { name: "s2_0_2_battery", label: "Battery" },
  { name: "s2_0_3_spark_plug", label: "Spark Plug" },
  { name: "s2_0_4_oil_filter", label: "Oil Filter" },
  { name: "s2_0_5_brake_rotor", label: "Brake Rotor" },
  { name: "s2_0_6_air_filter", label: "Air Filter" },
  { name: "s2_0_7_cabin_filter", label: "Cabin Filter" },
  { name: "s2_1_0_exhaust_muffler", label: "Exhaust/Muffler" },
  { name: "s2_1_1_brake_disc_detail", label: "Brake Disc Detail" },
  { name: "s2_1_2_alternator", label: "Alternator" },
  { name: "s2_1_3_gas_pump", label: "Gas Pump" },
  { name: "s2_1_4_drive_belt", label: "Drive Belt" },
  { name: "s2_1_5_light_bulb", label: "Light Bulb" },
  { name: "s2_1_6_side_mirror", label: "Side Mirror" },
  { name: "s2_1_7_warning_light", label: "Warning Light" },
  { name: "s2_2_0_steering_wheel", label: "Steering Wheel" },
  { name: "s2_2_1_windshield", label: "Windshield" },
  { name: "s2_2_2_side_mirror_alt", label: "Side Mirror Alt" },
  { name: "s2_2_3_car_seat", label: "Car Seat" },
  { name: "s2_2_4_emergency_light", label: "Emergency Light" },
  { name: "s2_2_5_wiper_blade", label: "Wiper Blade" },
  { name: "s2_2_6_windshield_alt", label: "Windshield Alt" },
  { name: "s2_2_7_door_window", label: "Door Window" },
  { name: "s2_3_0_car_seat_alt", label: "Car Seat Alt" },
  { name: "s2_3_1_radiator", label: "Radiator" },
  { name: "s2_3_2_door_handle", label: "Door Handle" },
  { name: "s2_3_3_car_profile", label: "Car Profile" },
  { name: "s2_3_4_gear_shift", label: "Gear Shift" },
  { name: "s2_3_5_hood_trunk", label: "Hood/Trunk" },
  { name: "s2_3_6_spoiler", label: "Spoiler" },
  { name: "s2_3_7_car_front", label: "Car Front" },
];

const sheet3Icons = [
  { name: "s3_r0_c0", label: "Tire" },
  { name: "s3_r0_c1", label: "Turbo/Compressor" },
  { name: "s3_r0_c2", label: "Engine Block" },
  { name: "s3_r0_c3", label: "Battery" },
  { name: "s3_r1_c0", label: "Brake Disc" },
  { name: "s3_r1_c1", label: "Brake Drum" },
  { name: "s3_r1_c2", label: "Gear/Sprocket" },
  { name: "s3_r1_c3", label: "Spark Plug" },
];

const sheetFullImages: Record<string, string> = {
  s1: "/icons/service/icon_sheet.svg",
  s2: "/icons/service/icon_sheet_2.svg",
  s3: "/icons/service/icon_sheet_3.svg",
};

export default function IconGallery() {
  const [tab, setTab] = useState<"s1" | "s2" | "s3" | "all">("all");
  const [size, setSize] = useState(120);

  const getIcons = () => {
    if (tab === "s1") return sheet1Icons;
    if (tab === "s2") return sheet2Icons;
    if (tab === "s3") return sheet3Icons;
    return [...sheet1Icons, ...sheet2Icons, ...sheet3Icons];
  };

  return (
    <div style={{ padding: 24, fontFamily: "system-ui", background: "#f5f5f5", minHeight: "100vh" }}>
      <h1 style={{ fontSize: 24, marginBottom: 8 }}>Icon Gallery - All Extracted Icons</h1>
      <p style={{ fontSize: 14, color: "#666", marginBottom: 16 }}>
        {sheet1Icons.length + sheet2Icons.length + sheet3Icons.length} total icons from 3 sheets.
        Filter by sheet or view all. Each card shows the icon name for reference.
      </p>

      <div style={{ display: "flex", gap: 12, marginBottom: 20, alignItems: "center", flexWrap: "wrap" }}>
        {(["all", "s1", "s2", "s3"] as const).map(t => (
          <button
            key={t}
            onClick={() => setTab(t)}
            style={{
              padding: "8px 16px",
              borderRadius: 8,
              border: tab === t ? "2px solid #2563eb" : "1px solid #ccc",
              background: tab === t ? "#2563eb" : "#fff",
              color: tab === t ? "#fff" : "#333",
              cursor: "pointer",
              fontWeight: tab === t ? 700 : 400,
            }}
          >
            {t === "all" ? `All (${sheet1Icons.length + sheet2Icons.length + sheet3Icons.length})` :
             t === "s1" ? `Sheet 1 - Symbolic (${sheet1Icons.length})` :
             t === "s2" ? `Sheet 2 - Line Art (${sheet2Icons.length})` :
             `Sheet 3 - Detailed (${sheet3Icons.length})`}
          </button>
        ))}

        <span style={{ marginLeft: 24, fontSize: 14, color: "#666" }}>Size:</span>
        {[80, 120, 180].map(s => (
          <button
            key={s}
            onClick={() => setSize(s)}
            style={{
              padding: "4px 12px",
              borderRadius: 6,
              border: size === s ? "2px solid #2563eb" : "1px solid #ccc",
              background: size === s ? "#dbeafe" : "#fff",
              cursor: "pointer",
              fontSize: 13,
            }}
          >
            {s}px
          </button>
        ))}
      </div>

      {tab !== "all" && sheetFullImages[tab] && (
        <div style={{ marginBottom: 24, background: "#fff", padding: 16, borderRadius: 12, border: "1px solid #ddd" }}>
          <h3 style={{ fontSize: 14, color: "#666", marginBottom: 8 }}>Full Sheet Reference:</h3>
          <img
            src={sheetFullImages[tab]}
            alt={`Sheet ${tab} full preview`}
            style={{ maxWidth: "100%", maxHeight: 300, objectFit: "contain", border: "1px solid #eee", borderRadius: 8 }}
          />
        </div>
      )}

      <div style={{ display: "flex", flexWrap: "wrap", gap: 12 }}>
        {getIcons().map(icon => (
          <div
            key={icon.name}
            style={{
              width: size + 24,
              textAlign: "center",
              border: "1px solid #ddd",
              borderRadius: 8,
              padding: 12,
              background: "#fff",
            }}
          >
            <div style={{
              width: size,
              height: size,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              background: "#fafafa",
              borderRadius: 6,
              overflow: "hidden",
            }}>
              <img
                src={`/icons/service/extracted/${icon.name}.svg`}
                alt={icon.label}
                style={{ width: size - 16, height: size - 16, objectFit: "contain" }}
              />
            </div>
            <div style={{ fontSize: 11, color: "#333", marginTop: 6, fontWeight: 600, lineHeight: 1.3 }}>
              {icon.label}
            </div>
            <div style={{ fontSize: 9, color: "#aaa", marginTop: 2, wordBreak: "break-all" }}>
              {icon.name}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
