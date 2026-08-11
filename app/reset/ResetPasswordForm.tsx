// app/reset/page.tsx
"use client";

import { useSearchParams, useRouter } from "next/navigation";
import { useState } from "react";

export default function ResetPasswordPage() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const token = searchParams.get("token");

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string>("");

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;

    if (!token) {
      setMsg(
        "❌ This page is missing a reset token. Please use the reset link from your email, or request a new one from the login page."
      );
      return;
    }

    setBusy(true);
    setMsg("");

    try {
      const res = await fetch("/api/auth/reset", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: email.trim().toLowerCase(),
          password,
          token,
        }),
      });

      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        throw new Error(data?.error || `HTTP ${res.status}`);
      }

      setMsg("✅ Password reset successful. Redirecting to login…");
      setTimeout(() => router.replace("/login"), 1500);
    } catch (err: any) {
      setMsg("❌ " + (err?.message || "Reset failed"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="mx-auto max-w-md p-6 space-y-6">
      <h1 className="text-2xl font-bold">Reset Password</h1>

      {!token && (
        <div className="text-sm rounded border border-amber-300 bg-amber-50 p-3 text-amber-800">
          This page is missing a reset token. Please open the reset link from
          your email — or request a new link from the login page.
        </div>
      )}

      <form onSubmit={onSubmit} className="space-y-4">
        <div>
          <label className="block text-sm font-medium">Email</label>
          <input
            type="email"
            className="mt-1 w-full border rounded p-2"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            disabled={busy}
          />
        </div>

        <div>
          <label className="block text-sm font-medium">New Password</label>
          <input
            type="password"
            className="mt-1 w-full border rounded p-2"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            disabled={busy}
          />
        </div>

        <button
          type="submit"
          disabled={busy}
          className="rounded bg-black text-white px-4 py-2 disabled:opacity-50"
        >
          {busy ? "Resetting…" : "Reset Password"}
        </button>
      </form>

      {msg && <div className="text-sm" aria-live="polite">{msg}</div>}
    </main>
  );
}

