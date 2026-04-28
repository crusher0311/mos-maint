// app/admin/layout.tsx
import { redirect } from "next/navigation";
import { requireSession } from "@/lib/auth";
import Link from "next/link";

export const dynamic = "force-dynamic";

export default async function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await requireSession();
  
  // Only allow admin or platform_admin role
  if (session.role !== "admin" && session.role !== "platform_admin") {
    redirect("/dashboard");
  }

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Admin Header */}
      <header className="bg-white shadow">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex justify-between items-center py-6">
            <div className="flex items-center">
              <h1 className="text-2xl font-bold text-gray-900">
                MOS Admin Panel
              </h1>
            </div>
            <div className="flex items-center space-x-4">
              <span className="text-sm text-gray-500">
                {session.email}
              </span>
              <Link
                href="/dashboard"
                className="text-sm text-mos-blue hover:text-mos-blue-dark"
              >
                Back to Dashboard
              </Link>
            </div>
          </div>
        </div>
      </header>

      <div className="max-w-7xl mx-auto py-6 sm:px-6 lg:px-8">
        <div className="px-4 py-6 sm:px-0">
          <div className="flex">
            {/* Sidebar Navigation */}
            <nav className="w-64 bg-white rounded-lg shadow mr-6">
              <div className="p-6">
                <h2 className="text-lg font-medium text-gray-900 mb-4">
                  Administration
                </h2>
                <ul className="space-y-2">
                  <li>
                    <Link
                      href="/admin"
                      className="block px-3 py-2 rounded-md text-sm font-medium text-gray-700 hover:text-gray-900 hover:bg-gray-50"
                    >
                      Dashboard
                    </Link>
                  </li>
                  <li>
                    <Link
                      href="/admin/shops"
                      className="block px-3 py-2 rounded-md text-sm font-medium text-gray-700 hover:text-gray-900 hover:bg-gray-50"
                    >
                      Shops
                    </Link>
                  </li>
                  <li>
                    <Link
                      href="/admin/users"
                      className="block px-3 py-2 rounded-md text-sm font-medium text-gray-700 hover:text-gray-900 hover:bg-gray-50"
                    >
                      Users
                    </Link>
                  </li>
                  <li>
                    <Link
                      href="/admin/analytics"
                      className="block px-3 py-2 rounded-md text-sm font-medium text-gray-700 hover:text-gray-900 hover:bg-gray-50"
                    >
                      Analytics
                    </Link>
                  </li>
                  <li>
                    <Link
                      href="/admin/billing"
                      className="block px-3 py-2 rounded-md text-sm font-medium text-gray-700 hover:text-gray-900 hover:bg-gray-50"
                    >
                      Billing
                    </Link>
                  </li>
                  <li>
                    <Link
                      href="/admin/features"
                      className="block px-3 py-2 rounded-md text-sm font-medium text-gray-700 hover:text-gray-900 hover:bg-gray-50"
                    >
                      Features
                    </Link>
                  </li>
                  <li>
                    <Link
                      href="/admin/integrations"
                      className="block px-3 py-2 rounded-md text-sm font-medium text-gray-700 hover:text-gray-900 hover:bg-gray-50"
                    >
                      Integrations
                    </Link>
                  </li>
                  <li>
                    <Link
                      href="/admin/system"
                      className="block px-3 py-2 rounded-md text-sm font-medium text-gray-700 hover:text-gray-900 hover:bg-gray-50"
                    >
                      System Health
                    </Link>
                  </li>
                  <li>
                    <Link
                      href="/admin/audit-logs"
                      className="block px-3 py-2 rounded-md text-sm font-medium text-gray-700 hover:text-gray-900 hover:bg-gray-50"
                    >
                      Audit Log
                    </Link>
                  </li>
                </ul>
              </div>
            </nav>

            {/* Main Content */}
            <main className="flex-1 bg-white rounded-lg shadow">
              <div className="p-6">
                {children}
              </div>
            </main>
          </div>
        </div>
      </div>
    </div>
  );
}