"use client";

import { useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";

export default function ResetForm() {
  const sp = useSearchParams();
  const token = sp.get("token") || "";

  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");

  useEffect(() => {
    if (!token) setMsg("Missing token.");
  }, [token]);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMsg("");
    try {
      const res = await fetch("/api/auth/reset", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, password }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || "Reset failed");
      setMsg("✅ Password updated. You are signed in.");
      // window.location.href = data.redirect || "/dashboard";
    } catch (e: any) {
      setMsg("❌ " + (e?.message || "Error"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="space-y-3">
      <input
        type="password"
        className="w-full border rounded p-2"
        placeholder="New password (min 8 chars)"
        minLength={8}
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        required
      />
      <button
        className="rounded bg-black text-white px-4 py-2 disabled:opacity-50"
        disabled={busy || !token || !password}
      >
        {busy ? "Saving…" : "Reset Password"}
      </button>
      {msg && <div className="text-sm whitespace-pre-wrap">{msg}</div>}
    </form>
  );
}

