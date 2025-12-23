"use client";

import { useState, useEffect } from "react";
import { CreditCard, Check, AlertCircle, Loader2 } from "lucide-react";

interface BillingInfo {
  plan: string;
  status: string;
  vehicleCount: number;
  vehicleLimit: number;
  nextBillingDate?: string;
}

export default function BillingSettingsPage() {
  const [billing, setBilling] = useState<BillingInfo | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchBilling();
  }, []);

  async function fetchBilling() {
    try {
      const res = await fetch("/api/settings/billing");
      if (res.ok) {
        const data = await res.json();
        setBilling(data);
      } else {
        setBilling({
          plan: "Free Trial",
          status: "active",
          vehicleCount: 0,
          vehicleLimit: 50,
        });
      }
    } catch (err) {
      setBilling({
        plan: "Free Trial",
        status: "active",
        vehicleCount: 0,
        vehicleLimit: 50,
      });
    } finally {
      setLoading(false);
    }
  }

  const plans = [
    {
      name: "Starter",
      price: "$49",
      period: "/month",
      features: [
        "Up to 100 vehicles",
        "Basic OEM schedules",
        "Email support",
        "1 user",
      ],
      current: billing?.plan === "Starter",
    },
    {
      name: "Professional",
      price: "$99",
      period: "/month",
      features: [
        "Up to 500 vehicles",
        "All integrations",
        "Priority support",
        "5 users",
        "Custom intervals",
      ],
      current: billing?.plan === "Professional",
      popular: true,
    },
    {
      name: "Enterprise",
      price: "Custom",
      period: "",
      features: [
        "Unlimited vehicles",
        "Dedicated support",
        "Unlimited users",
        "API access",
        "Custom features",
      ],
      current: billing?.plan === "Enterprise",
    },
  ];

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
      <div className="max-w-5xl mx-auto space-y-8">
        <div className="flex items-center gap-3">
          <div className="p-2 bg-blue-100 rounded-lg">
            <CreditCard className="w-6 h-6 text-blue-600" />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-gray-900">Billing</h1>
            <p className="text-sm text-gray-500">Manage your subscription and payment</p>
          </div>
        </div>

        <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6">
          <h2 className="text-lg font-semibold text-gray-900 mb-4">Current Plan</h2>
          <div className="flex items-center justify-between">
            <div>
              <p className="text-2xl font-bold text-gray-900">{billing?.plan || "Free Trial"}</p>
              <p className="text-sm text-gray-500">
                {billing?.vehicleCount || 0} of {billing?.vehicleLimit || 50} vehicles used
              </p>
            </div>
            <div className="flex items-center gap-2">
              <span className={`px-3 py-1 rounded-full text-sm font-medium ${
                billing?.status === "active" 
                  ? "bg-green-100 text-green-800" 
                  : "bg-yellow-100 text-yellow-800"
              }`}>
                {billing?.status === "active" ? "Active" : "Trial"}
              </span>
            </div>
          </div>
          {billing?.nextBillingDate && (
            <p className="mt-4 text-sm text-gray-500">
              Next billing date: {new Date(billing.nextBillingDate).toLocaleDateString()}
            </p>
          )}
        </div>

        <div>
          <h2 className="text-lg font-semibold text-gray-900 mb-4">Available Plans</h2>
          <div className="grid md:grid-cols-3 gap-6">
            {plans.map((plan) => (
              <div
                key={plan.name}
                className={`relative bg-white rounded-xl shadow-sm border-2 p-6 ${
                  plan.current 
                    ? "border-blue-600" 
                    : plan.popular 
                      ? "border-blue-200" 
                      : "border-gray-200"
                }`}
              >
                {plan.popular && (
                  <div className="absolute -top-3 left-1/2 -translate-x-1/2">
                    <span className="bg-blue-600 text-white text-xs font-medium px-3 py-1 rounded-full">
                      Most Popular
                    </span>
                  </div>
                )}
                {plan.current && (
                  <div className="absolute -top-3 right-4">
                    <span className="bg-green-600 text-white text-xs font-medium px-3 py-1 rounded-full">
                      Current
                    </span>
                  </div>
                )}
                <div className="mb-4">
                  <h3 className="text-xl font-bold text-gray-900">{plan.name}</h3>
                  <div className="mt-2">
                    <span className="text-3xl font-bold text-gray-900">{plan.price}</span>
                    <span className="text-gray-500">{plan.period}</span>
                  </div>
                </div>
                <ul className="space-y-3 mb-6">
                  {plan.features.map((feature) => (
                    <li key={feature} className="flex items-center gap-2 text-sm text-gray-600">
                      <Check className="w-4 h-4 text-green-600 flex-shrink-0" />
                      {feature}
                    </li>
                  ))}
                </ul>
                <button
                  disabled={plan.current}
                  className={`w-full py-2 px-4 rounded-lg font-medium transition-colors ${
                    plan.current
                      ? "bg-gray-100 text-gray-400 cursor-not-allowed"
                      : "bg-blue-600 text-white hover:bg-blue-700"
                  }`}
                >
                  {plan.current ? "Current Plan" : "Upgrade"}
                </button>
              </div>
            ))}
          </div>
        </div>

        <div className="bg-amber-50 rounded-xl p-6 border border-amber-100">
          <div className="flex items-start gap-3">
            <AlertCircle className="w-5 h-5 text-amber-600 flex-shrink-0 mt-0.5" />
            <div>
              <h3 className="font-semibold text-amber-900">Need to upgrade?</h3>
              <p className="text-sm text-amber-800 mt-1">
                Contact our sales team for custom pricing or to discuss your specific needs.
                Email us at support@mosmaintenance.com
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
