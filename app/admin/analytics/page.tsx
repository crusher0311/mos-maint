// app/admin/analytics/page.tsx
import sql from "@/lib/db/postgres";

export const dynamic = "force-dynamic";

async function getAnalyticsData() {
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  
  const [
    shopsResult,
    usersResult,
    customersResult,
    vehiclesResult,
    activeShopsResult,
    newShopsResult,
    newUsersResult,
    eventsBySourceResult,
    topShopsResult,
    dailyActivityResult
  ] = await Promise.all([
    sql`SELECT COUNT(*) as count FROM shops`,
    sql`SELECT COUNT(*) as count FROM users`,
    sql`SELECT COUNT(*) as count FROM customers`,
    sql`SELECT COUNT(*) as count FROM vehicles`,
    sql`SELECT COUNT(DISTINCT shop_id) as count FROM events WHERE received_at >= ${thirtyDaysAgo}`,
    sql`SELECT COUNT(*) as count FROM shops WHERE created_at >= ${thirtyDaysAgo}`,
    sql`SELECT COUNT(*) as count FROM users WHERE created_at >= ${thirtyDaysAgo}`,
    sql`SELECT source as _id, COUNT(*) as count FROM events GROUP BY source ORDER BY count DESC`,
    sql`
      SELECT e.shop_id as _id, COUNT(*) as "eventCount", s.name as "shopName"
      FROM events e
      LEFT JOIN shops s ON e.shop_id = s.shop_id
      WHERE e.received_at >= ${thirtyDaysAgo}
      GROUP BY e.shop_id, s.name
      ORDER BY "eventCount" DESC
      LIMIT 10
    `,
    sql`
      SELECT DATE(received_at) as _id, COUNT(*) as count
      FROM events
      WHERE received_at >= ${sevenDaysAgo}
      GROUP BY DATE(received_at)
      ORDER BY _id ASC
    `
  ]);

  return {
    overview: {
      totalShops: Number(shopsResult[0]?.count || 0),
      totalUsers: Number(usersResult[0]?.count || 0),
      totalCustomers: Number(customersResult[0]?.count || 0),
      totalVehicles: Number(vehiclesResult[0]?.count || 0),
      activeShopsLast30Days: Number(activeShopsResult[0]?.count || 0),
      newShopsLast30Days: Number(newShopsResult[0]?.count || 0),
      newUsersLast30Days: Number(newUsersResult[0]?.count || 0)
    },
    eventsBySource: eventsBySourceResult,
    topShopsByActivity: topShopsResult,
    dailyActivity: dailyActivityResult
  };
}

export default async function AdminAnalyticsPage() {
  const analytics = await getAnalyticsData();

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Platform Analytics</h1>
        <p className="mt-1 text-sm text-gray-500">
          Insights into platform usage and performance
        </p>
      </div>

      {/* Overview Stats */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
        <div className="bg-white overflow-hidden shadow rounded-lg">
          <div className="p-5">
            <div className="flex items-center">
              <div className="flex-shrink-0">
                <div className="w-8 h-8 bg-mos-blue rounded-md flex items-center justify-center">
                  <span className="text-white text-sm font-medium">S</span>
                </div>
              </div>
              <div className="ml-5 w-0 flex-1">
                <dl>
                  <dt className="text-sm font-medium text-gray-500 truncate">
                    Total Shops
                  </dt>
                  <dd className="text-lg font-medium text-gray-900">
                    {analytics.overview.totalShops}
                  </dd>
                  <dd className="text-sm text-gray-500">
                    +{analytics.overview.newShopsLast30Days} this month
                  </dd>
                </dl>
              </div>
            </div>
          </div>
        </div>

        <div className="bg-white overflow-hidden shadow rounded-lg">
          <div className="p-5">
            <div className="flex items-center">
              <div className="flex-shrink-0">
                <div className="w-8 h-8 bg-green-500 rounded-md flex items-center justify-center">
                  <span className="text-white text-sm font-medium">A</span>
                </div>
              </div>
              <div className="ml-5 w-0 flex-1">
                <dl>
                  <dt className="text-sm font-medium text-gray-500 truncate">
                    Active Shops
                  </dt>
                  <dd className="text-lg font-medium text-gray-900">
                    {analytics.overview.activeShopsLast30Days}
                  </dd>
                  <dd className="text-sm text-gray-500">
                    Last 30 days
                  </dd>
                </dl>
              </div>
            </div>
          </div>
        </div>

        <div className="bg-white overflow-hidden shadow rounded-lg">
          <div className="p-5">
            <div className="flex items-center">
              <div className="flex-shrink-0">
                <div className="w-8 h-8 bg-blue-500 rounded-md flex items-center justify-center">
                  <span className="text-white text-sm font-medium">U</span>
                </div>
              </div>
              <div className="ml-5 w-0 flex-1">
                <dl>
                  <dt className="text-sm font-medium text-gray-500 truncate">
                    Total Users
                  </dt>
                  <dd className="text-lg font-medium text-gray-900">
                    {analytics.overview.totalUsers}
                  </dd>
                  <dd className="text-sm text-gray-500">
                    +{analytics.overview.newUsersLast30Days} this month
                  </dd>
                </dl>
              </div>
            </div>
          </div>
        </div>

        <div className="bg-white overflow-hidden shadow rounded-lg">
          <div className="p-5">
            <div className="flex items-center">
              <div className="flex-shrink-0">
                <div className="w-8 h-8 bg-mos-blue rounded-md flex items-center justify-center">
                  <span className="text-white text-sm font-medium">V</span>
                </div>
              </div>
              <div className="ml-5 w-0 flex-1">
                <dl>
                  <dt className="text-sm font-medium text-gray-500 truncate">
                    Total Vehicles
                  </dt>
                  <dd className="text-lg font-medium text-gray-900">
                    {analytics.overview.totalVehicles}
                  </dd>
                  <dd className="text-sm text-gray-500">
                    Across all shops
                  </dd>
                </dl>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Events by Source */}
        <div className="bg-white shadow rounded-lg">
          <div className="px-4 py-5 sm:p-6">
            <h3 className="text-lg leading-6 font-medium text-gray-900 mb-4">
              Events by Source
            </h3>
            <div className="space-y-3">
              {analytics.eventsBySource.length === 0 ? (
                <p className="text-sm text-gray-500">No events found</p>
              ) : (
                analytics.eventsBySource.map((source) => (
                  <div key={source._id} className="flex items-center justify-between">
                    <span className="text-sm font-medium text-gray-900">
                      {source._id || 'Unknown'}
                    </span>
                    <span className="text-sm text-gray-500">
                      {source.count.toLocaleString()} events
                    </span>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>

        {/* Top Active Shops */}
        <div className="bg-white shadow rounded-lg">
          <div className="px-4 py-5 sm:p-6">
            <h3 className="text-lg leading-6 font-medium text-gray-900 mb-4">
              Most Active Shops (30 days)
            </h3>
            <div className="space-y-3">
              {analytics.topShopsByActivity.length === 0 ? (
                <p className="text-sm text-gray-500">No activity found</p>
              ) : (
                analytics.topShopsByActivity.map((shop, index) => (
                  <div key={shop._id} className="flex items-center justify-between">
                    <div className="flex items-center">
                      <span className="text-sm font-medium text-gray-400 mr-3">
                        #{index + 1}
                      </span>
                      <span className="text-sm font-medium text-gray-900">
                        {shop.shopName || `Shop ${shop._id}`}
                      </span>
                    </div>
                    <span className="text-sm text-gray-500">
                      {shop.eventCount.toLocaleString()} events
                    </span>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Daily Activity Chart */}
      <div className="bg-white shadow rounded-lg">
        <div className="px-4 py-5 sm:p-6">
          <h3 className="text-lg leading-6 font-medium text-gray-900 mb-4">
            Daily Activity (Last 7 Days)
          </h3>
          <div className="space-y-2">
            {analytics.dailyActivity.length === 0 ? (
              <p className="text-sm text-gray-500">No recent activity</p>
            ) : (
              analytics.dailyActivity.map((day) => (
                <div key={day._id} className="flex items-center justify-between py-2">
                  <span className="text-sm font-medium text-gray-900">
                    {new Date(day._id).toLocaleDateString('en-US', { 
                      weekday: 'short', 
                      month: 'short', 
                      day: 'numeric' 
                    })}
                  </span>
                  <div className="flex items-center">
                    <div className="w-32 bg-gray-200 rounded-full h-2 mr-3">
                      <div 
                        className="bg-mos-blue h-2 rounded-full" 
                        style={{ 
                          width: `${Math.min(100, (day.count / Math.max(...analytics.dailyActivity.map(d => d.count))) * 100)}%` 
                        }}
                      ></div>
                    </div>
                    <span className="text-sm text-gray-500 w-16 text-right">
                      {day.count}
                    </span>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  );
}