import { requirePlatformAdmin } from "@/lib/auth";
import { PlatformAdminSidebar } from "@/components/ui/PlatformAdminSidebar";

export default async function PlatformAdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await requirePlatformAdmin();

  return (
    <div className="flex min-h-screen bg-gray-50">
      <PlatformAdminSidebar userEmail={session.email} />
      <main className="flex-1 overflow-auto">
        {children}
      </main>
    </div>
  );
}
