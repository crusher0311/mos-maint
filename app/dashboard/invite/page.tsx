"use client";

import { useEffect, useState } from "react";
import { CheckCircle, Copy, Mail, AlertCircle } from "lucide-react";

type Me = { ok: true; email: string; role: string; shopId: number };

export default function InvitePage() {
  const [me, setMe] = useState<Me | null>(null);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("user");
  const [days, setDays] = useState(7);
  const [inviteUrl, setInviteUrl] = useState("");
  const [invitedEmail, setInvitedEmail] = useState("");
  const [emailSent, setEmailSent] = useState(false);
  const [msg, setMsg] = useState("");
  const [copied, setCopied] = useState(false);
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
    setEmailSent(false);
    setInvitedEmail("");
    setCopied(false);
    try {
      const res = await fetch("/api/auth/invite", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, role, days }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || "Failed");
      setInviteUrl(data.setupUrl);
      setEmailSent(data.emailSent);
      setInvitedEmail(data.email);
    } catch (e: any) {
      setMsg(e?.message || "Error");
    } finally {
      setBusy(false);
    }
  }

  function copy() {
    if (!inviteUrl) return;
    navigator.clipboard.writeText(inviteUrl).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
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
            className="rounded bg-blue-600 text-white px-4 py-2 hover:bg-blue-700 disabled:opacity-50"
            disabled={busy}
          >
            {busy ? "Sending..." : "Create invite"}
          </button>
        </div>
      </form>

      {inviteUrl && (
        <div className="space-y-3">
          {emailSent ? (
            <div className="bg-green-50 border border-green-200 rounded-lg p-3 flex items-center gap-2">
              <Mail className="w-5 h-5 text-green-600" />
              <div className="text-sm text-green-800">
                <span className="font-medium">Invite email sent to {invitedEmail}</span>
              </div>
            </div>
          ) : (
            <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-3 flex items-center gap-2">
              <AlertCircle className="w-5 h-5 text-yellow-600" />
              <div className="text-sm text-yellow-800">
                Email could not be sent. Share the link manually.
              </div>
            </div>
          )}
          
          <div className="bg-gray-50 border border-gray-200 rounded-lg p-3 space-y-2">
            <p className="text-xs text-gray-500">Backup: Copy and share this link manually</p>
            <div className="flex gap-2">
              <input 
                className="flex-1 border rounded p-2 text-sm bg-white" 
                value={inviteUrl} 
                readOnly 
              />
              <button 
                className="rounded bg-gray-200 text-gray-700 px-3 py-2 hover:bg-gray-300 flex items-center gap-1 text-sm"
                onClick={copy}
              >
                {copied ? (
                  <>
                    <CheckCircle className="w-4 h-4 text-green-600" />
                    Copied
                  </>
                ) : (
                  <>
                    <Copy className="w-4 h-4" />
                    Copy
                  </>
                )}
              </button>
            </div>
          </div>
        </div>
      )}

      {msg && <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg p-3">{msg}</div>}
    </main>
  );
}
