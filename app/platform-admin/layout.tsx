import { requirePlatformAdmin } from "@/lib/auth";
import { PlatformAdminLayoutClient } from "@/components/ui/PlatformAdminLayoutClient";
import { isCrmEnabled } from "@/lib/feature-flags/crm";

export default async function PlatformAdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await requirePlatformAdmin();

  return (
    <PlatformAdminLayoutClient userEmail={session.email} crmEnabled={isCrmEnabled()}>
      {children}
    </PlatformAdminLayoutClient>
  );
}
