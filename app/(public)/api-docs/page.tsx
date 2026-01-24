"use client";

import { useState } from "react";
import Link from "next/link";

const endpoints = [
  {
    category: "Appointments",
    items: [
      {
        method: "POST",
        path: "/api/external/appointments",
        title: "Create Appointment",
        description: "Schedule a new appointment for a vehicle",
        permission: "appointments:create",
        requestBody: {
          vin: "1HGBH41JXMN109186",
          customerName: "John Smith",
          customerPhone: "(555) 123-4567",
          customerEmail: "john@example.com",
          scheduledDate: "2024-03-15T10:00:00Z",
          duration: 60,
          serviceType: "Oil Change",
          notes: "Customer prefers synthetic oil"
        },
        response: {
          success: true,
          appointment: {
            id: "apt_abc123",
            vin: "1HGBH41JXMN109186",
            customerName: "John Smith",
            scheduledDate: "2024-03-15T10:00:00Z",
            status: "pending"
          }
        }
      },
      {
        method: "GET",
        path: "/api/external/appointments",
        title: "List Appointments",
        description: "Retrieve a list of appointments with optional filters",
        permission: "appointments:read",
        params: [
          { name: "status", type: "string", description: "Filter by status (pending, confirmed, completed, cancelled)" },
          { name: "from", type: "date", description: "Start date filter (ISO 8601)" },
          { name: "to", type: "date", description: "End date filter (ISO 8601)" },
          { name: "limit", type: "integer", description: "Max results (default: 50)" },
          { name: "offset", type: "integer", description: "Pagination offset" }
        ],
        response: {
          appointments: [
            { id: "apt_abc123", vin: "1HGBH41JXMN109186", customerName: "John Smith", status: "pending" }
          ],
          total: 1
        }
      }
    ]
  },
  {
    category: "Vehicles",
    items: [
      {
        method: "GET",
        path: "/api/external/vehicles/{vin}",
        title: "Get Vehicle Info",
        description: "Retrieve vehicle information by VIN",
        permission: "vehicles:read",
        params: [
          { name: "vin", type: "string", description: "17-character Vehicle Identification Number", required: true }
        ],
        response: {
          vin: "1HGBH41JXMN109186",
          year: 2021,
          make: "Honda",
          model: "Accord",
          trim: "Sport",
          engine: "1.5L Turbo I4",
          transmission: "CVT",
          driveType: "FWD"
        }
      },
      {
        method: "GET",
        path: "/api/external/vehicles/{vin}/maintenance",
        title: "Get Maintenance Schedule",
        description: "Retrieve OEM maintenance schedule for a vehicle",
        permission: "maintenance:read",
        params: [
          { name: "vin", type: "string", description: "17-character VIN", required: true },
          { name: "mileage", type: "integer", description: "Current mileage for relevant services" }
        ],
        response: {
          vin: "1HGBH41JXMN109186",
          services: [
            { name: "Oil Change", intervalMiles: 7500, intervalMonths: 12 },
            { name: "Tire Rotation", intervalMiles: 7500, intervalMonths: 12 },
            { name: "Brake Inspection", intervalMiles: 15000, intervalMonths: 24 }
          ]
        }
      }
    ]
  },
  {
    category: "Recommendations",
    items: [
      {
        method: "GET",
        path: "/api/external/recommendations/{vin}",
        title: "Get Recommendations",
        description: "Get AI-powered maintenance recommendations for a vehicle",
        permission: "recommendations:read",
        params: [
          { name: "vin", type: "string", description: "17-character VIN", required: true },
          { name: "mileage", type: "integer", description: "Current vehicle mileage" }
        ],
        response: {
          recommendations: [
            {
              id: "rec_123",
              service: "Brake Pad Replacement",
              priority: "high",
              reason: "Based on mileage and common wear patterns",
              estimatedCost: 350,
              source: "AI Analysis"
            }
          ]
        }
      }
    ]
  },
  {
    category: "Stickers",
    items: [
      {
        method: "POST",
        path: "/api/external/stickers",
        title: "Generate Sticker",
        description: "Generate an oil change reminder sticker",
        permission: "stickers:generate",
        requestBody: {
          vin: "1HGBH41JXMN109186",
          currentMileage: 45000,
          serviceDate: "2024-03-15",
          nextServiceMiles: 5000,
          nextServiceMonths: 6,
          oilType: "0W-20 Synthetic"
        },
        response: {
          success: true,
          stickerId: "stk_abc123",
          qrCodeUrl: "https://example.com/qr/abc123"
        }
      }
    ]
  },
  {
    category: "Keytags",
    items: [
      {
        method: "POST",
        path: "/api/external/keytags",
        title: "Generate Keytag",
        description: "Generate a keytag for a vehicle",
        permission: "keytags:generate",
        requestBody: {
          vin: "1HGBH41JXMN109186",
          customerName: "John Smith",
          vehicleInfo: "2021 Honda Accord"
        },
        response: {
          success: true,
          keytagId: "ktg_abc123"
        }
      }
    ]
  }
];

const permissions = [
  { name: "appointments:create", description: "Create new appointments" },
  { name: "appointments:read", description: "View and list appointments" },
  { name: "stickers:generate", description: "Generate oil change stickers" },
  { name: "keytags:generate", description: "Generate vehicle keytags" },
  { name: "vehicles:read", description: "Access vehicle information" },
  { name: "maintenance:read", description: "View maintenance schedules" },
  { name: "recommendations:read", description: "Get maintenance recommendations" },
  { name: "*", description: "Full access to all endpoints" }
];

function MethodBadge({ method }: { method: string }) {
  const colors: Record<string, string> = {
    GET: "bg-green-100 text-green-800 border-green-200",
    POST: "bg-blue-100 text-blue-800 border-blue-200",
    PUT: "bg-yellow-100 text-yellow-800 border-yellow-200",
    DELETE: "bg-red-100 text-red-800 border-red-200"
  };
  return (
    <span className={`px-2 py-1 text-xs font-bold rounded border ${colors[method] || "bg-gray-100"}`}>
      {method}
    </span>
  );
}

function CodeBlock({ code, language = "json" }: { code: any; language?: string }) {
  return (
    <pre className="bg-gray-900 text-gray-100 p-4 rounded-lg overflow-x-auto text-sm">
      <code>{typeof code === "string" ? code : JSON.stringify(code, null, 2)}</code>
    </pre>
  );
}

export default function PublicApiDocsPage() {
  const [activeSection, setActiveSection] = useState("overview");
  const [expandedEndpoint, setExpandedEndpoint] = useState<string | null>(null);

  return (
    <div className="min-h-screen bg-white">
      <header className="bg-gradient-to-r from-blue-600 to-blue-800 text-white">
        <div className="max-w-7xl mx-auto px-6 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 bg-white rounded-lg flex items-center justify-center">
                <span className="text-blue-600 font-bold text-lg">M</span>
              </div>
              <div>
                <h1 className="text-xl font-bold">MOS API</h1>
                <p className="text-blue-200 text-sm">Developer Documentation</p>
              </div>
            </div>
            <div className="flex items-center gap-4">
              <span className="bg-blue-500/30 px-3 py-1 rounded-full text-sm">v1.0</span>
              <Link href="/api-docs.html" className="text-sm hover:underline">
                Swagger UI
              </Link>
            </div>
          </div>
        </div>
      </header>

      <div className="max-w-7xl mx-auto flex">
        <nav className="w-64 min-h-screen border-r border-gray-200 p-6 sticky top-0 hidden lg:block">
          <div className="space-y-6">
            <div>
              <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-3">Getting Started</h3>
              <ul className="space-y-2">
                <li>
                  <button
                    onClick={() => setActiveSection("overview")}
                    className={`w-full text-left px-3 py-2 rounded-lg text-sm ${activeSection === "overview" ? "bg-blue-50 text-blue-700 font-medium" : "text-gray-600 hover:bg-gray-50"}`}
                  >
                    Overview
                  </button>
                </li>
                <li>
                  <button
                    onClick={() => setActiveSection("authentication")}
                    className={`w-full text-left px-3 py-2 rounded-lg text-sm ${activeSection === "authentication" ? "bg-blue-50 text-blue-700 font-medium" : "text-gray-600 hover:bg-gray-50"}`}
                  >
                    Authentication
                  </button>
                </li>
                <li>
                  <button
                    onClick={() => setActiveSection("rate-limits")}
                    className={`w-full text-left px-3 py-2 rounded-lg text-sm ${activeSection === "rate-limits" ? "bg-blue-50 text-blue-700 font-medium" : "text-gray-600 hover:bg-gray-50"}`}
                  >
                    Rate Limits
                  </button>
                </li>
                <li>
                  <button
                    onClick={() => setActiveSection("errors")}
                    className={`w-full text-left px-3 py-2 rounded-lg text-sm ${activeSection === "errors" ? "bg-blue-50 text-blue-700 font-medium" : "text-gray-600 hover:bg-gray-50"}`}
                  >
                    Error Handling
                  </button>
                </li>
              </ul>
            </div>

            <div>
              <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-3">Endpoints</h3>
              <ul className="space-y-1">
                {endpoints.map((cat) => (
                  <li key={cat.category}>
                    <button
                      onClick={() => setActiveSection(cat.category.toLowerCase())}
                      className={`w-full text-left px-3 py-2 rounded-lg text-sm ${activeSection === cat.category.toLowerCase() ? "bg-blue-50 text-blue-700 font-medium" : "text-gray-600 hover:bg-gray-50"}`}
                    >
                      {cat.category}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </nav>

        <main className="flex-1 p-8 max-w-4xl">
          {activeSection === "overview" && (
            <section>
              <h2 className="text-3xl font-bold text-gray-900 mb-4">MOS Maintenance API</h2>
              <p className="text-lg text-gray-600 mb-8">
                Integrate MOS Maintenance capabilities into your CRM, shop management system, or custom applications.
                Our API provides programmatic access to appointments, vehicle information, maintenance schedules, 
                and AI-powered recommendations.
              </p>

              <div className="grid md:grid-cols-2 gap-6 mb-8">
                <div className="border border-gray-200 rounded-xl p-6">
                  <div className="w-12 h-12 bg-blue-100 rounded-lg flex items-center justify-center mb-4">
                    <svg className="w-6 h-6 text-blue-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
                    </svg>
                  </div>
                  <h3 className="text-lg font-semibold mb-2">Appointments</h3>
                  <p className="text-gray-600 text-sm">Create and manage service appointments directly from your systems.</p>
                </div>

                <div className="border border-gray-200 rounded-xl p-6">
                  <div className="w-12 h-12 bg-green-100 rounded-lg flex items-center justify-center mb-4">
                    <svg className="w-6 h-6 text-green-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                    </svg>
                  </div>
                  <h3 className="text-lg font-semibold mb-2">Vehicle Data</h3>
                  <p className="text-gray-600 text-sm">Access vehicle information and OEM maintenance schedules by VIN.</p>
                </div>

                <div className="border border-gray-200 rounded-xl p-6">
                  <div className="w-12 h-12 bg-purple-100 rounded-lg flex items-center justify-center mb-4">
                    <svg className="w-6 h-6 text-purple-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" />
                    </svg>
                  </div>
                  <h3 className="text-lg font-semibold mb-2">AI Recommendations</h3>
                  <p className="text-gray-600 text-sm">Get intelligent maintenance recommendations powered by AI.</p>
                </div>

                <div className="border border-gray-200 rounded-xl p-6">
                  <div className="w-12 h-12 bg-orange-100 rounded-lg flex items-center justify-center mb-4">
                    <svg className="w-6 h-6 text-orange-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 7h.01M7 3h5c.512 0 1.024.195 1.414.586l7 7a2 2 0 010 2.828l-7 7a2 2 0 01-2.828 0l-7-7A1.994 1.994 0 013 12V7a4 4 0 014-4z" />
                    </svg>
                  </div>
                  <h3 className="text-lg font-semibold mb-2">Stickers & Keytags</h3>
                  <p className="text-gray-600 text-sm">Generate oil change stickers and keytags programmatically.</p>
                </div>
              </div>

              <div className="bg-gray-50 rounded-xl p-6">
                <h3 className="font-semibold mb-4">Base URL</h3>
                <CodeBlock code="https://your-domain.com/api/external" language="text" />
              </div>
            </section>
          )}

          {activeSection === "authentication" && (
            <section>
              <h2 className="text-3xl font-bold text-gray-900 mb-4">Authentication</h2>
              <p className="text-gray-600 mb-8">
                All API requests require authentication using an API key. API keys can be generated from your 
                dashboard under Settings &gt; API Keys.
              </p>

              <div className="space-y-6">
                <div>
                  <h3 className="text-lg font-semibold mb-3">Authorization Header</h3>
                  <p className="text-gray-600 mb-3">Include your API key in the Authorization header:</p>
                  <CodeBlock code={`curl -X GET "https://your-domain.com/api/external/vehicles/1HGBH41JXMN109186" \\
  -H "Authorization: Bearer mos_your_api_key_here"`} />
                </div>

                <div>
                  <h3 className="text-lg font-semibold mb-3">X-API-Key Header</h3>
                  <p className="text-gray-600 mb-3">Alternatively, use the X-API-Key header:</p>
                  <CodeBlock code={`curl -X GET "https://your-domain.com/api/external/vehicles/1HGBH41JXMN109186" \\
  -H "X-API-Key: mos_your_api_key_here"`} />
                </div>

                <div className="bg-amber-50 border border-amber-200 rounded-xl p-6">
                  <h4 className="font-semibold text-amber-800 mb-2">Keep your API key secure</h4>
                  <ul className="text-amber-700 text-sm space-y-1">
                    <li>Never expose your API key in client-side code</li>
                    <li>Store keys securely using environment variables</li>
                    <li>Rotate keys regularly and revoke compromised keys immediately</li>
                  </ul>
                </div>

                <div>
                  <h3 className="text-lg font-semibold mb-3">Permissions</h3>
                  <p className="text-gray-600 mb-4">API keys are scoped to specific permissions:</p>
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b border-gray-200">
                          <th className="text-left py-3 px-4 font-semibold">Permission</th>
                          <th className="text-left py-3 px-4 font-semibold">Description</th>
                        </tr>
                      </thead>
                      <tbody>
                        {permissions.map((perm) => (
                          <tr key={perm.name} className="border-b border-gray-100">
                            <td className="py-3 px-4">
                              <code className="bg-gray-100 px-2 py-1 rounded text-sm">{perm.name}</code>
                            </td>
                            <td className="py-3 px-4 text-gray-600">{perm.description}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              </div>
            </section>
          )}

          {activeSection === "rate-limits" && (
            <section>
              <h2 className="text-3xl font-bold text-gray-900 mb-4">Rate Limits</h2>
              <p className="text-gray-600 mb-8">
                Each API key has a configured rate limit measured in requests per minute. 
                Rate limit information is included in response headers.
              </p>

              <div className="space-y-6">
                <div>
                  <h3 className="text-lg font-semibold mb-3">Response Headers</h3>
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b border-gray-200">
                          <th className="text-left py-3 px-4 font-semibold">Header</th>
                          <th className="text-left py-3 px-4 font-semibold">Description</th>
                        </tr>
                      </thead>
                      <tbody>
                        <tr className="border-b border-gray-100">
                          <td className="py-3 px-4"><code className="bg-gray-100 px-2 py-1 rounded">X-RateLimit-Limit</code></td>
                          <td className="py-3 px-4 text-gray-600">Maximum requests per minute</td>
                        </tr>
                        <tr className="border-b border-gray-100">
                          <td className="py-3 px-4"><code className="bg-gray-100 px-2 py-1 rounded">X-RateLimit-Remaining</code></td>
                          <td className="py-3 px-4 text-gray-600">Remaining requests in current window</td>
                        </tr>
                        <tr className="border-b border-gray-100">
                          <td className="py-3 px-4"><code className="bg-gray-100 px-2 py-1 rounded">X-RateLimit-Reset</code></td>
                          <td className="py-3 px-4 text-gray-600">When the rate limit resets (ISO 8601)</td>
                        </tr>
                      </tbody>
                    </table>
                  </div>
                </div>

                <div>
                  <h3 className="text-lg font-semibold mb-3">Rate Limit Exceeded</h3>
                  <p className="text-gray-600 mb-3">When you exceed your rate limit, you'll receive a 429 response:</p>
                  <CodeBlock code={{
                    error: "Rate limit exceeded",
                    message: "Rate limit of 100 requests per minute exceeded",
                    retryAfter: 45
                  }} />
                </div>
              </div>
            </section>
          )}

          {activeSection === "errors" && (
            <section>
              <h2 className="text-3xl font-bold text-gray-900 mb-4">Error Handling</h2>
              <p className="text-gray-600 mb-8">
                The API uses standard HTTP status codes to indicate success or failure.
              </p>

              <div className="space-y-6">
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-gray-200">
                        <th className="text-left py-3 px-4 font-semibold">Status Code</th>
                        <th className="text-left py-3 px-4 font-semibold">Description</th>
                      </tr>
                    </thead>
                    <tbody>
                      <tr className="border-b border-gray-100">
                        <td className="py-3 px-4"><code className="bg-green-100 text-green-800 px-2 py-1 rounded">200</code></td>
                        <td className="py-3 px-4 text-gray-600">Success</td>
                      </tr>
                      <tr className="border-b border-gray-100">
                        <td className="py-3 px-4"><code className="bg-green-100 text-green-800 px-2 py-1 rounded">201</code></td>
                        <td className="py-3 px-4 text-gray-600">Created successfully</td>
                      </tr>
                      <tr className="border-b border-gray-100">
                        <td className="py-3 px-4"><code className="bg-yellow-100 text-yellow-800 px-2 py-1 rounded">400</code></td>
                        <td className="py-3 px-4 text-gray-600">Bad request - invalid parameters</td>
                      </tr>
                      <tr className="border-b border-gray-100">
                        <td className="py-3 px-4"><code className="bg-red-100 text-red-800 px-2 py-1 rounded">401</code></td>
                        <td className="py-3 px-4 text-gray-600">Unauthorized - invalid or missing API key</td>
                      </tr>
                      <tr className="border-b border-gray-100">
                        <td className="py-3 px-4"><code className="bg-red-100 text-red-800 px-2 py-1 rounded">403</code></td>
                        <td className="py-3 px-4 text-gray-600">Forbidden - insufficient permissions</td>
                      </tr>
                      <tr className="border-b border-gray-100">
                        <td className="py-3 px-4"><code className="bg-red-100 text-red-800 px-2 py-1 rounded">404</code></td>
                        <td className="py-3 px-4 text-gray-600">Not found</td>
                      </tr>
                      <tr className="border-b border-gray-100">
                        <td className="py-3 px-4"><code className="bg-orange-100 text-orange-800 px-2 py-1 rounded">429</code></td>
                        <td className="py-3 px-4 text-gray-600">Rate limit exceeded</td>
                      </tr>
                      <tr className="border-b border-gray-100">
                        <td className="py-3 px-4"><code className="bg-red-100 text-red-800 px-2 py-1 rounded">500</code></td>
                        <td className="py-3 px-4 text-gray-600">Internal server error</td>
                      </tr>
                    </tbody>
                  </table>
                </div>

                <div>
                  <h3 className="text-lg font-semibold mb-3">Error Response Format</h3>
                  <CodeBlock code={{
                    error: "Permission denied",
                    message: "This API key does not have the 'appointments:create' permission"
                  }} />
                </div>
              </div>
            </section>
          )}

          {endpoints.map((category) => (
            activeSection === category.category.toLowerCase() && (
              <section key={category.category}>
                <h2 className="text-3xl font-bold text-gray-900 mb-4">{category.category}</h2>
                <div className="space-y-6">
                  {category.items.map((endpoint, idx) => (
                    <div key={idx} className="border border-gray-200 rounded-xl overflow-hidden">
                      <button
                        onClick={() => setExpandedEndpoint(expandedEndpoint === `${category.category}-${idx}` ? null : `${category.category}-${idx}`)}
                        className="w-full flex items-center justify-between p-4 hover:bg-gray-50"
                      >
                        <div className="flex items-center gap-3">
                          <MethodBadge method={endpoint.method} />
                          <code className="text-sm font-mono">{endpoint.path}</code>
                        </div>
                        <div className="flex items-center gap-3">
                          <span className="text-sm text-gray-500">{endpoint.title}</span>
                          <svg className={`w-5 h-5 text-gray-400 transition-transform ${expandedEndpoint === `${category.category}-${idx}` ? "rotate-180" : ""}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                          </svg>
                        </div>
                      </button>

                      {expandedEndpoint === `${category.category}-${idx}` && (
                        <div className="border-t border-gray-200 p-6 bg-gray-50">
                          <p className="text-gray-600 mb-4">{endpoint.description}</p>
                          
                          <div className="mb-4">
                            <span className="text-sm font-medium">Required Permission: </span>
                            <code className="bg-blue-100 text-blue-800 px-2 py-1 rounded text-sm">{endpoint.permission}</code>
                          </div>

                          {endpoint.params && (
                            <div className="mb-6">
                              <h4 className="font-semibold mb-3">Parameters</h4>
                              <table className="w-full text-sm">
                                <thead>
                                  <tr className="border-b">
                                    <th className="text-left py-2">Name</th>
                                    <th className="text-left py-2">Type</th>
                                    <th className="text-left py-2">Description</th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {endpoint.params.map((param: any) => (
                                    <tr key={param.name} className="border-b border-gray-100">
                                      <td className="py-2">
                                        <code>{param.name}</code>
                                        {param.required && <span className="text-red-500 ml-1">*</span>}
                                      </td>
                                      <td className="py-2 text-gray-500">{param.type}</td>
                                      <td className="py-2 text-gray-600">{param.description}</td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            </div>
                          )}

                          {endpoint.requestBody && (
                            <div className="mb-6">
                              <h4 className="font-semibold mb-3">Request Body</h4>
                              <CodeBlock code={endpoint.requestBody} />
                            </div>
                          )}

                          <div>
                            <h4 className="font-semibold mb-3">Response</h4>
                            <CodeBlock code={endpoint.response} />
                          </div>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </section>
            )
          ))}
        </main>
      </div>

      <footer className="border-t border-gray-200 mt-16">
        <div className="max-w-7xl mx-auto px-6 py-8">
          <div className="flex items-center justify-between">
            <p className="text-gray-500 text-sm">MOS Maintenance API Documentation</p>
            <div className="flex items-center gap-4">
              <Link href="/api-docs.html" className="text-blue-600 hover:underline text-sm">
                OpenAPI Spec
              </Link>
              <Link href="/dashboard/settings/api-keys" className="text-blue-600 hover:underline text-sm">
                Manage API Keys
              </Link>
            </div>
          </div>
        </div>
      </footer>
    </div>
  );
}
