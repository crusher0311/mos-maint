import { requirePlatformAdmin } from "@/lib/auth";
import { PlatformAdminLayoutClient } from "@/components/ui/PlatformAdminLayoutClient";

export default async function PlatformAdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await requirePlatformAdmin();

  return (
    <PlatformAdminLayoutClient userEmail={session.email}>
      {children}
    </PlatformAdminLayoutClient>
  );
}
