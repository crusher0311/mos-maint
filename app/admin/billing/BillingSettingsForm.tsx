"use client";

import { useState, useMemo } from "react";
import { Save, ExternalLink, RefreshCw, Copy, Check, Package, CreditCard, Gift, Mail, Send, Eye } from "lucide-react";
import type { BillingSettings } from "@/lib/stripe";
import {
  DEFAULT_TRIAL_REMINDER_SUBJECT,
  DEFAULT_TRIAL_REMINDER_HTML,
  DEFAULT_TRIAL_REMINDER_TEXT,
} from "@/lib/email";

type StripePrice = {
  id: string;
  productId: string;
  productName: string | null;
  unitAmount: number | null;
  currency: string;
  type: string;
  recurring: { interval: string; intervalCount: number } | null;
  metadata: Record<string, string>;
};

type StripeProduct = {
  id: string;
  name: string;
  description: string | null;
  metadata: Record<string, string>;
  active: boolean;
};

export default function BillingSettingsForm({
  initialSettings,
}: {
  initialSettings: BillingSettings;
}) {
  const [settings, setSettings] = useState(initialSettings);
  const [saving, setSaving] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [message, setMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);
  const [stripeData, setStripeData] = useState<{ products: StripeProduct[]; prices: StripePrice[] } | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [reminderDaysInput, setReminderDaysInput] = useState(
    (initialSettings.trialReminderDays || []).join(", "),
  );
  const [previewDaysLeft, setPreviewDaysLeft] = useState<number>(3);
  const [previewShopName, setPreviewShopName] = useState<string>("Sample Auto Shop");
  const [showPreview, setShowPreview] = useState<boolean>(false);
  const [sendingTest, setSendingTest] = useState<boolean>(false);
  const [testMessage, setTestMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);

  // Live client-side render of the trial reminder template using sample values.
  // Mirrors the substitution logic in `lib/email.ts#applyTrialReminderTemplate`
  // so admins see the same output the cron would produce, without making a
  // round trip to the server on every keystroke.
  const previewVars = useMemo(() => {
    const days = Number.isFinite(previewDaysLeft) && previewDaysLeft > 0
      ? Math.trunc(previewDaysLeft)
      : 3;
    const endsAt = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
    return {
      shopName: previewShopName.trim() || "Sample Auto Shop",
      daysLeft: String(days),
      dayWord: days === 1 ? "day" : "days",
      trialEndsAt: endsAt.toLocaleDateString("en-US", {
        weekday: "long",
        month: "long",
        day: "numeric",
        year: "numeric",
      }),
      addCardUrl: "https://app.example.com/dashboard/settings/billing",
    } as Record<string, string>;
  }, [previewDaysLeft, previewShopName]);

  const applyTemplate = (tpl: string, vars: Record<string, string>) =>
    tpl.replace(/\{\{\s*(\w+)\s*\}\}/g, (_m, key) =>
      Object.prototype.hasOwnProperty.call(vars, key) ? vars[key] : "",
    );

  // Mirror the server-side fallback in `lib/email.ts#makeTrialReminderEmail`:
  // empty/whitespace-only overrides fall back to the built-in defaults so the
  // preview matches what the cron (and the test-send endpoint) will actually
  // produce when an admin clears a field.
  const pickTpl = (override: string | undefined, fallback: string) =>
    override && override.trim() ? override : fallback;

  const renderedPreview = useMemo(() => {
    const subjectTpl = pickTpl(settings.trialReminderSubject, DEFAULT_TRIAL_REMINDER_SUBJECT);
    const htmlTpl = pickTpl(settings.trialReminderHtml, DEFAULT_TRIAL_REMINDER_HTML);
    const textTpl = pickTpl(settings.trialReminderText, DEFAULT_TRIAL_REMINDER_TEXT);
    return {
      subject: applyTemplate(subjectTpl, previewVars),
      html: applyTemplate(htmlTpl, previewVars),
      text: applyTemplate(textTpl, previewVars),
    };
  }, [settings.trialReminderSubject, settings.trialReminderHtml, settings.trialReminderText, previewVars]);

  const handleSendTestEmail = async () => {
    setSendingTest(true);
    setTestMessage(null);
    try {
      const res = await fetch("/api/admin/billing/preview-trial-reminder", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          subject: settings.trialReminderSubject,
          html: settings.trialReminderHtml,
          text: settings.trialReminderText,
          daysLeft: previewDaysLeft,
          shopName: previewShopName,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data?.error || "Failed to send test email");
      }
      setTestMessage({
        type: "success",
        text: `Test email sent to ${data?.sentTo || "your inbox"}.`,
      });
    } catch (err: any) {
      setTestMessage({ type: "error", text: err.message });
    } finally {
      setSendingTest(false);
    }
  };

  // Parse the comma-separated reminder days input on save. The server also
  // sanitizes, but doing it client-side keeps the on-screen value in sync
  // with what actually gets persisted.
  const parseReminderDays = (raw: string): number[] => {
    const parts = raw
      .split(/[,\s]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    const set = new Set<number>();
    for (const p of parts) {
      const n = Number(p);
      if (Number.isFinite(n) && Math.trunc(n) > 0) set.add(Math.trunc(n));
    }
    return Array.from(set).sort((a, b) => b - a);
  };

  const handleSave = async () => {
    setSaving(true);
    setMessage(null);

    try {
      const reminderDays = parseReminderDays(reminderDaysInput);
      const payload = { ...settings, trialReminderDays: reminderDays };
      const res = await fetch("/api/admin/billing/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data?.error || "Failed to save");
      }

      // Rehydrate from the server's sanitized response so the UI matches
      // exactly what was persisted (the server fills in safe defaults if
      // the admin cleared a template field or the day list).
      const persisted = (data?.settings ?? null) as BillingSettings | null;
      if (persisted) {
        setSettings(persisted);
        setReminderDaysInput((persisted.trialReminderDays || []).join(", "));
      } else {
        setSettings({ ...settings, trialReminderDays: reminderDays });
        setReminderDaysInput(reminderDays.join(", "));
      }
      setMessage({ type: "success", text: "Billing settings saved successfully" });
    } catch (err: any) {
      setMessage({ type: "error", text: err.message });
    } finally {
      setSaving(false);
    }
  };

  const handleSyncFromStripe = async () => {
    setSyncing(true);
    setMessage(null);

    try {
      const res = await fetch("/api/admin/billing/sync-stripe");
      if (!res.ok) {
        const error = await res.json();
        throw new Error(error.error || "Failed to sync from Stripe");
      }

      const data = await res.json();
      setStripeData(data);
      setMessage({ type: "success", text: `Found ${data.products?.length || 0} products and ${data.prices?.length || 0} prices in Stripe` });
    } catch (err: any) {
      setMessage({ type: "error", text: err.message });
    } finally {
      setSyncing(false);
    }
  };

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
    setCopiedId(text);
    setTimeout(() => setCopiedId(null), 2000);
  };

  const formatPrice = (amount: number | null, currency: string) => {
    if (amount === null) return "N/A";
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: currency.toUpperCase(),
    }).format(amount / 100);
  };

  return (
    <div className="space-y-6">
      {message && (
        <div
          className={`p-4 rounded-lg ${
            message.type === "success"
              ? "bg-green-50 text-green-800 border border-green-200"
              : "bg-red-50 text-red-800 border border-red-200"
          }`}
        >
          {message.text}
        </div>
      )}

      <div className="bg-white shadow rounded-lg divide-y divide-gray-200">
        <div className="p-6">
          <div className="flex items-center justify-between mb-6">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 bg-blue-100 rounded-lg flex items-center justify-center">
                <CreditCard className="w-5 h-5 text-blue-600" />
              </div>
              <div>
                <h3 className="text-lg font-semibold text-gray-900">Subscription Tiers</h3>
                <p className="text-sm text-gray-500">Configure Stripe product/price IDs for each tier</p>
              </div>
            </div>
            <a
              href="https://dashboard.stripe.com/products"
              target="_blank"
              rel="noopener noreferrer"
              className="text-sm text-blue-600 hover:text-blue-500 inline-flex items-center gap-1"
            >
              <ExternalLink className="w-4 h-4" />
              Stripe Dashboard
            </a>
          </div>

          <div className="space-y-6">
            <div className="bg-gray-50 rounded-lg p-4">
              <div className="flex items-center justify-between mb-3">
                <span className="font-medium text-gray-900">Starter - ${settings.starterPrice}/month</span>
                <span className="text-xs text-gray-500">Maintenance + Oil Sticker</span>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
                <div>
                  <label className="block text-xs font-medium text-gray-500 mb-1">Product ID</label>
                  <input
                    type="text"
                    value={settings.starterProductId}
                    onChange={(e) => setSettings({ ...settings, starterProductId: e.target.value })}
                    placeholder="prod_..."
                    className="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:ring-blue-500 focus:border-blue-500 text-sm"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-500 mb-1">Price ID</label>
                  <input
                    type="text"
                    value={settings.starterPriceId}
                    onChange={(e) => setSettings({ ...settings, starterPriceId: e.target.value })}
                    placeholder="price_..."
                    className="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:ring-blue-500 focus:border-blue-500 text-sm"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-500 mb-1">Price ($)</label>
                  <input
                    type="number"
                    step="0.01"
                    value={settings.starterPrice}
                    onChange={(e) => setSettings({ ...settings, starterPrice: parseFloat(e.target.value) || 0 })}
                    className="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:ring-blue-500 focus:border-blue-500 text-sm"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-500 mb-1">Included VINs</label>
                  <input
                    type="number"
                    value={settings.starterIncludedVins}
                    onChange={(e) => setSettings({ ...settings, starterIncludedVins: parseInt(e.target.value) || 0 })}
                    className="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:ring-blue-500 focus:border-blue-500 text-sm"
                  />
                </div>
              </div>
            </div>

            <div className="bg-blue-50 rounded-lg p-4 border border-blue-200">
              <div className="flex items-center justify-between mb-3">
                <span className="font-medium text-gray-900">Plus - ${settings.plusPrice}/month</span>
                <span className="text-xs bg-blue-100 text-blue-700 px-2 py-1 rounded-full">Most Popular</span>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
                <div>
                  <label className="block text-xs font-medium text-gray-500 mb-1">Product ID</label>
                  <input
                    type="text"
                    value={settings.plusProductId}
                    onChange={(e) => setSettings({ ...settings, plusProductId: e.target.value })}
                    placeholder="prod_..."
                    className="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:ring-blue-500 focus:border-blue-500 text-sm"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-500 mb-1">Price ID</label>
                  <input
                    type="text"
                    value={settings.plusPriceId}
                    onChange={(e) => setSettings({ ...settings, plusPriceId: e.target.value })}
                    placeholder="price_..."
                    className="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:ring-blue-500 focus:border-blue-500 text-sm"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-500 mb-1">Price ($)</label>
                  <input
                    type="number"
                    step="0.01"
                    value={settings.plusPrice}
                    onChange={(e) => setSettings({ ...settings, plusPrice: parseFloat(e.target.value) || 0 })}
                    className="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:ring-blue-500 focus:border-blue-500 text-sm"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-500 mb-1">Included VINs</label>
                  <input
                    type="number"
                    value={settings.plusIncludedVins}
                    onChange={(e) => setSettings({ ...settings, plusIncludedVins: parseInt(e.target.value) || 0 })}
                    className="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:ring-blue-500 focus:border-blue-500 text-sm"
                  />
                </div>
              </div>
            </div>

            <div className="bg-amber-50 rounded-lg p-4 border border-amber-200">
              <div className="flex items-center justify-between mb-3">
                <span className="font-medium text-gray-900">Detect Dog - Founder - ${settings.detectDogFounderPrice}/month</span>
                <span className="text-xs bg-amber-100 text-amber-700 px-2 py-1 rounded-full">Founder</span>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
                <div>
                  <label className="block text-xs font-medium text-gray-500 mb-1">Product ID</label>
                  <input
                    type="text"
                    value={settings.detectDogFounderProductId}
                    onChange={(e) => setSettings({ ...settings, detectDogFounderProductId: e.target.value })}
                    placeholder="prod_..."
                    className="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:ring-blue-500 focus:border-blue-500 text-sm"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-500 mb-1">Price ID</label>
                  <input
                    type="text"
                    value={settings.detectDogFounderPriceId}
                    onChange={(e) => setSettings({ ...settings, detectDogFounderPriceId: e.target.value })}
                    placeholder="price_..."
                    className="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:ring-blue-500 focus:border-blue-500 text-sm"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-500 mb-1">Price ($)</label>
                  <input
                    type="number"
                    step="0.01"
                    value={settings.detectDogFounderPrice}
                    onChange={(e) => setSettings({ ...settings, detectDogFounderPrice: parseFloat(e.target.value) || 0 })}
                    className="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:ring-blue-500 focus:border-blue-500 text-sm"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-500 mb-1">Included VINs</label>
                  <input
                    type="number"
                    value={settings.detectDogFounderIncludedVins}
                    onChange={(e) => setSettings({ ...settings, detectDogFounderIncludedVins: parseInt(e.target.value) || 0 })}
                    className="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:ring-blue-500 focus:border-blue-500 text-sm"
                  />
                </div>
              </div>
            </div>

            <div className="bg-blue-50 rounded-lg p-4 border border-mos-blue/30">
              <div className="flex items-center justify-between mb-3">
                <span className="font-medium text-gray-900">Elite Easy Button - ${settings.elitePrice}/month</span>
                <span className="text-xs bg-mos-blue/20 text-mos-blue px-2 py-1 rounded-full">All Features</span>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
                <div>
                  <label className="block text-xs font-medium text-gray-500 mb-1">Product ID</label>
                  <input
                    type="text"
                    value={settings.eliteProductId}
                    onChange={(e) => setSettings({ ...settings, eliteProductId: e.target.value })}
                    placeholder="prod_..."
                    className="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:ring-blue-500 focus:border-blue-500 text-sm"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-500 mb-1">Price ID</label>
                  <input
                    type="text"
                    value={settings.elitePriceId}
                    onChange={(e) => setSettings({ ...settings, elitePriceId: e.target.value })}
                    placeholder="price_..."
                    className="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:ring-blue-500 focus:border-blue-500 text-sm"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-500 mb-1">Price ($)</label>
                  <input
                    type="number"
                    step="0.01"
                    value={settings.elitePrice}
                    onChange={(e) => setSettings({ ...settings, elitePrice: parseFloat(e.target.value) || 0 })}
                    className="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:ring-blue-500 focus:border-blue-500 text-sm"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-500 mb-1">Included VINs</label>
                  <input
                    type="number"
                    value={settings.eliteIncludedVins}
                    onChange={(e) => setSettings({ ...settings, eliteIncludedVins: parseInt(e.target.value) || 0 })}
                    className="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:ring-blue-500 focus:border-blue-500 text-sm"
                  />
                </div>
              </div>
            </div>
          </div>
        </div>

        <div className="p-6">
          <div className="flex items-center gap-3 mb-6">
            <div className="w-10 h-10 bg-blue-100 rounded-lg flex items-center justify-center">
              <Gift className="w-5 h-5 text-mos-blue" />
            </div>
            <div>
              <h3 className="text-lg font-semibold text-gray-900">Onboarding & Setup Fee</h3>
              <p className="text-sm text-gray-500">$495 one-time (optional - can be waived for Founding Shops)</p>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Product ID</label>
              <input
                type="text"
                value={settings.onboardingProductId}
                onChange={(e) => setSettings({ ...settings, onboardingProductId: e.target.value })}
                placeholder="prod_..."
                className="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:ring-blue-500 focus:border-blue-500 text-sm"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Price ID</label>
              <input
                type="text"
                value={settings.onboardingPriceId}
                onChange={(e) => setSettings({ ...settings, onboardingPriceId: e.target.value })}
                placeholder="price_..."
                className="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:ring-blue-500 focus:border-blue-500 text-sm"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Price ($)</label>
              <input
                type="number"
                value={settings.onboardingPrice}
                onChange={(e) => setSettings({ ...settings, onboardingPrice: parseInt(e.target.value) || 0 })}
                className="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:ring-blue-500 focus:border-blue-500 text-sm"
              />
            </div>
          </div>
        </div>

        <div className="p-6">
          <div className="flex items-center gap-3 mb-6">
            <div className="w-10 h-10 bg-amber-100 rounded-lg flex items-center justify-center">
              <Gift className="w-5 h-5 text-amber-600" />
            </div>
            <div>
              <h3 className="text-lg font-semibold text-gray-900">Trial Settings</h3>
              <p className="text-sm text-gray-500">Configure free trial length</p>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Trial Period (days)
              </label>
              <input
                type="number"
                value={settings.trialDays}
                onChange={(e) => setSettings({ ...settings, trialDays: parseInt(e.target.value) || 0 })}
                min={0}
                className="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:ring-blue-500 focus:border-blue-500 text-sm"
              />
            </div>
          </div>

          <div className="flex items-center gap-3">
            <input
              type="checkbox"
              id="foundingShopPricing"
              checked={settings.foundingShopPricing}
              onChange={(e) => setSettings({ ...settings, foundingShopPricing: e.target.checked })}
              className="h-4 w-4 text-blue-600 focus:ring-blue-500 border-gray-300 rounded"
            />
            <label htmlFor="foundingShopPricing" className="text-sm font-medium text-gray-700">
              Founding Shop Pricing Active
            </label>
          </div>
        </div>

        <div className="p-6 border-t border-gray-200">
          <div className="flex items-center gap-3 mb-6">
            <div className="w-10 h-10 bg-blue-100 rounded-lg flex items-center justify-center">
              <Mail className="w-5 h-5 text-blue-600" />
            </div>
            <div>
              <h3 className="text-lg font-semibold text-gray-900">Trial Reminder Emails</h3>
              <p className="text-sm text-gray-500">
                Configure when the trial cron sends reminders and what they say. Leave a template
                blank to use the built-in default.
              </p>
            </div>
          </div>

          <div className="grid grid-cols-1 gap-4 mb-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Reminder Days Before Trial Ends
              </label>
              <input
                type="text"
                value={reminderDaysInput}
                onChange={(e) => setReminderDaysInput(e.target.value)}
                placeholder="e.g. 14, 7, 3, 1"
                className="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:ring-blue-500 focus:border-blue-500 text-sm font-mono"
              />
              <p className="text-xs text-gray-500 mt-1">
                Comma-separated list of positive whole numbers. Each day-out match triggers exactly
                one reminder email per shop. Default is <code>7, 3, 1</code>.
              </p>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Subject Line
              </label>
              <input
                type="text"
                value={settings.trialReminderSubject}
                onChange={(e) => setSettings({ ...settings, trialReminderSubject: e.target.value })}
                placeholder="Action needed: {{daysLeft}} {{dayWord}} left in your MOS Tools trial"
                className="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:ring-blue-500 focus:border-blue-500 text-sm"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                HTML Body
              </label>
              <textarea
                value={settings.trialReminderHtml}
                onChange={(e) => setSettings({ ...settings, trialReminderHtml: e.target.value })}
                rows={10}
                className="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:ring-blue-500 focus:border-blue-500 text-xs font-mono"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Plain-Text Body
              </label>
              <textarea
                value={settings.trialReminderText}
                onChange={(e) => setSettings({ ...settings, trialReminderText: e.target.value })}
                rows={5}
                className="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:ring-blue-500 focus:border-blue-500 text-xs font-mono"
              />
            </div>
          </div>

          <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
            <p className="text-sm text-blue-900 font-medium mb-2">Available placeholders</p>
            <ul className="text-xs text-blue-800 space-y-1 font-mono">
              <li><code>{"{{shopName}}"}</code> — the shop name</li>
              <li><code>{"{{daysLeft}}"}</code> — number of days until the trial ends</li>
              <li><code>{"{{dayWord}}"}</code> — "day" or "days" (matches daysLeft)</li>
              <li><code>{"{{trialEndsAt}}"}</code> — pretty-printed end date</li>
              <li><code>{"{{addCardUrl}}"}</code> — link to add a payment method</li>
            </ul>
          </div>

          <div className="mt-6 border-t border-gray-200 pt-6">
            <h4 className="text-sm font-semibold text-gray-900 mb-3">
              Preview &amp; Test Send
            </h4>
            <p className="text-xs text-gray-500 mb-4">
              Sample values are substituted into the template so you can verify
              the rendered output before saving. Sending a test will email the
              rendered reminder to your logged-in address.
            </p>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mb-4">
              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1">
                  Sample shop name
                </label>
                <input
                  type="text"
                  value={previewShopName}
                  onChange={(e) => setPreviewShopName(e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:ring-blue-500 focus:border-blue-500 text-sm"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1">
                  Sample days left
                </label>
                <input
                  type="number"
                  min={1}
                  value={previewDaysLeft}
                  onChange={(e) => setPreviewDaysLeft(parseInt(e.target.value) || 1)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:ring-blue-500 focus:border-blue-500 text-sm"
                />
              </div>
              <div className="flex items-end gap-2">
                <button
                  type="button"
                  onClick={() => setShowPreview((v) => !v)}
                  className="inline-flex items-center px-3 py-2 border border-gray-300 shadow-sm text-sm font-medium rounded-md text-gray-700 bg-white hover:bg-gray-50"
                >
                  <Eye className="w-4 h-4 mr-2" />
                  {showPreview ? "Hide preview" : "Show preview"}
                </button>
                <button
                  type="button"
                  onClick={handleSendTestEmail}
                  disabled={sendingTest}
                  className="inline-flex items-center px-3 py-2 border border-transparent shadow-sm text-sm font-medium rounded-md text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-50"
                >
                  <Send className="w-4 h-4 mr-2" />
                  {sendingTest ? "Sending..." : "Send test email"}
                </button>
              </div>
            </div>

            {testMessage && (
              <div
                className={`p-3 rounded-md text-sm mb-4 ${
                  testMessage.type === "success"
                    ? "bg-green-50 text-green-800 border border-green-200"
                    : "bg-red-50 text-red-800 border border-red-200"
                }`}
              >
                {testMessage.text}
              </div>
            )}

            {showPreview && (
              <div className="space-y-3">
                <div className="bg-gray-50 border border-gray-200 rounded-md p-3">
                  <div className="text-xs font-semibold text-gray-500 uppercase mb-1">
                    Subject
                  </div>
                  <div className="text-sm text-gray-900 break-words">
                    {renderedPreview.subject || (
                      <span className="text-gray-400 italic">(empty)</span>
                    )}
                  </div>
                </div>

                <div className="border border-gray-200 rounded-md overflow-hidden">
                  <div className="bg-gray-50 px-3 py-2 border-b border-gray-200">
                    <span className="text-xs font-semibold text-gray-500 uppercase">
                      HTML preview
                    </span>
                  </div>
                  <iframe
                    title="Trial reminder HTML preview"
                    srcDoc={renderedPreview.html}
                    sandbox=""
                    className="w-full bg-white"
                    style={{ height: 480, border: 0 }}
                  />
                </div>

                <div className="bg-gray-50 border border-gray-200 rounded-md p-3">
                  <div className="text-xs font-semibold text-gray-500 uppercase mb-1">
                    Plain-text version
                  </div>
                  <pre className="text-xs text-gray-800 whitespace-pre-wrap font-mono">
                    {renderedPreview.text || "(empty)"}
                  </pre>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="flex items-center gap-4">
        <button
          onClick={handleSave}
          disabled={saving}
          className="inline-flex items-center px-4 py-2 border border-transparent shadow-sm text-sm font-medium rounded-lg text-white bg-blue-600 hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 disabled:opacity-50"
        >
          <Save className="w-4 h-4 mr-2" />
          {saving ? "Saving..." : "Save Settings"}
        </button>

        <button
          onClick={handleSyncFromStripe}
          disabled={syncing}
          className="inline-flex items-center px-4 py-2 border border-gray-300 shadow-sm text-sm font-medium rounded-lg text-gray-700 bg-white hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 disabled:opacity-50"
        >
          <RefreshCw className={`w-4 h-4 mr-2 ${syncing ? "animate-spin" : ""}`} />
          {syncing ? "Syncing..." : "Fetch from Stripe"}
        </button>
      </div>

      {stripeData && (
        <div className="bg-white shadow rounded-lg overflow-hidden">
          <div className="p-6 border-b border-gray-200">
            <h3 className="text-lg font-semibold text-gray-900">Stripe Products & Prices</h3>
            <p className="text-sm text-gray-500 mt-1">Click any ID to copy it, then paste into the fields above</p>
          </div>

          {stripeData.products.length > 0 && (
            <div className="p-6 border-b border-gray-200">
              <h4 className="text-sm font-semibold text-gray-700 uppercase tracking-wide mb-4">Products</h4>
              <div className="space-y-2">
                {stripeData.products.map((product) => (
                  <div key={product.id} className="flex items-center justify-between p-3 bg-gray-50 rounded-lg">
                    <div>
                      <span className="font-medium text-gray-900">{product.name}</span>
                      {product.description && (
                        <span className="text-gray-500 text-sm ml-2">- {product.description}</span>
                      )}
                      {Object.keys(product.metadata).length > 0 && (
                        <div className="text-xs text-gray-400 mt-1">
                          {Object.entries(product.metadata).map(([k, v]) => `${k}: ${v}`).join(", ")}
                        </div>
                      )}
                    </div>
                    <button
                      onClick={() => copyToClipboard(product.id)}
                      className="inline-flex items-center gap-1 px-2 py-1 text-xs font-mono bg-gray-100 hover:bg-gray-200 rounded text-gray-600"
                    >
                      {copiedId === product.id ? <Check className="w-3 h-3 text-green-600" /> : <Copy className="w-3 h-3" />}
                      {product.id}
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {stripeData.prices.length > 0 && (
            <div className="p-6">
              <h4 className="text-sm font-semibold text-gray-700 uppercase tracking-wide mb-4">Prices</h4>
              <div className="overflow-x-auto">
                <table className="min-w-full divide-y divide-gray-200">
                  <thead className="bg-gray-50">
                    <tr>
                      <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Product</th>
                      <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Price ID</th>
                      <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Amount</th>
                      <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Type</th>
                      <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Metadata</th>
                    </tr>
                  </thead>
                  <tbody className="bg-white divide-y divide-gray-200">
                    {stripeData.prices.map((price) => (
                      <tr key={price.id} className="hover:bg-gray-50">
                        <td className="px-4 py-3 text-sm text-gray-900">
                          {price.productName || price.productId}
                        </td>
                        <td className="px-4 py-3">
                          <button
                            onClick={() => copyToClipboard(price.id)}
                            className="inline-flex items-center gap-1 px-2 py-1 text-xs font-mono bg-gray-100 hover:bg-gray-200 rounded text-gray-600"
                          >
                            {copiedId === price.id ? <Check className="w-3 h-3 text-green-600" /> : <Copy className="w-3 h-3" />}
                            {price.id}
                          </button>
                        </td>
                        <td className="px-4 py-3 text-sm font-medium text-gray-900">
                          {formatPrice(price.unitAmount, price.currency)}
                        </td>
                        <td className="px-4 py-3 text-sm text-gray-600">
                          {price.recurring ? `${price.recurring.interval}ly` : "One-time"}
                        </td>
                        <td className="px-4 py-3 text-xs text-gray-500">
                          {Object.keys(price.metadata).length > 0 
                            ? Object.entries(price.metadata).map(([k, v]) => `${k}: ${v}`).join(", ")
                            : "-"
                          }
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      )}

      <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
        <h4 className="font-semibold text-blue-900 mb-2">Stripe Setup Checklist</h4>
        <ul className="text-sm text-blue-800 space-y-1">
          <li>1. Create products in Stripe Dashboard with the correct names</li>
          <li>2. Add metadata: <code className="bg-blue-100 px-1 rounded">plan_type: pro</code>, <code className="bg-blue-100 px-1 rounded">founding_plan: true</code></li>
          <li>3. Click "Fetch from Stripe" above to pull in your products</li>
          <li>4. Copy product and price IDs into the fields, then Save</li>
        </ul>
      </div>
    </div>
  );
}
