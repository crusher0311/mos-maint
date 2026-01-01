"use client";

import CopyFromLocationDropdown from "@/components/ui/CopyFromLocationDropdown";

export default function MaintenanceHeader() {
  return (
    <div className="flex items-center justify-between">
      <h1 className="text-2xl font-semibold text-gray-900">Maintenance Thresholds</h1>
      <CopyFromLocationDropdown
        settingType="maintenance"
        onCopyComplete={() => window.location.reload()}
      />
    </div>
  );
}
