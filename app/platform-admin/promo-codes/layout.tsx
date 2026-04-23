import { notFound } from "next/navigation";
import { isCrmEnabled } from "@/lib/feature-flags/crm";

export default function GatedLayout({ children }: { children: React.ReactNode }) {
  if (!isCrmEnabled()) notFound();
  return <>{children}</>;
}
