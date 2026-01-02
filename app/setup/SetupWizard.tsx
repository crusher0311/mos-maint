"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { Gift, Zap, Clock } from "lucide-react";

interface BillingConfig {
  trialVinLimit: number;
  skipTrialBonusVins: number;
  mosProIncludedVins: number;
  mosProPrice: number;
}

interface Step1Data {
  shopName: string;
  adminEmail: string;
  adminPassword: string;
  confirmPassword: string;
  skipTrial: boolean;
}

interface IntegrationData {
  autoflow?: {
    domain?: string;
    apiKey?: string;
    apiPassword?: string;
  };
  autovitals?: {
    welcomeCode?: string;
    personalCode?: string;
  };
  protractor?: {
    apiKey?: string;
    shopId?: string;
  };
  tekmetric?: {
    shopId?: string;
  };
  carfax?: {
    locationId?: string;
  };
}

export default function SetupWizard() {
  const [currentStep, setCurrentStep] = useState(1);
  const [step1Data, setStep1Data] = useState<Step1Data>({
    shopName: "",
    adminEmail: "",
    adminPassword: "",
    confirmPassword: "",
    skipTrial: false,
  });
  const [integrations, setIntegrations] = useState<IntegrationData>({});
  const [expandedIntegration, setExpandedIntegration] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [billingConfig, setBillingConfig] = useState<BillingConfig>({
    trialVinLimit: 10,
    skipTrialBonusVins: 50,
    mosProIncludedVins: 300,
    mosProPrice: 199,
  });
  
  const router = useRouter();

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

  const handleStep1Submit = (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    
    if (step1Data.adminPassword !== step1Data.confirmPassword) {
      setError("Passwords do not match");
      return;
    }
    
    if (step1Data.adminPassword.length < 8) {
      setError("Password must be at least 8 characters");
      return;
    }
    
    setCurrentStep(2);
  };

  const handleFinalSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError("");

    try {
      const response = await fetch("/api/auth/setup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          shopName: step1Data.shopName,
          adminEmail: step1Data.adminEmail,
          adminPassword: step1Data.adminPassword,
          confirmPassword: step1Data.confirmPassword,
          skipTrial: step1Data.skipTrial,
          autoflowDomain: integrations.autoflow?.domain,
          autoflowApiKey: integrations.autoflow?.apiKey,
          autoflowApiPassword: integrations.autoflow?.apiPassword,
          autovitalsWelcomeCode: integrations.autovitals?.welcomeCode,
          autovitalsPersonalCode: integrations.autovitals?.personalCode,
          protractorApiKey: integrations.protractor?.apiKey,
          protractorShopId: integrations.protractor?.shopId,
          tekmetricShopId: integrations.tekmetric?.shopId,
          carfaxLocationId: integrations.carfax?.locationId,
        }),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || "Setup failed");
      }

      router.replace("/dashboard");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Setup failed");
    } finally {
      setBusy(false);
    }
  };

  const toggleIntegration = (name: string) => {
    setExpandedIntegration(expandedIntegration === name ? null : name);
  };

  if (currentStep === 1) {
    const totalBonusVins = billingConfig.mosProIncludedVins + billingConfig.skipTrialBonusVins;
    
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50 py-12 px-4 sm:px-6 lg:px-8">
        <div className="max-w-lg w-full space-y-8">
          <div>
            <h2 className="mt-6 text-center text-3xl font-extrabold text-gray-900">
              Setup Your Maintenance System
            </h2>
            <p className="mt-2 text-center text-sm text-gray-600">
              Step 1 of 2: Choose your plan and create your account
            </p>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <button
              type="button"
              onClick={() => setStep1Data({ ...step1Data, skipTrial: false })}
              className={`relative p-4 rounded-xl border-2 text-left transition-all ${
                !step1Data.skipTrial
                  ? "border-blue-500 bg-blue-50 ring-2 ring-blue-200"
                  : "border-gray-200 bg-white hover:border-gray-300"
              }`}
            >
              <div className="flex items-center gap-2 mb-2">
                <Clock className="w-5 h-5 text-blue-600" />
                <span className="font-semibold text-gray-900">Free Trial</span>
              </div>
              <p className="text-sm text-gray-600">
                Try with {billingConfig.trialVinLimit} VINs free
              </p>
              <p className="text-xs text-gray-500 mt-1">
                No credit card required
              </p>
              {!step1Data.skipTrial && (
                <div className="absolute top-2 right-2 w-5 h-5 bg-blue-500 rounded-full flex items-center justify-center">
                  <svg className="w-3 h-3 text-white" fill="currentColor" viewBox="0 0 20 20">
                    <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                  </svg>
                </div>
              )}
            </button>

            <button
              type="button"
              onClick={() => setStep1Data({ ...step1Data, skipTrial: true })}
              className={`relative p-4 rounded-xl border-2 text-left transition-all ${
                step1Data.skipTrial
                  ? "border-green-500 bg-green-50 ring-2 ring-green-200"
                  : "border-gray-200 bg-white hover:border-gray-300"
              }`}
            >
              <div className="absolute -top-2 -right-2 bg-amber-500 text-white text-xs font-bold px-2 py-0.5 rounded-full flex items-center gap-1">
                <Gift className="w-3 h-3" />
                +{billingConfig.skipTrialBonusVins} Bonus
              </div>
              <div className="flex items-center gap-2 mb-2">
                <Zap className="w-5 h-5 text-green-600" />
                <span className="font-semibold text-gray-900">Subscribe Now</span>
              </div>
              <p className="text-sm text-gray-600">
                Get {totalBonusVins} VINs
              </p>
              <p className="text-xs text-gray-500 mt-1">
                ${billingConfig.mosProPrice}/month
              </p>
              {step1Data.skipTrial && (
                <div className="absolute top-2 right-2 w-5 h-5 bg-green-500 rounded-full flex items-center justify-center">
                  <svg className="w-3 h-3 text-white" fill="currentColor" viewBox="0 0 20 20">
                    <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                  </svg>
                </div>
              )}
            </button>
          </div>

          {step1Data.skipTrial && (
            <div className="bg-green-50 border border-green-200 rounded-lg p-3 text-center">
              <p className="text-sm text-green-800">
                <strong>Great choice!</strong> You'll get {billingConfig.mosProIncludedVins} + {billingConfig.skipTrialBonusVins} = <strong>{totalBonusVins} VINs</strong> when you subscribe after setup.
              </p>
            </div>
          )}
          
          <form className="space-y-6" onSubmit={handleStep1Submit}>
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
                  value={step1Data.shopName}
                  onChange={(e) => setStep1Data({ ...step1Data, shopName: e.target.value })}
                  className="mt-1 appearance-none relative block w-full px-3 py-2 border border-gray-300 placeholder-gray-500 text-gray-900 rounded-md focus:outline-none focus:ring-indigo-500 focus:border-indigo-500 focus:z-10 sm:text-sm"
                  placeholder="Your Auto Shop Name"
                />
              </div>
              
              <div>
                <label htmlFor="adminEmail" className="block text-sm font-medium text-gray-700">
                  Admin Email
                </label>
                <input
                  id="adminEmail"
                  name="adminEmail"
                  type="email"
                  required
                  value={step1Data.adminEmail}
                  onChange={(e) => setStep1Data({ ...step1Data, adminEmail: e.target.value })}
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
                  value={step1Data.adminPassword}
                  onChange={(e) => setStep1Data({ ...step1Data, adminPassword: e.target.value })}
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
                  value={step1Data.confirmPassword}
                  onChange={(e) => setStep1Data({ ...step1Data, confirmPassword: e.target.value })}
                  className="mt-1 appearance-none relative block w-full px-3 py-2 border border-gray-300 placeholder-gray-500 text-gray-900 rounded-md focus:outline-none focus:ring-indigo-500 focus:border-indigo-500 focus:z-10 sm:text-sm"
                  placeholder="Confirm your password"
                />
              </div>
            </div>

            <div>
              <button
                type="submit"
                className="group relative w-full flex justify-center py-2 px-4 border border-transparent text-sm font-medium rounded-md text-white bg-indigo-600 hover:bg-indigo-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500"
              >
                Continue to Integrations
              </button>
            </div>
          </form>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 py-12 px-4 sm:px-6 lg:px-8">
      <div className="max-w-lg w-full space-y-8">
        <div>
          <h2 className="mt-6 text-center text-3xl font-extrabold text-gray-900">
            Configure Integrations
          </h2>
          <p className="mt-2 text-center text-sm text-gray-600">
            Step 2 of 2: Connect your shop systems (all optional, can be done later)
          </p>
        </div>
        
        <form className="mt-8 space-y-4" onSubmit={handleFinalSubmit}>
          {error && (
            <div className="rounded-md bg-red-50 p-4">
              <div className="text-sm text-red-700">{error}</div>
            </div>
          )}
          
          {/* AutoFlow Integration */}
          <div className="border border-gray-200 rounded-lg overflow-hidden">
            <button
              type="button"
              onClick={() => toggleIntegration("autoflow")}
              className="w-full px-4 py-3 flex items-center justify-between bg-white hover:bg-gray-50"
            >
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 bg-blue-100 rounded-lg flex items-center justify-center">
                  <span className="text-blue-600 font-bold text-sm">AF</span>
                </div>
                <div className="text-left">
                  <p className="font-medium text-gray-900">AutoFlow</p>
                  <p className="text-xs text-gray-500">Shop management & vehicle data</p>
                </div>
              </div>
              <svg className={`w-5 h-5 text-gray-400 transition-transform ${expandedIntegration === "autoflow" ? "rotate-180" : ""}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
              </svg>
            </button>
            
            {expandedIntegration === "autoflow" && (
              <div className="px-4 py-4 bg-gray-50 border-t border-gray-200 space-y-3">
                <input
                  type="text"
                  placeholder="AutoFlow Subdomain (e.g., yourshop)"
                  value={integrations.autoflow?.domain || ""}
                  onChange={(e) => setIntegrations({ 
                    ...integrations, 
                    autoflow: { ...integrations.autoflow, domain: e.target.value }
                  })}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm"
                />
                <input
                  type="text"
                  placeholder="API Key"
                  value={integrations.autoflow?.apiKey || ""}
                  onChange={(e) => setIntegrations({ 
                    ...integrations, 
                    autoflow: { ...integrations.autoflow, apiKey: e.target.value }
                  })}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm"
                />
                <input
                  type="password"
                  placeholder="API Password"
                  value={integrations.autoflow?.apiPassword || ""}
                  onChange={(e) => setIntegrations({ 
                    ...integrations, 
                    autoflow: { ...integrations.autoflow, apiPassword: e.target.value }
                  })}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm"
                />
              </div>
            )}
          </div>

          {/* AutoVitals Integration */}
          <div className="border border-gray-200 rounded-lg overflow-hidden">
            <button
              type="button"
              onClick={() => toggleIntegration("autovitals")}
              className="w-full px-4 py-3 flex items-center justify-between bg-white hover:bg-gray-50"
            >
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 bg-green-100 rounded-lg flex items-center justify-center">
                  <span className="text-green-600 font-bold text-sm">AV</span>
                </div>
                <div className="text-left">
                  <p className="font-medium text-gray-900">AutoVitals</p>
                  <p className="text-xs text-gray-500">Digital vehicle inspections (DVI)</p>
                </div>
              </div>
              <svg className={`w-5 h-5 text-gray-400 transition-transform ${expandedIntegration === "autovitals" ? "rotate-180" : ""}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
              </svg>
            </button>
            
            {expandedIntegration === "autovitals" && (
              <div className="px-4 py-4 bg-gray-50 border-t border-gray-200 space-y-3">
                <p className="text-xs text-gray-600 mb-2">
                  Enter the same codes you use to log into AutoVitals
                </p>
                <input
                  type="text"
                  placeholder="Welcome Code (your shop's code)"
                  value={integrations.autovitals?.welcomeCode || ""}
                  onChange={(e) => setIntegrations({ 
                    ...integrations, 
                    autovitals: { ...integrations.autovitals, welcomeCode: e.target.value }
                  })}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm"
                />
                <input
                  type="text"
                  placeholder="Personal Code (your employee code)"
                  value={integrations.autovitals?.personalCode || ""}
                  onChange={(e) => setIntegrations({ 
                    ...integrations, 
                    autovitals: { ...integrations.autovitals, personalCode: e.target.value }
                  })}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm"
                />
              </div>
            )}
          </div>

          {/* Protractor Integration */}
          <div className="border border-gray-200 rounded-lg overflow-hidden">
            <button
              type="button"
              onClick={() => toggleIntegration("protractor")}
              className="w-full px-4 py-3 flex items-center justify-between bg-white hover:bg-gray-50"
            >
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 bg-purple-100 rounded-lg flex items-center justify-center">
                  <span className="text-purple-600 font-bold text-sm">PR</span>
                </div>
                <div className="text-left">
                  <p className="font-medium text-gray-900">Protractor</p>
                  <p className="text-xs text-gray-500">Shop management & repair orders</p>
                </div>
              </div>
              <svg className={`w-5 h-5 text-gray-400 transition-transform ${expandedIntegration === "protractor" ? "rotate-180" : ""}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
              </svg>
            </button>
            
            {expandedIntegration === "protractor" && (
              <div className="px-4 py-4 bg-gray-50 border-t border-gray-200 space-y-3">
                <input
                  type="text"
                  placeholder="Shop ID"
                  value={integrations.protractor?.shopId || ""}
                  onChange={(e) => setIntegrations({ 
                    ...integrations, 
                    protractor: { ...integrations.protractor, shopId: e.target.value }
                  })}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm"
                />
                <input
                  type="password"
                  placeholder="API Key"
                  value={integrations.protractor?.apiKey || ""}
                  onChange={(e) => setIntegrations({ 
                    ...integrations, 
                    protractor: { ...integrations.protractor, apiKey: e.target.value }
                  })}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm"
                />
              </div>
            )}
          </div>

          {/* Tekmetric Integration */}
          <div className="border border-gray-200 rounded-lg overflow-hidden">
            <button
              type="button"
              onClick={() => toggleIntegration("tekmetric")}
              className="w-full px-4 py-3 flex items-center justify-between bg-white hover:bg-gray-50"
            >
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 bg-orange-100 rounded-lg flex items-center justify-center">
                  <span className="text-orange-600 font-bold text-sm">TK</span>
                </div>
                <div className="text-left">
                  <p className="font-medium text-gray-900">Tekmetric</p>
                  <p className="text-xs text-gray-500">Shop management & repair orders</p>
                </div>
              </div>
              <svg className={`w-5 h-5 text-gray-400 transition-transform ${expandedIntegration === "tekmetric" ? "rotate-180" : ""}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
              </svg>
            </button>
            
            {expandedIntegration === "tekmetric" && (
              <div className="px-4 py-4 bg-gray-50 border-t border-gray-200 space-y-3">
                <p className="text-xs text-gray-600 mb-2">
                  Enter your Tekmetric Shop ID (found in your Tekmetric account settings)
                </p>
                <input
                  type="text"
                  placeholder="Shop ID (e.g., 12345)"
                  value={integrations.tekmetric?.shopId || ""}
                  onChange={(e) => setIntegrations({ 
                    ...integrations, 
                    tekmetric: { ...integrations.tekmetric, shopId: e.target.value }
                  })}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm"
                />
              </div>
            )}
          </div>

          {/* CARFAX Integration */}
          <div className="border border-gray-200 rounded-lg overflow-hidden">
            <button
              type="button"
              onClick={() => toggleIntegration("carfax")}
              className="w-full px-4 py-3 flex items-center justify-between bg-white hover:bg-gray-50"
            >
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 bg-red-100 rounded-lg flex items-center justify-center">
                  <span className="text-red-600 font-bold text-sm">CF</span>
                </div>
                <div className="text-left">
                  <p className="font-medium text-gray-900">CARFAX</p>
                  <p className="text-xs text-gray-500">Vehicle history reports</p>
                </div>
              </div>
              <svg className={`w-5 h-5 text-gray-400 transition-transform ${expandedIntegration === "carfax" ? "rotate-180" : ""}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
              </svg>
            </button>
            
            {expandedIntegration === "carfax" && (
              <div className="px-4 py-4 bg-gray-50 border-t border-gray-200 space-y-3">
                <p className="text-xs text-gray-600 mb-2">
                  Enter your CARFAX Location ID from your CARFAX account
                </p>
                <input
                  type="text"
                  placeholder="Location ID"
                  value={integrations.carfax?.locationId || ""}
                  onChange={(e) => setIntegrations({ 
                    ...integrations, 
                    carfax: { ...integrations.carfax, locationId: e.target.value }
                  })}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm"
                />
              </div>
            )}
          </div>

          <div className="flex space-x-4 pt-4">
            <button
              type="button"
              onClick={() => setCurrentStep(1)}
              className="flex-1 py-2 px-4 border border-gray-300 text-sm font-medium rounded-md text-gray-700 bg-white hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500"
            >
              Back
            </button>
            <button
              type="submit"
              disabled={busy}
              className="flex-1 py-2 px-4 border border-transparent text-sm font-medium rounded-md text-white bg-indigo-600 hover:bg-indigo-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500 disabled:opacity-50"
            >
              {busy ? "Setting up..." : "Complete Setup"}
            </button>
          </div>
          
          <p className="text-center text-xs text-gray-500">
            You can configure or update integrations later in Settings
          </p>
        </form>
      </div>
    </div>
  );
}
