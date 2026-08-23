// app/reset/page.tsx
"use client";

import { useSearchParams, useRouter } from "next/navigation";
import { useState } from "react";

export default function ResetPasswordPage() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const token = searchParams?.get("token");

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string>("");
  const [tokenDead, setTokenDead] = useState(false);
  const [resendBusy, setResendBusy] = useState(false);
  const [resendMsg, setResendMsg] = useState<string>("");

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
    setResendMsg("");

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
        const errText = String(data?.error || `HTTP ${res.status}`);
        // Offer a one-click re-send when the token itself is dead.
        if (/invalid or expired token/i.test(errText)) {
          setTokenDead(true);
        }
        throw new Error(errText);
      }

      setTokenDead(false);
      setMsg("✅ Password reset successful. Redirecting to login…");
      setTimeout(() => router.replace("/login"), 1500);
    } catch (err: any) {
      setMsg("❌ " + (err?.message || "Reset failed"));
    } finally {
      setBusy(false);
    }
  }

  async function onResend() {
    if (resendBusy) return;

    const emailLower = email.trim().toLowerCase();
    if (!emailLower) {
      setResendMsg("❌ Enter your email above first, then request a new link.");
      return;
    }

    setResendBusy(true);
    setResendMsg("");

    try {
      const res = await fetch("/api/auth/forgot", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: emailLower }),
      });

      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        throw new Error(data?.error || `HTTP ${res.status}`);
      }

      setResendMsg(
        "✅ " +
          (data?.note ||
            "If the account exists, a new reset link has been sent to your email.")
      );
    } catch (err: any) {
      setResendMsg("❌ " + (err?.message || "Could not request a new link"));
    } finally {
      setResendBusy(false);
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

      {tokenDead && (
        <div className="text-sm rounded border border-amber-300 bg-amber-50 p-3 text-amber-800 space-y-2">
          <p>
            Your reset link is no longer valid. We can email you a fresh one.
          </p>
          <button
            type="button"
            onClick={onResend}
            disabled={resendBusy}
            className="rounded bg-black text-white px-3 py-1.5 disabled:opacity-50"
          >
            {resendBusy ? "Sending…" : "Send me a new link"}
          </button>
          {resendMsg && (
            <div aria-live="polite" className="text-amber-900">
              {resendMsg}
            </div>
          )}
        </div>
      )}
    </main>
  );
}

