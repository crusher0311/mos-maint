// app/admin/integrations/page.tsx
import Link from "next/link";
import { CheckCircle, XCircle, ExternalLink } from "lucide-react";

export const dynamic = "force-dynamic";

function isCarfaxConfigured() {
  return Boolean(process.env.CARFAX_POST_URL && process.env.CARFAX_PDI);
}

function isAutoflowConfigured() {
  return Boolean(process.env.AUTOFLOW_API_KEY || process.env.AUTOFLOW_WEBHOOK_SECRET);
}

function isDataOneConfigured() {
  return Boolean(process.env.DATAONE_API_URL);
}

export default function AdminIntegrationsPage() {
  const integrations = [
    {
      name: "CARFAX",
      description: "Vehicle history reports and service history",
      configured: isCarfaxConfigured(),
      href: "/admin/integrations/carfax",
      envVars: ["CARFAX_POST_URL", "CARFAX_PDI"],
    },
    {
      name: "AutoFlow",
      description: "Repair order sync and vehicle data",
      configured: isAutoflowConfigured(),
      href: "/admin/integrations/autoflow",
      envVars: ["AUTOFLOW_API_KEY", "AUTOFLOW_WEBHOOK_SECRET"],
    },
    {
      name: "DataOne",
      description: "VIN decoding and OEM maintenance schedules",
      configured: isDataOneConfigured(),
      href: "/admin/integrations/dataone",
      envVars: ["DATAONE_API_URL"],
    },
  ];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Integrations</h1>
        <p className="mt-1 text-sm text-gray-500">
          Manage third-party service integrations and shop-specific configurations
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        {integrations.map((integration) => (
          <div
            key={integration.name}
            className="bg-white rounded-lg shadow overflow-hidden"
          >
            <div className="p-6">
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-lg font-semibold text-gray-900">
                  {integration.name}
                </h3>
                {integration.configured ? (
                  <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium bg-green-100 text-green-700">
                    <CheckCircle className="w-3.5 h-3.5" />
                    Active
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium bg-gray-100 text-gray-600">
                    <XCircle className="w-3.5 h-3.5" />
                    Not Configured
                  </span>
                )}
              </div>
              <p className="text-sm text-gray-600 mb-4">
                {integration.description}
              </p>
              <div className="text-xs text-gray-500 mb-4">
                <span className="font-medium">Required:</span>{" "}
                {integration.envVars.join(", ")}
              </div>
              <Link
                href={integration.href}
                className="inline-flex items-center gap-1.5 text-sm font-medium text-blue-600 hover:text-blue-700"
              >
                Configure
                <ExternalLink className="w-3.5 h-3.5" />
              </Link>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
