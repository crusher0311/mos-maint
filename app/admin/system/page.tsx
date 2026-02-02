// app/admin/system/page.tsx
import { getDb } from "@/lib/mongo";
import { isEmailConfigured, isAIConfigured, isAutoflowConfigured, isCarfaxConfigured } from "@/lib/env";

export const dynamic = "force-dynamic";

async function getSystemHealth() {
  const db = await getDb();
  
  try {
    // Test database connectivity
    const dbStats = await db.stats();
    const dbConnected = true;
    
    // Check collection counts and indexes
    const collections = await db.listCollections().toArray();
    const collectionStats = await Promise.all(
      ['shops', 'users', 'customers', 'vehicles', 'events', 'sessions'].map(async (name) => {
        try {
          const count = await db.collection(name).countDocuments();
          const indexes = await db.collection(name).indexes();
          return { name, count, indexCount: indexes.length, status: 'healthy' };
        } catch (error) {
          return { name, count: 0, indexCount: 0, status: 'error', error: error.message };
        }
      })
    );

    // Check recent activity
    const recentEvents = await db.collection("events").countDocuments({
      receivedAt: { $gte: new Date(Date.now() - 24 * 60 * 60 * 1000) }
    });

    // Check for any error patterns
    const errorEvents = await db.collection("events").countDocuments({
      receivedAt: { $gte: new Date(Date.now() - 24 * 60 * 60 * 1000) },
      error: { $exists: true }
    });

    return {
      database: {
        connected: dbConnected,
        stats: dbStats,
        collections: collectionStats
      },
      activity: {
        recentEvents,
        errorEvents,
        errorRate: recentEvents > 0 ? (errorEvents / recentEvents) * 100 : 0
      },
      integrations: {
        email: isEmailConfigured(),
        ai: isAIConfigured(),
        autoflow: isAutoflowConfigured(),
        carfax: isCarfaxConfigured()
      }
    };
  } catch (error) {
    return {
      database: {
        connected: false,
        error: error.message
      },
      activity: {
        recentEvents: 0,
        errorEvents: 0,
        errorRate: 0
      },
      integrations: {
        email: isEmailConfigured(),
        ai: isAIConfigured(),
        autoflow: isAutoflowConfigured(),
        carfax: isCarfaxConfigured()
      }
    };
  }
}

export default async function AdminSystemPage() {
  const health = await getSystemHealth();

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">System Health</h1>
        <p className="mt-1 text-sm text-gray-500">
          Monitor system status and performance
        </p>
      </div>

      {/* Overall Health Status */}
      <div className="bg-white shadow rounded-lg">
        <div className="px-4 py-5 sm:p-6">
          <div className="flex items-center">
            <div className={`flex-shrink-0 w-3 h-3 rounded-full ${
              health.database.connected ? 'bg-green-400' : 'bg-red-400'
            }`}></div>
            <h3 className="ml-3 text-lg leading-6 font-medium text-gray-900">
              System Status: {health.database.connected ? 'Healthy' : 'Issues Detected'}
            </h3>
          </div>
        </div>
      </div>

      {/* Database Health */}
      <div className="bg-white shadow rounded-lg">
        <div className="px-4 py-5 sm:p-6">
          <h3 className="text-lg leading-6 font-medium text-gray-900 mb-4">
            Database Health
          </h3>
          
          {health.database.connected ? (
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium text-gray-900">Connection Status</span>
                <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-green-100 text-green-800">
                  Connected
                </span>
              </div>
              
              {health.database.stats && (
                <>
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-medium text-gray-900">Database Size</span>
                    <span className="text-sm text-gray-500">
                      {(health.database.stats.dataSize / 1024 / 1024).toFixed(2)} MB
                    </span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-medium text-gray-900">Storage Size</span>
                    <span className="text-sm text-gray-500">
                      {(health.database.stats.storageSize / 1024 / 1024).toFixed(2)} MB
                    </span>
                  </div>
                </>
              )}
            </div>
          ) : (
            <div className="text-red-600">
              <p className="font-medium">Database Connection Failed</p>
              {health.database.error && (
                <p className="text-sm mt-1">{health.database.error}</p>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Collections Status */}
      {health.database.collections && (
        <div className="bg-white shadow rounded-lg">
          <div className="px-4 py-5 sm:p-6">
            <h3 className="text-lg leading-6 font-medium text-gray-900 mb-4">
              Collections Status
            </h3>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {health.database.collections.map((collection) => (
                <div key={collection.name} className="border rounded-lg p-4">
                  <div className="flex items-center justify-between mb-2">
                    <h4 className="text-sm font-medium text-gray-900">{collection.name}</h4>
                    <span className={`inline-flex items-center px-2 py-1 rounded-full text-xs font-medium ${
                      collection.status === 'healthy' 
                        ? 'bg-green-100 text-green-800'
                        : 'bg-red-100 text-red-800'
                    }`}>
                      {collection.status}
                    </span>
                  </div>
                  <div className="text-xs text-gray-500 space-y-1">
                    <div>Documents: {collection.count.toLocaleString()}</div>
                    <div>Indexes: {collection.indexCount}</div>
                  </div>
                  {collection.error && (
                    <div className="text-xs text-red-600 mt-2">{collection.error}</div>
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Activity Monitoring */}
      <div className="bg-white shadow rounded-lg">
        <div className="px-4 py-5 sm:p-6">
          <h3 className="text-lg leading-6 font-medium text-gray-900 mb-4">
            Recent Activity (24 hours)
          </h3>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
            <div className="text-center">
              <div className="text-2xl font-bold text-gray-900">
                {health.activity.recentEvents.toLocaleString()}
              </div>
              <div className="text-sm text-gray-500">Total Events</div>
            </div>
            <div className="text-center">
              <div className="text-2xl font-bold text-red-600">
                {health.activity.errorEvents.toLocaleString()}
              </div>
              <div className="text-sm text-gray-500">Error Events</div>
            </div>
            <div className="text-center">
              <div className="text-2xl font-bold text-gray-900">
                {health.activity.errorRate.toFixed(1)}%
              </div>
              <div className="text-sm text-gray-500">Error Rate</div>
            </div>
          </div>
        </div>
      </div>

      {/* Integration Status */}
      <div className="bg-white shadow rounded-lg">
        <div className="px-4 py-5 sm:p-6">
          <h3 className="text-lg leading-6 font-medium text-gray-900 mb-4">
            Integration Status
          </h3>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
            <div className="flex items-center justify-between p-3 border rounded-lg">
              <span className="text-sm font-medium text-gray-900">Email Service</span>
              <span className={`inline-flex items-center px-2 py-1 rounded-full text-xs font-medium ${
                health.integrations.email 
                  ? 'bg-green-100 text-green-800'
                  : 'bg-yellow-100 text-yellow-800'
              }`}>
                {health.integrations.email ? 'Configured' : 'Not Configured'}
              </span>
            </div>
            
            <div className="flex items-center justify-between p-3 border rounded-lg">
              <span className="text-sm font-medium text-gray-900">AI Service</span>
              <span className={`inline-flex items-center px-2 py-1 rounded-full text-xs font-medium ${
                health.integrations.ai 
                  ? 'bg-green-100 text-green-800'
                  : 'bg-yellow-100 text-yellow-800'
              }`}>
                {health.integrations.ai ? 'Configured' : 'Not Configured'}
              </span>
            </div>
            
            <div className="flex items-center justify-between p-3 border rounded-lg">
              <span className="text-sm font-medium text-gray-900">AutoFlow</span>
              <span className={`inline-flex items-center px-2 py-1 rounded-full text-xs font-medium ${
                health.integrations.autoflow 
                  ? 'bg-green-100 text-green-800'
                  : 'bg-yellow-100 text-yellow-800'
              }`}>
                {health.integrations.autoflow ? 'Configured' : 'Not Configured'}
              </span>
            </div>
            
            <div className="flex items-center justify-between p-3 border rounded-lg">
              <span className="text-sm font-medium text-gray-900">Carfax</span>
              <span className={`inline-flex items-center px-2 py-1 rounded-full text-xs font-medium ${
                health.integrations.carfax 
                  ? 'bg-green-100 text-green-800'
                  : 'bg-yellow-100 text-yellow-800'
              }`}>
                {health.integrations.carfax ? 'Configured' : 'Not Configured'}
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}