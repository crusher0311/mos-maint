"use client";

import { useState, useEffect } from "react";
import { Settings, CheckCircle, XCircle, Loader2, Info, Key, User, Building2 } from "lucide-react";

interface AutoVitalsSettings {
  shopId: number | null;
  userId: number | null;
  sessionCookie: string;
  jwtToken: string;
  isConfigured: boolean;
}

export default function AutoVitalsSettingsPage() {
  const [settings, setSettings] = useState<AutoVitalsSettings>({
    shopId: null,
    userId: null,
    sessionCookie: "",
    jwtToken: "",
    isConfigured: false,
  });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ success: boolean; message: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchSettings();
  }, []);

  async function fetchSettings() {
    try {
      const res = await fetch("/api/autovitals/settings");
      if (res.ok) {
        const data = await res.json();
        setSettings(data);
      }
    } catch (err) {
      console.error("Failed to fetch AutoVitals settings:", err);
    } finally {
      setLoading(false);
    }
  }

  async function handleSave() {
    setSaving(true);
    setError(null);
    setTestResult(null);

    try {
      const res = await fetch("/api/autovitals/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          shopId: settings.shopId,
          userId: settings.userId,
          sessionCookie: settings.sessionCookie,
          jwtToken: settings.jwtToken,
        }),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "Failed to save settings");
      }

      setTestResult({ success: true, message: "Settings saved successfully!" });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save settings");
    } finally {
      setSaving(false);
    }
  }

  async function handleTest() {
    setTesting(true);
    setTestResult(null);
    setError(null);

    try {
      const res = await fetch("/api/autovitals/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          shopId: settings.shopId,
          userId: settings.userId,
          sessionCookie: settings.sessionCookie,
          jwtToken: settings.jwtToken,
        }),
      });

      const data = await res.json();

      if (res.ok && data.success) {
        setTestResult({ 
          success: true, 
          message: data.shopName 
            ? `Connected to ${data.shopName}!` 
            : "Connection successful!" 
        });
      } else {
        setTestResult({ 
          success: false, 
          message: data.error || "Connection failed" 
        });
      }
    } catch (err) {
      setTestResult({ 
        success: false, 
        message: err instanceof Error ? err.message : "Connection test failed" 
      });
    } finally {
      setTesting(false);
    }
  }

  if (loading) {
    return (
      <div className="p-6 flex items-center justify-center">
        <Loader2 className="w-6 h-6 animate-spin text-gray-400" />
      </div>
    );
  }

  return (
    <div className="p-6 max-w-4xl mx-auto">
      <div className="flex items-center gap-3 mb-6">
        <div className="p-2 bg-green-100 rounded-lg">
          <Settings className="w-6 h-6 text-green-600" />
        </div>
        <div>
          <h1 className="text-2xl font-bold text-gray-900">AutoVitals Integration</h1>
          <p className="text-gray-500">Connect to AutoVitals to import vehicles and inspection data</p>
        </div>
      </div>

      <div className="bg-blue-50 border border-blue-200 rounded-lg p-4 mb-6">
        <div className="flex gap-3">
          <Info className="w-5 h-5 text-blue-600 flex-shrink-0 mt-0.5" />
          <div className="text-sm text-blue-800">
            <p className="font-medium mb-1">How to get your AutoVitals credentials:</p>
            <ol className="list-decimal list-inside space-y-1 text-blue-700">
              <li>Log in to <strong>tvpx.autovitals.com</strong> in your browser</li>
              <li>Open Developer Tools (F12) and go to the Network tab</li>
              <li>Look for any request to <code>TvpxService.asmx</code></li>
              <li>Copy the <strong>Cookie</strong> header value (for Session Cookie)</li>
              <li>Copy the <strong>Authorization</strong> header value (for JWT Token, if present)</li>
              <li>Your Shop ID and User ID can be found in the URL or request body</li>
            </ol>
          </div>
        </div>
      </div>

      <div className="bg-white rounded-lg border border-gray-200 p-6 space-y-6">
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              <Building2 className="w-4 h-4 inline mr-1" />
              Shop ID
            </label>
            <input
              type="number"
              value={settings.shopId || ""}
              onChange={(e) => setSettings({ ...settings, shopId: parseInt(e.target.value) || null })}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-green-500 focus:border-green-500"
              placeholder="e.g., 11876"
            />
            <p className="text-xs text-gray-500 mt-1">Found in URL as sid= or in request body</p>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              <User className="w-4 h-4 inline mr-1" />
              User ID (optional)
            </label>
            <input
              type="number"
              value={settings.userId || ""}
              onChange={(e) => setSettings({ ...settings, userId: parseInt(e.target.value) || null })}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-green-500 focus:border-green-500"
              placeholder="e.g., 1153730"
            />
            <p className="text-xs text-gray-500 mt-1">Found in JWT token or request body</p>
          </div>
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            <Key className="w-4 h-4 inline mr-1" />
            Session Cookie
          </label>
          <textarea
            value={settings.sessionCookie}
            onChange={(e) => setSettings({ ...settings, sessionCookie: e.target.value })}
            className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-green-500 focus:border-green-500 font-mono text-sm"
            rows={3}
            placeholder="Paste the Cookie header value from network requests..."
          />
          <p className="text-xs text-gray-500 mt-1">Copy from the Cookie header in browser dev tools</p>
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            <Key className="w-4 h-4 inline mr-1" />
            JWT Token (optional)
          </label>
          <textarea
            value={settings.jwtToken}
            onChange={(e) => setSettings({ ...settings, jwtToken: e.target.value })}
            className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-green-500 focus:border-green-500 font-mono text-sm"
            rows={2}
            placeholder="Bearer eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9..."
          />
          <p className="text-xs text-gray-500 mt-1">Only needed for chat/real-time features</p>
        </div>

        {testResult && (
          <div className={`flex items-center gap-2 p-3 rounded-lg ${
            testResult.success ? "bg-green-50 text-green-700" : "bg-red-50 text-red-700"
          }`}>
            {testResult.success ? (
              <CheckCircle className="w-5 h-5" />
            ) : (
              <XCircle className="w-5 h-5" />
            )}
            <span>{testResult.message}</span>
          </div>
        )}

        {error && (
          <div className="flex items-center gap-2 p-3 rounded-lg bg-red-50 text-red-700">
            <XCircle className="w-5 h-5" />
            <span>{error}</span>
          </div>
        )}

        <div className="flex gap-3 pt-4 border-t border-gray-200">
          <button
            onClick={handleTest}
            disabled={testing || !settings.shopId || !settings.sessionCookie}
            className="px-4 py-2 bg-gray-100 text-gray-700 rounded-lg hover:bg-gray-200 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
          >
            {testing ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                Testing...
              </>
            ) : (
              "Test Connection"
            )}
          </button>

          <button
            onClick={handleSave}
            disabled={saving || !settings.shopId || !settings.sessionCookie}
            className="px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
          >
            {saving ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                Saving...
              </>
            ) : (
              "Save Settings"
            )}
          </button>
        </div>
      </div>

      <div className="mt-6 bg-white rounded-lg border border-gray-200 p-6">
        <h2 className="text-lg font-semibold text-gray-900 mb-4">Data Sync</h2>
        <p className="text-gray-600 mb-4">
          Once connected, you can sync vehicles and inspection data from AutoVitals. 
          The data will be imported and made available on the Plan page.
        </p>
        <button
          disabled={!settings.isConfigured}
          className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          Sync Now
        </button>
        {!settings.isConfigured && (
          <p className="text-sm text-gray-500 mt-2">Save your settings first to enable sync</p>
        )}
      </div>
    </div>
  );
}
