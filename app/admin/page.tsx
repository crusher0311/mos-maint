// app/admin/page.tsx
import { getDb } from "@/lib/mongo";

export const dynamic = "force-dynamic";

async function getSystemStats() {
  const db = await getDb();
  
  const [
    totalShops,
    totalUsers,
    totalCustomers,
    totalVehicles,
    recentEvents
  ] = await Promise.all([
    db.collection("shops").countDocuments(),
    db.collection("users").countDocuments(),
    db.collection("customers").countDocuments(),
    db.collection("vehicles").countDocuments(),
    db.collection("events").find({}).sort({ receivedAt: -1 }).limit(10).toArray()
  ]);

  // Active shops (shops with recent activity)
  const activeShops = await db.collection("events").aggregate([
    {
      $match: {
        receivedAt: { $gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) } // Last 30 days
      }
    },
    {
      $group: {
        _id: "$shopId"
      }
    },
    {
      $count: "activeShops"
    }
  ]).toArray();

  return {
    totalShops,
    totalUsers,
    totalCustomers,
    totalVehicles,
    activeShops: activeShops[0]?.activeShops || 0,
    recentEvents
  };
}

export default async function AdminDashboard() {
  const stats = await getSystemStats();

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">System Overview</h1>
        <p className="mt-1 text-sm text-gray-500">
          Monitor your MOS maintenance platform performance and usage
        </p>
      </div>

      {/* Stats Grid */}
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
                    {stats.totalShops}
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
                    Active Shops (30d)
                  </dt>
                  <dd className="text-lg font-medium text-gray-900">
                    {stats.activeShops}
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
                    {stats.totalUsers}
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
                    {stats.totalVehicles}
                  </dd>
                </dl>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Recent Activity */}
      <div className="bg-white shadow rounded-lg">
        <div className="px-4 py-5 sm:p-6">
          <h3 className="text-lg leading-6 font-medium text-gray-900">
            Recent System Activity
          </h3>
          <div className="mt-5">
            {stats.recentEvents.length === 0 ? (
              <p className="text-sm text-gray-500">No recent activity</p>
            ) : (
              <div className="flow-root">
                <ul className="-mb-8">
                  {stats.recentEvents.map((event, eventIdx) => (
                    <li key={event._id}>
                      <div className="relative pb-8">
                        {eventIdx !== stats.recentEvents.length - 1 ? (
                          <span
                            className="absolute top-4 left-4 -ml-px h-full w-0.5 bg-gray-200"
                            aria-hidden="true"
                          />
                        ) : null}
                        <div className="relative flex space-x-3">
                          <div>
                            <span className="h-8 w-8 rounded-full bg-mos-blue flex items-center justify-center ring-8 ring-white">
                              <span className="text-white text-xs font-medium">
                                {event.source?.charAt(0)?.toUpperCase() || 'E'}
                              </span>
                            </span>
                          </div>
                          <div className="min-w-0 flex-1 pt-1.5 flex justify-between space-x-4">
                            <div>
                              <p className="text-sm text-gray-500">
                                Shop {event.shopId} - {event.source || 'Unknown'} event
                                {event.payload?.vin && (
                                  <span className="font-medium"> for {event.payload.vin}</span>
                                )}
                              </p>
                            </div>
                            <div className="text-right text-sm whitespace-nowrap text-gray-500">
                              {event.receivedAt ? new Date(event.receivedAt).toLocaleDateString() : 'Unknown date'}
                            </div>
                          </div>
                        </div>
                      </div>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}