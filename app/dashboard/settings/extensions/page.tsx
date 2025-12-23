"use client";

import { useState, useEffect } from "react";
import { Puzzle, Chrome, Key, Copy, RefreshCw, Loader2, Check, AlertCircle } from "lucide-react";

interface ApiKeyInfo {
  key: string;
  keyId: string;
  createdAt: string;
  lastUsed?: string;
}

interface ExtensionSettings {
  enabled: boolean;
  apiKeys: ApiKeyInfo[];
}

export default function ExtensionsSettingsPage() {
  const [settings, setSettings] = useState<ExtensionSettings>({ enabled: false, apiKeys: [] });
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);

  useEffect(() => {
    fetchSettings();
  }, []);

  async function fetchSettings() {
    try {
      const res = await fetch("/api/settings/extensions");
      if (res.ok) {
        const data = await res.json();
        setSettings(data);
      }
    } catch (err) {
      console.error("Failed to fetch extension settings:", err);
    } finally {
      setLoading(false);
    }
  }

  async function toggleEnabled() {
    try {
      const res = await fetch("/api/settings/extensions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: !settings.enabled }),
      });
      if (res.ok) {
        setSettings({ ...settings, enabled: !settings.enabled });
      }
    } catch (err) {
      console.error("Failed to toggle extension:", err);
    }
  }

  async function generateApiKey() {
    setGenerating(true);
    try {
      const res = await fetch("/api/settings/extensions/generate-key", {
        method: "POST",
      });
      if (res.ok) {
        const data = await res.json();
        const fullKey = data.key;
        const maskedKey = `${fullKey.substring(0, 12)}...${fullKey.substring(fullKey.length - 4)}`;
        setSettings({
          ...settings,
          apiKeys: [...settings.apiKeys, { 
            key: maskedKey, 
            keyId: fullKey.substring(0, 20),
            createdAt: new Date().toISOString() 
          }],
        });
        setCopied(fullKey);
        setTimeout(() => setCopied(null), 5000);
        alert(`API Key generated! Copy it now - you won't be able to see it again:\n\n${fullKey}`);
      }
    } catch (err) {
      console.error("Failed to generate API key:", err);
    } finally {
      setGenerating(false);
    }
  }

  async function revokeApiKey(keyId: string) {
    if (!confirm("Are you sure you want to revoke this API key?")) return;
    try {
      await fetch("/api/settings/extensions/revoke-key", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ keyId }),
      });
      setSettings({
        ...settings,
        apiKeys: settings.apiKeys.filter(k => k.keyId !== keyId),
      });
    } catch (err) {
      console.error("Failed to revoke API key:", err);
    }
  }

  function copyToClipboard(text: string) {
    navigator.clipboard.writeText(text);
    setCopied(text);
    setTimeout(() => setCopied(null), 2000);
  }

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
      <div className="max-w-4xl mx-auto space-y-6">
        <div className="flex items-center gap-3">
          <div className="p-2 bg-blue-100 rounded-lg">
            <Puzzle className="w-6 h-6 text-blue-600" />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-gray-900">Extension Abilities</h1>
            <p className="text-sm text-gray-500">Manage browser extensions and API access</p>
          </div>
        </div>

        <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6">
          <div className="flex items-center justify-between mb-6">
            <div className="flex items-center gap-4">
              <div className="p-3 bg-gradient-to-br from-blue-500 to-purple-600 rounded-xl">
                <Chrome className="w-8 h-8 text-white" />
              </div>
              <div>
                <h2 className="text-lg font-semibold text-gray-900">Chrome Extension</h2>
                <p className="text-sm text-gray-500">Access vehicle data from AutoVitals and other tools</p>
              </div>
            </div>
            <button
              onClick={toggleEnabled}
              className={`w-14 h-8 rounded-full transition-colors ${
                settings.enabled ? "bg-blue-600" : "bg-gray-300"
              }`}
            >
              <div className={`w-6 h-6 rounded-full bg-white shadow transform transition-transform ${
                settings.enabled ? "translate-x-7" : "translate-x-1"
              }`} />
            </button>
          </div>

          {settings.enabled && (
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <h3 className="font-medium text-gray-900">API Keys</h3>
                <button
                  onClick={generateApiKey}
                  disabled={generating}
                  className="inline-flex items-center gap-2 px-3 py-1.5 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 transition-colors"
                >
                  {generating ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    <Key className="w-4 h-4" />
                  )}
                  Generate Key
                </button>
              </div>

              {settings.apiKeys.length === 0 ? (
                <div className="text-center py-8 text-gray-500">
                  <Key className="w-12 h-12 mx-auto mb-3 text-gray-300" />
                  <p>No API keys generated yet</p>
                  <p className="text-sm">Generate a key to use with the browser extension</p>
                </div>
              ) : (
                <div className="space-y-3">
                  {settings.apiKeys.map((apiKey) => (
                    <div key={apiKey.keyId} className="flex items-center justify-between p-4 bg-gray-50 rounded-lg">
                      <div className="flex-1">
                        <code className="text-sm font-mono text-gray-800">
                          {apiKey.key}
                        </code>
                        <p className="text-xs text-gray-500 mt-1">
                          Created {new Date(apiKey.createdAt).toLocaleDateString()}
                          {apiKey.lastUsed && ` • Last used ${new Date(apiKey.lastUsed).toLocaleDateString()}`}
                        </p>
                      </div>
                      <div className="flex items-center gap-2">
                        <button
                          onClick={() => revokeApiKey(apiKey.keyId)}
                          className="p-2 text-gray-500 hover:text-red-600 transition-colors"
                          title="Revoke key"
                        >
                          <RefreshCw className="w-4 h-4" />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6">
          <h2 className="text-lg font-semibold text-gray-900 mb-4">Installation Instructions</h2>
          <ol className="space-y-4 text-sm text-gray-700">
            <li className="flex gap-3">
              <span className="flex-shrink-0 w-6 h-6 bg-blue-100 text-blue-600 rounded-full flex items-center justify-center font-medium">1</span>
              <span>Download the Chrome extension from the MOS Dashboard</span>
            </li>
            <li className="flex gap-3">
              <span className="flex-shrink-0 w-6 h-6 bg-blue-100 text-blue-600 rounded-full flex items-center justify-center font-medium">2</span>
              <span>Open Chrome and go to <code className="bg-gray-100 px-1 rounded">chrome://extensions</code></span>
            </li>
            <li className="flex gap-3">
              <span className="flex-shrink-0 w-6 h-6 bg-blue-100 text-blue-600 rounded-full flex items-center justify-center font-medium">3</span>
              <span>Enable "Developer mode" in the top right</span>
            </li>
            <li className="flex gap-3">
              <span className="flex-shrink-0 w-6 h-6 bg-blue-100 text-blue-600 rounded-full flex items-center justify-center font-medium">4</span>
              <span>Click "Load unpacked" and select the extension folder</span>
            </li>
            <li className="flex gap-3">
              <span className="flex-shrink-0 w-6 h-6 bg-blue-100 text-blue-600 rounded-full flex items-center justify-center font-medium">5</span>
              <span>Generate an API key above and enter it in the extension settings</span>
            </li>
          </ol>
        </div>

        <div className="bg-amber-50 rounded-xl p-4 border border-amber-100">
          <div className="flex items-start gap-3">
            <AlertCircle className="w-5 h-5 text-amber-600 flex-shrink-0 mt-0.5" />
            <div>
              <h3 className="font-medium text-amber-900">Security Notice</h3>
              <p className="text-sm text-amber-800 mt-1">
                API keys provide full access to your shop's vehicle data. Keep them secure and revoke any keys you no longer use.
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
