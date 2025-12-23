"use client";
import { useState } from "react";

export default function InviteForm() {
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("user");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMsg("");
    try {
      const res = await fetch("/api/auth/invite", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, role }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || "Invite failed");
      try { await navigator.clipboard.writeText(data.inviteUrl); } catch {}
      setMsg(`âœ… Invite created. Link copied:\n${data.inviteUrl}`);
      setEmail("");
    } catch (err: any) {
      setMsg("âŒ " + (err?.message || String(err)));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="border rounded p-4 space-y-2">
      <h2 className="text-lg font-semibold">Invite a user</h2>
      <form onSubmit={onSubmit} className="flex flex-wrap gap-2 items-center">
        <input
          type="email"
          className="border rounded p-2 flex-1 min-w-[240px]"
          placeholder="person@example.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
        />
        <select
          className="border rounded p-2"
          value={role}
          onChange={(e) => setRole(e.target.value)}
        >
          <option value="user">User</option>
          <option value="manager">Manager</option>
        </select>
        <button
          className="rounded bg-black text-white px-4 py-2 disabled:opacity-50"
          disabled={busy || !email}
        >
          {busy ? "Creatingâ€¦" : "Create Invite"}
        </button>
      </form>
      {msg && <pre className="text-xs whitespace-pre-wrap">{msg}</pre>}
    </section>
  );
}

