"use client";

import { useState, useEffect } from "react";
import { CheckCircle, ArrowRight, Loader2, ExternalLink, Settings, Users, Puzzle, Car } from "lucide-react";
import Link from "next/link";

interface OnboardingStep {
  id: string;
  title: string;
  description: string;
  completed: boolean;
  href: string;
  icon: React.ReactNode;
}

export default function OnboardingPage() {
  const [steps, setSteps] = useState<OnboardingStep[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchOnboardingStatus();
  }, []);

  async function fetchOnboardingStatus() {
    try {
      const [integrationsRes, usersRes, vehiclesRes] = await Promise.all([
        fetch("/api/onboarding/integrations-status").catch(() => null),
        fetch("/api/settings/users").catch(() => null),
        fetch("/api/dashboard/data").catch(() => null),
      ]);

      const integrationsData = integrationsRes?.ok ? await integrationsRes.json() : { hasIntegration: false };
      const usersData = usersRes?.ok ? await usersRes.json() : { users: [] };
      const vehiclesData = vehiclesRes?.ok ? await vehiclesRes.json() : { rows: [] };

      const hasIntegration = integrationsData.hasIntegration;
      const hasTeamMembers = (usersData.users?.length || 0) > 1;
      const hasVehicles = (vehiclesData.rows?.length || 0) > 0;

      setSteps([
        {
          id: "profile",
          title: "Complete Shop Profile",
          description: "Add your shop name, address, and contact information",
          completed: true,
          href: "/dashboard/settings",
          icon: <Settings className="w-5 h-5" />,
        },
        {
          id: "integration",
          title: "Connect an Integration",
          description: "Link your shop management system like Tekmetric, Protractor, or AutoFlow",
          completed: hasIntegration,
          href: "/dashboard/settings/integrations",
          icon: <Puzzle className="w-5 h-5" />,
        },
        {
          id: "vehicles",
          title: "Import Vehicles",
          description: "Sync vehicles from your shop management system",
          completed: hasVehicles,
          href: "/dashboard",
          icon: <Car className="w-5 h-5" />,
        },
        {
          id: "team",
          title: "Invite Team Members",
          description: "Add service advisors and other staff to your account",
          completed: hasTeamMembers,
          href: "/dashboard/settings/users",
          icon: <Users className="w-5 h-5" />,
        },
      ]);
    } catch (err) {
      console.error("Failed to fetch onboarding status:", err);
    } finally {
      setLoading(false);
    }
  }

  const completedCount = steps.filter(s => s.completed).length;
  const progressPercent = steps.length > 0 ? (completedCount / steps.length) * 100 : 0;

  if (loading) {
    return (
      <div className="flex-1 p-8">
        <div className="flex items-center justify-center h-64">
          <Loader2 className="w-8 h-8 animate-spin text-blue-600" />
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 p-8 overflow-auto">
      <div className="max-w-3xl mx-auto space-y-8">
        <div className="text-center">
          <div className="inline-flex items-center justify-center w-16 h-16 bg-blue-100 rounded-2xl mb-4">
            <CheckCircle className="w-8 h-8 text-blue-600" />
          </div>
          <h1 className="text-3xl font-bold text-gray-900">Welcome to MOS Maintenance</h1>
          <p className="text-gray-500 mt-2">Complete these steps to get your shop up and running</p>
        </div>

        <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-semibold text-gray-900">Setup Progress</h2>
            <span className="text-sm font-medium text-blue-600">{completedCount} of {steps.length} complete</span>
          </div>
          <div className="w-full bg-gray-200 rounded-full h-3">
            <div
              className="bg-blue-600 h-3 rounded-full transition-all duration-500"
              style={{ width: `${progressPercent}%` }}
            />
          </div>
        </div>

        <div className="space-y-4">
          {steps.map((step, index) => (
            <Link
              key={step.id}
              href={step.href}
              className={`block bg-white rounded-xl shadow-sm border-2 p-6 transition-all hover:shadow-md ${
                step.completed ? "border-green-200" : "border-gray-200 hover:border-blue-200"
              }`}
            >
              <div className="flex items-start gap-4">
                <div className={`flex-shrink-0 w-10 h-10 rounded-full flex items-center justify-center ${
                  step.completed ? "bg-green-100" : "bg-gray-100"
                }`}>
                  {step.completed ? (
                    <CheckCircle className="w-6 h-6 text-green-600" />
                  ) : (
                    <span className="text-gray-400 font-medium">{index + 1}</span>
                  )}
                </div>
                <div className="flex-1">
                  <div className="flex items-center gap-2">
                    <h3 className={`font-semibold ${step.completed ? "text-green-700" : "text-gray-900"}`}>
                      {step.title}
                    </h3>
                    {step.completed && (
                      <span className="px-2 py-0.5 bg-green-100 text-green-700 text-xs font-medium rounded-full">
                        Complete
                      </span>
                    )}
                  </div>
                  <p className="text-sm text-gray-500 mt-1">{step.description}</p>
                </div>
                <div className={`flex-shrink-0 p-2 rounded-lg ${
                  step.completed ? "bg-green-50 text-green-600" : "bg-blue-50 text-blue-600"
                }`}>
                  {step.icon}
                </div>
              </div>
            </Link>
          ))}
        </div>

        {completedCount === steps.length && (
          <div className="bg-gradient-to-r from-green-500 to-emerald-600 rounded-xl p-8 text-center text-white">
            <CheckCircle className="w-12 h-12 mx-auto mb-4" />
            <h2 className="text-2xl font-bold mb-2">Setup Complete!</h2>
            <p className="opacity-90 mb-6">Your shop is ready to start using MOS Maintenance</p>
            <Link
              href="/dashboard"
              className="inline-flex items-center gap-2 px-6 py-3 bg-white text-green-600 font-semibold rounded-lg hover:bg-gray-50 transition-colors"
            >
              Go to Dashboard
              <ArrowRight className="w-4 h-4" />
            </Link>
          </div>
        )}

        <div className="bg-blue-50 rounded-xl p-6 border border-blue-100">
          <h3 className="font-semibold text-blue-900 mb-2">Need Help?</h3>
          <p className="text-sm text-blue-800 mb-4">
            Our support team is here to help you get set up. Contact us if you have any questions.
          </p>
          <a
            href="mailto:support@mosmaintenance.com"
            className="inline-flex items-center gap-2 text-sm font-medium text-blue-600 hover:text-blue-700"
          >
            Contact Support
            <ExternalLink className="w-4 h-4" />
          </a>
        </div>
      </div>
    </div>
  );
}
