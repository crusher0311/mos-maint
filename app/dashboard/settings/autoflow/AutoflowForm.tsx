"use client";

import { useState, useTransition } from "react";
import { Copy, Check } from "lucide-react";

type Props = {
  shopId: number;
  initial: { 
    autoflowDomain: string; 
    autoflowApiKey: string; 
    autoflowApiPassword?: string;
    webhookToken?: string;
  };
};

export default function AutoflowForm({ shopId, initial }: Props) {
  const [autoflowDomain, setAutoflowDomain] = useState(initial.autoflowDomain || "");
  const [autoflowApiKey, setAutoflowApiKey] = useState(initial.autoflowApiKey || "");
  const [autoflowApiPassword, setAutoflowApiPassword] = useState(initial.autoflowApiPassword || "");
  const [msg, setMsg] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const [copied, setCopied] = useState(false);

  const webhookUrl = initial.webhookToken 
    ? `https://mos.tools/api/webhooks/autoflow/${initial.webhookToken}`
    : null;

  const copyWebhookUrl = async () => {
    if (webhookUrl) {
      await navigator.clipboard.writeText(webhookUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setMsg(null);
    startTransition(async () => {
      const res = await fetch("/api/settings/autoflow", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ shopId, autoflowDomain, autoflowApiKey, autoflowApiPassword }),
      });
      let data: any = {};
      try { data = await res.json(); } catch {}
      setMsg(res.ok ? "Saved!" : (data?.error ?? "Save failed"));
    });
  };

  return (
    <form onSubmit={onSubmit} className="max-w-lg space-y-4">
      <div>
        <label className="block text-sm font-medium mb-1">Autoflow Domain</label>
        <input
          className="w-full border rounded px-3 py-2"
          value={autoflowDomain}
          onChange={(e) => setAutoflowDomain(e.target.value)}
          placeholder="carexpertsok.autotext.me"
        />
      </div>

      <div>
        <label className="block text-sm font-medium mb-1">Autoflow API Key</label>
        <input
          className="w-full border rounded px-3 py-2"
          value={autoflowApiKey}
          onChange={(e) => setAutoflowApiKey(e.target.value)}
          placeholder="Your API key"
          autoComplete="off"
        />
      </div>

      <div>
        <label className="block text-sm font-medium mb-1">Autoflow API Password</label>
        <input
          type="password"
          className="w-full border rounded px-3 py-2"
          value={autoflowApiPassword}
          onChange={(e) => setAutoflowApiPassword(e.target.value)}
          placeholder="Your API password"
          autoComplete="new-password"
        />
        <p className="text-xs text-neutral-600 mt-1">
          Used for Basic auth: base64(api_key:api_password)
        </p>
      </div>

      <button
        type="submit"
        disabled={isPending}
        className="rounded bg-black text-white px-4 py-2 disabled:opacity-50"
      >
        {isPending ? "Saving..." : "Save"}
      </button>

      {msg && <p className="text-sm">{msg}</p>}

      {webhookUrl && (
        <div className="mt-8 pt-6 border-t">
          <h3 className="text-lg font-medium mb-2">Webhook URL</h3>
          <p className="text-sm text-neutral-600 mb-3">
            Copy this URL and paste it into your AutoFlow webhook settings to receive real-time updates.
          </p>
          <div className="flex items-center gap-2">
            <input
              type="text"
              readOnly
              value={webhookUrl}
              className="flex-1 border rounded px-3 py-2 bg-neutral-50 text-sm font-mono"
            />
            <button
              type="button"
              onClick={copyWebhookUrl}
              className="flex items-center gap-1 px-3 py-2 border rounded hover:bg-neutral-100 transition-colors"
            >
              {copied ? <Check className="w-4 h-4 text-green-600" /> : <Copy className="w-4 h-4" />}
              {copied ? "Copied!" : "Copy"}
            </button>
          </div>
          <p className="text-xs text-neutral-500 mt-2">
            Enable all event types in AutoFlow: Status Update, DVI Signoff, Work Order Signoff, etc.
          </p>
        </div>
      )}
    </form>
  );
}
