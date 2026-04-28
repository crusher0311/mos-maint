"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Eye, EyeOff, Lock, LogOut } from "lucide-react";

interface MeResponse {
  authenticated: boolean;
  email?: string;
  mustChangePassword?: boolean;
}

export default function ChangePasswordForm() {
  const router = useRouter();
  const [email, setEmail] = useState<string>("");
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showCurrent, setShowCurrent] = useState(false);
  const [showNew, setShowNew] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string>("");
  const [loadingMe, setLoadingMe] = useState(true);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/auth/me")
      .then((r) => r.json() as Promise<MeResponse>)
      .then((data) => {
        if (cancelled) return;
        if (!data?.authenticated) {
          router.replace("/login");
          return;
        }
        if (data.email) setEmail(data.email);
        // If the user is here without the flag set, send them to the dashboard.
        if (!data.mustChangePassword) {
          router.replace("/dashboard");
          return;
        }
        setLoadingMe(false);
      })
      .catch(() => {
        if (!cancelled) router.replace("/login");
      });
    return () => {
      cancelled = true;
    };
  }, [router]);

  function clientValidate(): string | null {
    if (!currentPassword) return "Please enter your current password.";
    if (newPassword.length < 12) {
      return "New password must be at least 12 characters long.";
    }
    const classes = [
      /[a-z]/.test(newPassword),
      /[A-Z]/.test(newPassword),
      /[0-9]/.test(newPassword),
      /[^a-zA-Z0-9]/.test(newPassword),
    ].filter(Boolean).length;
    if (classes < 3) {
      return "New password must include at least 3 of: lowercase, uppercase, digits, symbols.";
    }
    if (newPassword === currentPassword) {
      return "New password must be different from your current password.";
    }
    if (newPassword !== confirmPassword) {
      return "New password and confirmation do not match.";
    }
    return null;
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setMsg("");

    const localErr = clientValidate();
    if (localErr) {
      setMsg(localErr);
      return;
    }

    setBusy(true);
    try {
      const res = await fetch("/api/auth/change-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ currentPassword, newPassword }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data?.error || `Request failed (HTTP ${res.status})`);
      }
      router.replace("/dashboard");
    } catch (err: unknown) {
      const message =
        err instanceof Error ? err.message : "Could not change password.";
      setMsg(message);
    } finally {
      setBusy(false);
    }
  }

  async function onLogout() {
    try {
      await fetch("/api/auth/logout", { method: "POST" });
    } catch {
      /* ignore */
    }
    router.replace("/login");
  }

  if (loadingMe) {
    return (
      <div className="text-sm text-gray-500 text-center py-6">Loading…</div>
    );
  }

  return (
    <form onSubmit={onSubmit} className="space-y-5">
      {email && (
        <p className="text-xs text-gray-500">
          Signed in as <span className="font-medium text-gray-700">{email}</span>
        </p>
      )}

      <div>
        <label
          htmlFor="currentPassword"
          className="block text-sm font-medium text-gray-700 mb-1.5"
        >
          Current (temporary) password
        </label>
        <div className="relative">
          <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
            <Lock className="h-5 w-5 text-gray-400" />
          </div>
          <input
            id="currentPassword"
            type={showCurrent ? "text" : "password"}
            className="block w-full pl-10 pr-12 py-2.5 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 text-gray-900 placeholder-gray-400"
            placeholder="The password your admin gave you"
            value={currentPassword}
            onChange={(e) => setCurrentPassword(e.target.value)}
            autoComplete="current-password"
            required
            disabled={busy}
          />
          <button
            type="button"
            onClick={() => setShowCurrent((s) => !s)}
            className="absolute inset-y-0 right-0 pr-3 flex items-center text-gray-400 hover:text-gray-600"
            aria-label={showCurrent ? "Hide password" : "Show password"}
          >
            {showCurrent ? (
              <EyeOff className="h-5 w-5" />
            ) : (
              <Eye className="h-5 w-5" />
            )}
          </button>
        </div>
      </div>

      <div>
        <label
          htmlFor="newPassword"
          className="block text-sm font-medium text-gray-700 mb-1.5"
        >
          New password
        </label>
        <div className="relative">
          <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
            <Lock className="h-5 w-5 text-gray-400" />
          </div>
          <input
            id="newPassword"
            type={showNew ? "text" : "password"}
            className="block w-full pl-10 pr-12 py-2.5 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 text-gray-900 placeholder-gray-400"
            placeholder="At least 12 characters"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            autoComplete="new-password"
            required
            disabled={busy}
          />
          <button
            type="button"
            onClick={() => setShowNew((s) => !s)}
            className="absolute inset-y-0 right-0 pr-3 flex items-center text-gray-400 hover:text-gray-600"
            aria-label={showNew ? "Hide password" : "Show password"}
          >
            {showNew ? (
              <EyeOff className="h-5 w-5" />
            ) : (
              <Eye className="h-5 w-5" />
            )}
          </button>
        </div>
        <p className="mt-1 text-xs text-gray-500">
          Use at least 12 characters and mix of upper/lowercase, numbers, or
          symbols.
        </p>
      </div>

      <div>
        <label
          htmlFor="confirmPassword"
          className="block text-sm font-medium text-gray-700 mb-1.5"
        >
          Confirm new password
        </label>
        <div className="relative">
          <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
            <Lock className="h-5 w-5 text-gray-400" />
          </div>
          <input
            id="confirmPassword"
            type={showNew ? "text" : "password"}
            className="block w-full pl-10 pr-4 py-2.5 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 text-gray-900 placeholder-gray-400"
            placeholder="Re-enter your new password"
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            autoComplete="new-password"
            required
            disabled={busy}
          />
        </div>
      </div>

      {msg && (
        <div className="p-3 rounded-lg bg-red-50 border border-red-200">
          <p className="text-sm text-red-600">{msg}</p>
        </div>
      )}

      <button
        type="submit"
        disabled={busy || !currentPassword || !newPassword || !confirmPassword}
        className="w-full py-2.5 px-4 bg-blue-600 hover:bg-blue-700 disabled:bg-blue-400 disabled:cursor-not-allowed text-white font-medium rounded-lg transition-colors focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2"
      >
        {busy ? "Saving…" : "Set new password"}
      </button>

      <button
        type="button"
        onClick={onLogout}
        className="w-full inline-flex items-center justify-center gap-2 text-sm text-gray-500 hover:text-gray-700"
      >
        <LogOut className="h-4 w-4" />
        Sign out
      </button>
    </form>
  );
}
