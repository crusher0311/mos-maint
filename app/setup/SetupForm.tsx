"use client";

import { useSearchParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";

export default function SetupForm() {
  const sp = useSearchParams();
  const shopId = sp.get("shopId") || "";
  const token = sp.get("token") || "";
  const emailFromLink = useMemo(() => (sp.get("email") || "").toLowerCase(), [sp]);

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string>("");

  useEffect(() => {
    if (!shopId || !token) setMsg("Missing shopId or token in URL.");
    if (emailFromLink) setEmail(emailFromLink);
  }, [shopId, token, emailFromLink]);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!shopId || !token) return;
    setBusy(true);
    setMsg("");
    try {
      const res = await fetch("/api/auth/complete-setup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ shopId: Number(shopId), token, email, password }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || "Setup failed");
      setMsg("Account created! Redirecting...");
      window.location.href = data.redirect || "/dashboard";
    } catch (err: any) {
      setMsg("âŒ " + (err?.message || String(err)));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="space-y-3">
      <p className="text-sm text-gray-700">
        Shop ID: <code>{shopId}</code>
      </p>

      <input
        type="email"
        className="w-full border rounded p-2"
        placeholder="Owner email"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        required
        disabled={!!emailFromLink}
      />
      <input
        type="password"
        className="w-full border rounded p-2"
        placeholder="Password (min 8 chars)"
        minLength={8}
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        required
      />

      <button
        type="submit"
        disabled={busy || !email || !password}
        className="rounded bg-black text-white px-4 py-2 disabled:opacity-50"
      >
        {busy ? "Creating..." : "Create Account"}
      </button>

      {msg && <div className="text-sm whitespace-pre-wrap">{msg}</div>}
      <p className="text-xs text-gray-500">This creates the user and signs them in.</p>
    </form>
  );
}

