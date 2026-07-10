"use client";

import { useEffect, useState } from "react";
import { Loader2, Building, CheckCircle2, Clock, AlertTriangle } from "lucide-react";

interface ShopInfo {
  shopName: string;
  locationIdentifier: string | null;
  mode: "instant" | "approval";
}

export default function JoinForm({ code }: { code: string }) {
  const [info, setInfo] = useState<ShopInfo | null>(null);
  const [infoError, setInfoError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [done, setDone] = useState<"pending" | "instant" | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch(`/api/join/${encodeURIComponent(code)}`);
        const data = await res.json().catch(() => null);
        if (res.ok && data?.ok) {
          setInfo(data);
        } else {
          setInfoError(data?.error || "This enrollment link is invalid or no longer active.");
        }
      } catch {
        setInfoError("Something went wrong. Please try again.");
      } finally {
        setLoading(false);
      }
    })();
  }, [code]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitError(null);
    setSubmitting(true);
    try {
      const res = await fetch(`/api/join/${encodeURIComponent(code)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, email, password }),
      });
      const data = await res.json().catch(() => null);
      if (res.ok && data?.ok) {
        if (data.pending) {
          setDone("pending");
        } else {
          setDone("instant");
          window.location.href = data.redirect || "/dashboard";
        }
      } else {
        setSubmitError(data?.error || "Signup failed. Please try again.");
      }
    } catch {
      setSubmitError("Something went wrong. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  const shopDisplay = info
    ? info.locationIdentifier
      ? `${info.shopName} (${info.locationIdentifier})`
      : info.shopName
    : "";

  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl shadow-lg border border-gray-200 w-full max-w-md p-8">
        {loading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="w-8 h-8 animate-spin text-blue-600" />
          </div>
        ) : infoError ? (
          <div className="text-center py-8">
            <AlertTriangle className="w-10 h-10 text-amber-500 mx-auto mb-4" />
            <h1 className="text-xl font-bold text-gray-900 mb-2">Link not active</h1>
            <p className="text-sm text-gray-600">{infoError}</p>
          </div>
        ) : done === "pending" ? (
          <div className="text-center py-8">
            <Clock className="w-10 h-10 text-blue-600 mx-auto mb-4" />
            <h1 className="text-xl font-bold text-gray-900 mb-2">Waiting for approval</h1>
            <p className="text-sm text-gray-600">
              Your request to join <b>{shopDisplay}</b> has been submitted. A shop admin needs to
              approve it before you can log in. You&apos;ll receive an email once you&apos;re approved.
            </p>
          </div>
        ) : done === "instant" ? (
          <div className="text-center py-8">
            <CheckCircle2 className="w-10 h-10 text-green-600 mx-auto mb-4" />
            <h1 className="text-xl font-bold text-gray-900 mb-2">You&apos;re in!</h1>
            <p className="text-sm text-gray-600">Taking you to the dashboard…</p>
          </div>
        ) : (
          <>
            <div className="text-center mb-6">
              <div className="w-12 h-12 rounded-xl bg-blue-100 flex items-center justify-center mx-auto mb-3">
                <Building className="w-6 h-6 text-blue-600" />
              </div>
              <h1 className="text-xl font-bold text-gray-900">Join {shopDisplay}</h1>
              <p className="text-sm text-gray-500 mt-1">
                Create your account to join this shop&apos;s team
                {info?.mode === "approval" ? " — an admin will approve your request" : ""}.
              </p>
            </div>

            <form onSubmit={handleSubmit} className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Full name</label>
                <input
                  type="text"
                  required
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                  placeholder="Jane Mechanic"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Email</label>
                <input
                  type="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                  placeholder="you@example.com"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Password</label>
                <input
                  type="password"
                  required
                  minLength={8}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                  placeholder="At least 8 characters"
                />
              </div>

              {submitError && (
                <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg p-3">
                  {submitError}
                </div>
              )}

              <button
                type="submit"
                disabled={submitting}
                className="w-full py-2.5 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors disabled:opacity-50 flex items-center justify-center gap-2 font-medium"
              >
                {submitting && <Loader2 className="w-4 h-4 animate-spin" />}
                Create Account
              </button>
            </form>
          </>
        )}
      </div>
    </div>
  );
}
