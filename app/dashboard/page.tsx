// app/dashboard/page.tsx
import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { getDashboardBaselineToken } from "@/lib/data/repositories/dashboard-updates";
import DashboardClient from "./DashboardClient";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export default async function DashboardPage() {
  const session = await getSession();
  if (!session) {
    redirect("/login");
  }

  const user = {
    email: session.email!,
    role: session.role!,
    shopId: session.shopId!,
  };
  let dashboardUpdateToken = "0:0:0:0";
  try {
    dashboardUpdateToken = await getDashboardBaselineToken(session.shopId);
  } catch {
    // The client will retry the authenticated updates endpoint. Do not make
    // the dashboard unavailable merely because the optional baseline read
    // failed.
  }

  // Pass minimal initial data - let client always fetch fresh data from API
  // This ensures SSR and client use the same data source (the API)
  // The client will show a loading state while fetching
  const initialData = {
    rows: [],
    pagination: {
      page: 1,
      pageSize: 100,
      totalCount: 0,
      totalPages: 0,
      hasNextPage: false,
      hasPrevPage: false
    },
    user,
    smsType: "autoflow",
    dashboardUpdateToken,
    _needsRefresh: true // Signal to client to fetch immediately
  };

  return <DashboardClient initialData={initialData} />;
}
