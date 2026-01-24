"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { Download, FileText, FileJson, RefreshCw, ExternalLink } from "lucide-react";

interface ApiRoute {
  path: string;
  methods: string[];
  category: string;
  isExternal: boolean;
  description: string;
}

interface ApiInventory {
  generated: string;
  summary: {
    total: number;
    external: number;
    internal: number;
  };
  routes: ApiRoute[];
}

export default function ApiInventoryPage() {
  const [inventory, setInventory] = useState<ApiInventory | null>(null);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<"all" | "external" | "internal">("all");
  const [categoryFilter, setCategoryFilter] = useState<string>("all");

  useEffect(() => {
    fetch("/api-inventory.json")
      .then((res) => res.json())
      .then((data) => {
        setInventory(data);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  const categories = inventory
    ? [...new Set(inventory.routes.map((r) => r.category))].sort()
    : [];

  const filteredRoutes = inventory?.routes.filter((route) => {
    if (filter === "external" && !route.isExternal) return false;
    if (filter === "internal" && route.isExternal) return false;
    if (categoryFilter !== "all" && route.category !== categoryFilter) return false;
    return true;
  });

  return (
    <div className="min-h-screen bg-gray-50">
      <header className="bg-white border-b border-gray-200">
        <div className="max-w-7xl mx-auto px-6 py-4">
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-2xl font-bold text-gray-900">API Inventory</h1>
              <p className="text-gray-500 text-sm">
                Complete list of all MOS Tools API endpoints
              </p>
            </div>
            <div className="flex items-center gap-3">
              <a
                href="/api-inventory.md"
                download="mos-api-inventory.md"
                className="flex items-center gap-2 px-4 py-2 bg-white border border-gray-200 rounded-lg hover:bg-gray-50 text-sm"
              >
                <FileText className="w-4 h-4" />
                Download Markdown
              </a>
              <a
                href="/api-inventory.json"
                download="mos-api-inventory.json"
                className="flex items-center gap-2 px-4 py-2 bg-[#3c81c3] text-white rounded-lg hover:bg-[#2d6299] text-sm"
              >
                <FileJson className="w-4 h-4" />
                Download JSON
              </a>
            </div>
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-6 py-8">
        {loading ? (
          <div className="flex items-center justify-center py-16">
            <RefreshCw className="w-6 h-6 animate-spin text-gray-400" />
          </div>
        ) : inventory ? (
          <>
            <div className="grid grid-cols-3 gap-6 mb-8">
              <div className="bg-white rounded-xl border border-gray-200 p-6">
                <div className="text-3xl font-bold text-gray-900">{inventory.summary.total}</div>
                <div className="text-gray-500">Total Endpoints</div>
              </div>
              <div className="bg-white rounded-xl border border-gray-200 p-6">
                <div className="text-3xl font-bold text-green-600">{inventory.summary.external}</div>
                <div className="text-gray-500">External API</div>
              </div>
              <div className="bg-white rounded-xl border border-gray-200 p-6">
                <div className="text-3xl font-bold text-gray-600">{inventory.summary.internal}</div>
                <div className="text-gray-500">Internal Only</div>
              </div>
            </div>

            <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
              <div className="p-4 border-b border-gray-200 flex items-center justify-between">
                <div className="flex items-center gap-4">
                  <select
                    value={filter}
                    onChange={(e) => setFilter(e.target.value as typeof filter)}
                    className="border border-gray-200 rounded-lg px-3 py-2 text-sm"
                  >
                    <option value="all">All Endpoints</option>
                    <option value="external">External API Only</option>
                    <option value="internal">Internal Only</option>
                  </select>
                  <select
                    value={categoryFilter}
                    onChange={(e) => setCategoryFilter(e.target.value)}
                    className="border border-gray-200 rounded-lg px-3 py-2 text-sm"
                  >
                    <option value="all">All Categories</option>
                    {categories.map((cat) => (
                      <option key={cat} value={cat}>
                        {cat}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="text-sm text-gray-500">
                  Showing {filteredRoutes?.length} of {inventory.routes.length} endpoints
                </div>
              </div>

              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-gray-50">
                    <tr>
                      <th className="text-left px-4 py-3 font-medium text-gray-600">Endpoint</th>
                      <th className="text-left px-4 py-3 font-medium text-gray-600">Methods</th>
                      <th className="text-left px-4 py-3 font-medium text-gray-600">Category</th>
                      <th className="text-left px-4 py-3 font-medium text-gray-600">Status</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {filteredRoutes?.map((route, idx) => (
                      <tr key={idx} className="hover:bg-gray-50">
                        <td className="px-4 py-3">
                          <code className="text-sm font-mono">{route.path}</code>
                        </td>
                        <td className="px-4 py-3">
                          <div className="flex gap-1">
                            {route.methods.map((method) => (
                              <span
                                key={method}
                                className={`px-2 py-0.5 text-xs rounded font-medium ${
                                  method === "GET"
                                    ? "bg-green-100 text-green-800"
                                    : method === "POST"
                                    ? "bg-blue-100 text-blue-800"
                                    : method === "PUT" || method === "PATCH"
                                    ? "bg-yellow-100 text-yellow-800"
                                    : "bg-red-100 text-red-800"
                                }`}
                              >
                                {method}
                              </span>
                            ))}
                          </div>
                        </td>
                        <td className="px-4 py-3 text-gray-600">{route.category}</td>
                        <td className="px-4 py-3">
                          {route.isExternal ? (
                            <span className="px-2 py-1 text-xs rounded-full bg-green-100 text-green-800">
                              External
                            </span>
                          ) : (
                            <span className="px-2 py-1 text-xs rounded-full bg-gray-100 text-gray-600">
                              Internal
                            </span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            <div className="mt-8 text-center text-sm text-gray-500">
              <p>
                Last generated: {new Date(inventory.generated).toLocaleString()}
              </p>
              <p className="mt-1">
                Run <code className="bg-gray-100 px-2 py-1 rounded">npm run generate:api-inventory</code> to update this list
              </p>
            </div>
          </>
        ) : (
          <div className="text-center py-16 text-gray-500">
            Failed to load API inventory. Run the generator script first.
          </div>
        )}
      </main>
    </div>
  );
}
