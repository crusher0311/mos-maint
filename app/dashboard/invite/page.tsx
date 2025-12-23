"use client";

import { useEffect, useState } from "react";

type Me = { ok: true; email: string; role: string; shopId: number };

export default function InvitePage() {
  const [me, setMe] = useState<Me | null>(null);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("user");
  const [days, setDays] = useState(7);
  const [inviteUrl, setInviteUrl] = useState("");
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    fetch("/api/auth/me")
      .then(r => r.json())
      .then(d => (d.ok ? setMe(d) : setMsg("Not signed in")))
      .catch(() => setMsg("Not signed in"));
  }, []);

  async function createInvite(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMsg("");
    setInviteUrl("");
    try {
      const res = await fetch("/api/auth/invite", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, role, days }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || "Failed");
      setInviteUrl(data.setupUrl);
      setMsg("âœ… Invite created");
    } catch (e: any) {
      setMsg("âŒ " + (e?.message || "Error"));
    } finally {
      setBusy(false);
    }
  }

  function copy() {
    if (!inviteUrl) return;
    navigator.clipboard.writeText(inviteUrl).then(() => setMsg("Link copied"));
  }

  if (!me) {
    return (
      <main className="mx-auto max-w-xl p-6">
        <h1 className="text-2xl font-bold">Invite User</h1>
        <p className="text-sm text-gray-600">{msg || "Loading..."}</p>
      </main>
    );
  }

  if (me.role !== "owner" && me.role !== "admin") {
    return (
      <main className="mx-auto max-w-xl p-6">
        <h1 className="text-2xl font-bold">Invite User</h1>
        <p className="text-sm">Only owners and admins can invite users.</p>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-xl p-6 space-y-6">
      <h1 className="text-2xl font-bold">Invite User</h1>
      <p className="text-sm text-gray-600">Shop ID: <code>{me.shopId}</code></p>

      <form onSubmit={createInvite} className="space-y-3">
        <input
          type="email"
          className="w-full border rounded p-2"
          placeholder="user@example.com"
          value={email}
          onChange={e => setEmail(e.target.value)}
          required
        />
        <div className="flex gap-2">
          <select
            className="border rounded p-2"
            value={role}
            onChange={e => setRole(e.target.value)}
          >
            <option value="user">User</option>
            <option value="manager">Manager</option>
            <option value="owner">Owner</option>
          </select>
          <input
            type="number"
            className="border rounded p-2 w-24"
            min={1}
            max={30}
            value={days}
            onChange={e => setDays(Number(e.target.value))}
            title="Days until link expires"
          />
          <button
            type="submit"
            className="rounded bg-black text-white px-4 py-2 disabled:opacity-50"
            disabled={busy}
          >
            {busy ? "Creating..." : "Create invite"}
          </button>
        </div>
      </form>

      {inviteUrl && (
        <div className="space-y-2">
          <input className="w-full border rounded p-2" value={inviteUrl} readOnly />
          <button className="rounded bg-black text-white px-4 py-2" onClick={copy}>
            Copy Link
          </button>
        </div>
      )}

      {msg && <div className="text-sm whitespace-pre-wrap">{msg}</div>}
    </main>
  );
}

