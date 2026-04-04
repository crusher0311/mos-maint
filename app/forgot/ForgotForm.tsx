"use client";

import { useState } from "react";

export default function ForgotForm() {
  const [email, setEmail] = useState("");
  const [shopId, setShopId] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [resetUrl, setResetUrl] = useState("");

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMsg("");
    setResetUrl("");
    try {
      const body: any = { email };
      if (shopId.trim()) body.shopId = Number(shopId.trim());
      const res = await fetch("/api/auth/forgot", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || "Failed");
      setMsg("If the account exists, a reset link has been generated.");
      if (data.resetUrl) setResetUrl(data.resetUrl); // (dev) copy this manually for now
    } catch (e: any) {
      setMsg("âŒ " + (e?.message || "Error"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="space-y-3">
      <input
        type="email"
        className="w-full border rounded p-2"
        placeholder="you@example.com"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        required
      />
      <input
        type="text"
        className="w-full border rounded p-2"
        placeholder="Shop ID (optional)"
        value={shopId}
        onChange={(e) => setShopId(e.target.value)}
        inputMode="numeric"
      />
      <button
        className="rounded bg-black text-white px-4 py-2 disabled:opacity-50"
        disabled={busy || !email}
      >
        {busy ? "Workingâ€¦" : "Send reset link"}
      </button>

      {msg && <div className="text-sm whitespace-pre-wrap">{msg}</div>}
      {resetUrl && process.env.NODE_ENV !== "production" && (
        <div className="space-y-2 text-sm">
          <div>Dev reset URL (copy):</div>
          <input className="w-full border rounded p-2" value={resetUrl} readOnly />
        </div>
      )}
    </form>
  );
}

