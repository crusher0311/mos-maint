"use client";
import { useParams } from "next/navigation";
import { StaffInspectionPanel } from "@/components/shop-dispatch/StaffInspectionPanel";
export default function InspectionPage() {
  const params = useParams<{visitId: string}>();
  return <main className="mx-auto max-w-7xl p-4">
    <p className="mb-4"><a href="/dashboard/shop-workflow">Back to Shop Workflow</a></p>
    {params?.visitId ? <StaffInspectionPanel visitId={params.visitId} /> : <p>Choose a workflow visit to open DVI.</p>}
  </main>;
}
