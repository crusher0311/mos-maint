"use client";

import { useState, useEffect } from "react";
import { useSearchParams } from "next/navigation";

interface BillingConfig {
  mosProPrice: number;
}

interface FormData {
  shopName: string;
  adminEmail: string;
  adminPassword: string;
  confirmPassword: string;
}

export default function SetupWizardContent() {
  const searchParams = useSearchParams();
  const wasCancelled = searchParams.get("cancelled") === "true";
  
  const [formData, setFormData] = useState<FormData>({
    shopName: "",
    adminEmail: "",
    adminPassword: "",
    confirmPassword: "",
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(wasCancelled ? "Payment was cancelled. You can try again when ready." : "");
  const [billingConfig, setBillingConfig] = useState<BillingConfig>({
    mosProPrice: 199,
  });

  useEffect(() => {
    fetch("/api/billing/config")
      .then(res => res.json())
      .then(data => {
        if (data.ok) {
          setBillingConfig(data.config);
        }
      })
      .catch(() => {});
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    
    if (formData.adminPassword !== formData.confirmPassword) {
      setError("Passwords do not match");
      return;
    }
    
    if (formData.adminPassword.length < 8) {
      setError("Password must be at least 8 characters");
      return;
    }
    
    setBusy(true);

    try {
      const response = await fetch("/api/auth/setup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          shopName: formData.shopName,
          adminEmail: formData.adminEmail,
          adminPassword: formData.adminPassword,
          confirmPassword: formData.confirmPassword,
          skipTrial: true,
        }),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || "Setup failed");
      }

      if (data.checkoutUrl) {
        window.location.href = data.checkoutUrl;
        return;
      }

      window.location.href = "/dashboard";
    } catch (err) {
      setError(err instanceof Error ? err.message : "Setup failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 py-12 px-4 sm:px-6 lg:px-8">
      <div className="max-w-md w-full space-y-8">
        <div>
          <h2 className="mt-6 text-center text-3xl font-extrabold text-gray-900">
            Create Your Account
          </h2>
          <p className="mt-2 text-center text-sm text-gray-600">
            Get started with MOS Tools
          </p>
        </div>

        <div className="bg-blue-50 border border-blue-200 rounded-lg p-4 text-center">
          <p className="text-sm text-blue-800">
            <strong>${billingConfig.mosProPrice}/month</strong>
          </p>
          <p className="text-xs text-blue-600 mt-1">
            You can configure integrations after setup in Settings
          </p>
        </div>
        
        <form className="space-y-6" onSubmit={handleSubmit}>
          {error && (
            <div className="rounded-md bg-red-50 p-4">
              <div className="text-sm text-red-700">{error}</div>
            </div>
          )}
          
          <div className="space-y-4">
            <div>
              <label htmlFor="shopName" className="block text-sm font-medium text-gray-700">
                Shop Name
              </label>
              <input
                id="shopName"
                name="shopName"
                type="text"
                required
                value={formData.shopName}
                onChange={(e) => setFormData({ ...formData, shopName: e.target.value })}
                className="mt-1 appearance-none relative block w-full px-3 py-2 border border-gray-300 placeholder-gray-500 text-gray-900 rounded-md focus:outline-none focus:ring-indigo-500 focus:border-indigo-500 focus:z-10 sm:text-sm"
                placeholder="Your Auto Shop Name"
              />
            </div>
            
            <div>
              <label htmlFor="adminEmail" className="block text-sm font-medium text-gray-700">
                Email Address
              </label>
              <input
                id="adminEmail"
                name="adminEmail"
                type="email"
                required
                value={formData.adminEmail}
                onChange={(e) => setFormData({ ...formData, adminEmail: e.target.value })}
                className="mt-1 appearance-none relative block w-full px-3 py-2 border border-gray-300 placeholder-gray-500 text-gray-900 rounded-md focus:outline-none focus:ring-indigo-500 focus:border-indigo-500 focus:z-10 sm:text-sm"
                placeholder="admin@yourshop.com"
              />
            </div>
            
            <div>
              <label htmlFor="adminPassword" className="block text-sm font-medium text-gray-700">
                Password
              </label>
              <input
                id="adminPassword"
                name="adminPassword"
                type="password"
                required
                value={formData.adminPassword}
                onChange={(e) => setFormData({ ...formData, adminPassword: e.target.value })}
                className="mt-1 appearance-none relative block w-full px-3 py-2 border border-gray-300 placeholder-gray-500 text-gray-900 rounded-md focus:outline-none focus:ring-indigo-500 focus:border-indigo-500 focus:z-10 sm:text-sm"
                placeholder="At least 8 characters"
              />
            </div>
            
            <div>
              <label htmlFor="confirmPassword" className="block text-sm font-medium text-gray-700">
                Confirm Password
              </label>
              <input
                id="confirmPassword"
                name="confirmPassword"
                type="password"
                required
                value={formData.confirmPassword}
                onChange={(e) => setFormData({ ...formData, confirmPassword: e.target.value })}
                className="mt-1 appearance-none relative block w-full px-3 py-2 border border-gray-300 placeholder-gray-500 text-gray-900 rounded-md focus:outline-none focus:ring-indigo-500 focus:border-indigo-500 focus:z-10 sm:text-sm"
                placeholder="Confirm your password"
              />
            </div>
          </div>

          <div>
            <button
              type="submit"
              disabled={busy}
              className="group relative w-full flex justify-center py-2 px-4 border border-transparent text-sm font-medium rounded-md text-white bg-indigo-600 hover:bg-indigo-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500 disabled:opacity-50"
            >
              {busy ? "Creating Account..." : "Create Account & Subscribe"}
            </button>
          </div>
          
          <p className="text-xs text-center text-gray-500">
            By creating an account, you agree to our terms of service.
          </p>
        </form>
      </div>
    </div>
  );
}
