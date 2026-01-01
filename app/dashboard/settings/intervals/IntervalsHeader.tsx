"use client";

import CopyFromLocationDropdown from "@/components/ui/CopyFromLocationDropdown";

export default function IntervalsHeader() {
  return (
    <div className="flex items-center justify-between">
      <h1 className="text-2xl font-semibold text-gray-900">Shop Maintenance Intervals</h1>
      <CopyFromLocationDropdown
        settingType="intervals"
        onCopyComplete={() => window.location.reload()}
      />
    </div>
  );
}
