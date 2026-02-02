// app/admin/shops/page.tsx
import sql from "@/lib/db/postgres";
import Link from "next/link";

export const dynamic = "force-dynamic";

async function getShopsWithStats() {
  const shops = await sql`SELECT * FROM shops`;
  
  const shopsWithStats = await Promise.all(
    shops.map(async (shop: any) => {
      const shopId = shop.shop_id;
      const [userResult, customerResult, vehicleResult, lastActivityResult] = await Promise.all([
        sql`SELECT COUNT(*) as count FROM users WHERE shop_id = ${shopId}`,
        sql`SELECT COUNT(*) as count FROM customers WHERE shop_id = ${shopId}`,
        sql`SELECT COUNT(*) as count FROM vehicles WHERE shop_id = ${shopId}`,
        sql`SELECT received_at FROM events WHERE shop_id = ${shopId} ORDER BY received_at DESC LIMIT 1`
      ]);

      return {
        ...shop,
        _id: shop.id,
        shopId: shop.shop_id,
        stats: {
          users: Number(userResult[0]?.count || 0),
          customers: Number(customerResult[0]?.count || 0),
          vehicles: Number(vehicleResult[0]?.count || 0),
          lastActivity: lastActivityResult[0]?.received_at || null
        }
      };
    })
  );

  return shopsWithStats;
}

export default async function AdminShopsPage() {
  const shops = await getShopsWithStats();

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Shop Management</h1>
          <p className="mt-1 text-sm text-gray-500">
            Manage all shops registered on your platform
          </p>
        </div>
        <Link
          href="/admin/shops/new"
          className="inline-flex items-center px-4 py-2 border border-transparent shadow-sm text-sm font-medium rounded-md text-white bg-mos-blue hover:bg-mos-blue-dark focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-mos-blue"
        >
          Add New Shop
        </Link>
      </div>

      {/* Shops Table */}
      <div className="bg-white shadow overflow-hidden sm:rounded-md">
        <ul className="divide-y divide-gray-200">
          {shops.length === 0 ? (
            <li className="px-6 py-4">
              <p className="text-sm text-gray-500">No shops found</p>
            </li>
          ) : (
            shops.map((shop) => (
              <li key={shop._id}>
                <div className="px-6 py-4 flex items-center justify-between">
                  <div className="flex items-center">
                    <div className="flex-shrink-0">
                      <div className="h-10 w-10 rounded-full bg-mos-blue flex items-center justify-center">
                        <span className="text-sm font-medium text-white">
                          {shop.name?.charAt(0)?.toUpperCase() || 'S'}
                        </span>
                      </div>
                    </div>
                    <div className="ml-4">
                      <div className="flex items-center">
                        <p className="text-sm font-medium text-gray-900">
                          {shop.name}
                        </p>
                        <span className="ml-2 inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-green-100 text-green-800">
                          ID: {shop.shopId}
                        </span>
                      </div>
                      <div className="mt-1 flex items-center text-sm text-gray-500">
                        <span>
                          {shop.stats.users} users • {shop.stats.customers} customers • {shop.stats.vehicles} vehicles
                        </span>
                        {shop.stats.lastActivity && (
                          <span className="ml-2">
                            • Last activity: {new Date(shop.stats.lastActivity).toLocaleDateString()}
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center space-x-2">
                    <Link
                      href={`/admin/shops/${shop.shopId}`}
                      className="inline-flex items-center px-3 py-1 border border-gray-300 shadow-sm text-sm leading-4 font-medium rounded-md text-gray-700 bg-white hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-mos-blue"
                    >
                      View Details
                    </Link>
                    <Link
                      href={`/admin/shops/${shop.shopId}/edit`}
                      className="inline-flex items-center px-3 py-1 border border-gray-300 shadow-sm text-sm leading-4 font-medium rounded-md text-gray-700 bg-white hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-mos-blue"
                    >
                      Edit
                    </Link>
                  </div>
                </div>
              </li>
            ))
          )}
        </ul>
      </div>

      {/* Summary Stats */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        <div className="bg-white overflow-hidden shadow rounded-lg">
          <div className="p-5">
            <div className="flex items-center">
              <div className="flex-shrink-0">
                <div className="w-8 h-8 bg-blue-500 rounded-md flex items-center justify-center">
                  <span className="text-white text-sm font-medium">T</span>
                </div>
              </div>
              <div className="ml-5 w-0 flex-1">
                <dl>
                  <dt className="text-sm font-medium text-gray-500 truncate">
                    Total Shops
                  </dt>
                  <dd className="text-lg font-medium text-gray-900">
                    {shops.length}
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
                    {shops.filter(shop => shop.stats.lastActivity && 
                      new Date(shop.stats.lastActivity) > new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
                    ).length}
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
                    {shops.reduce((sum, shop) => sum + shop.stats.vehicles, 0)}
                  </dd>
                </dl>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}