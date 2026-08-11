"use client";

import Link from "next/link";
import { useState } from "react";

export default function DashboardHeader() {
  const [busy, setBusy] = useState(false);

  async function onLogout() {
    setBusy(true);
    try {
      const r = await fetch("/api/auth/logout", { method: "POST" });
      const data = await r.json().catch(() => ({}));
      window.location.href = data?.redirect || "/login";
    } finally {
      setBusy(false);
    }
  }

  return (
    <header className="sticky top-0 z-10 bg-white/80 backdrop-blur supports-[backdrop-filter]:bg-white/60 border-b">
      <div className="mx-auto max-w-5xl p-4 flex items-center justify-between">
        <nav className="flex items-center gap-4 text-sm">
          <Link href="/dashboard" className="font-semibold">Dashboard</Link>
          <Link href="/dashboard/invite" className="underline hover:no-underline">Invite</Link>
          <Link href="/forgot" className="underline hover:no-underline">Forgot</Link>
        </nav>
        <button
          onClick={onLogout}
          disabled={busy}
          className="rounded bg-gray-900 text-white px-3 py-1.5 disabled:opacity-50"
          aria-label="Log out"
        >
          {busy ? "Logging out…" : "Log out"}
        </button>
      </div>
    </header>
  );
}

