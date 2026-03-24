"use client";

import { useState, useEffect, useCallback } from "react";
import { Plus, Search, X, Mail, MessageSquare, Bell, FileText } from "lucide-react";

interface Template {
  id: string;
  name: string;
  channel: string;
  subject: string | null;
  body: string;
  category: string | null;
  variables: string[];
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export default function MessageTemplatesPage() {
  const [templates, setTemplates] = useState<Template[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState("");
  const [channelFilter, setChannelFilter] = useState("");
  const [editing, setEditing] = useState<Partial<Template> | null>(null);
  const [isNew, setIsNew] = useState(false);

  const loadTemplates = useCallback(async () => {
    try {
      const params = new URLSearchParams();
      if (searchTerm) params.set("search", searchTerm);
      if (channelFilter) params.set("channel", channelFilter);
      const res = await fetch(`/api/platform-admin/message-templates?${params}`);
      const data = await res.json();
      if (data.ok) setTemplates(data.templates);
    } catch (e) {
      console.error("Error loading templates:", e);
    } finally {
      setLoading(false);
    }
  }, [searchTerm, channelFilter]);

  useEffect(() => { loadTemplates(); }, [loadTemplates]);

  const saveTemplate = async () => {
    if (!editing?.name || !editing?.body) return;
    try {
      const method = isNew ? "POST" : "PUT";
      const res = await fetch("/api/platform-admin/message-templates", {
        method, headers: { "Content-Type": "application/json" },
        body: JSON.stringify(editing),
      });
      const data = await res.json();
      if (data.ok) {
        if (isNew) setTemplates([...templates, data.template]);
        else setTemplates(templates.map(t => t.id === data.template.id ? data.template : t));
        setEditing(null); setIsNew(false);
      }
    } catch (e) {
      console.error("Error saving template:", e);
    }
  };

  const deleteTemplate = async (id: string) => {
    if (!confirm("Archive this template?")) return;
    try {
      await fetch(`/api/platform-admin/message-templates?id=${id}`, { method: "DELETE" });
      setTemplates(templates.filter(t => t.id !== id));
    } catch (e) {
      console.error("Error deleting template:", e);
    }
  };

  const channelIcons: Record<string, any> = { email: Mail, sms: MessageSquare, push: Bell };
  const channelColors: Record<string, string> = {
    email: "bg-blue-100 text-blue-700",
    sms: "bg-green-100 text-green-700",
    push: "bg-purple-100 text-purple-700",
  };

  return (
    <>
    <div className="flex-1 overflow-y-auto">
        <header className="bg-white border-b px-4 md:px-6 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div>
                <h1 className="text-xl md:text-2xl font-bold text-gray-900">Message Templates</h1>
                <p className="text-sm text-gray-500">{templates.length} templates</p>
              </div>
            </div>
            <button onClick={() => { setEditing({ name: "", channel: "email", subject: "", body: "", category: "", isActive: true }); setIsNew(true); }}
              className="flex items-center gap-2 px-4 py-2 bg-[#3c81c3] text-white rounded-lg hover:bg-[#2d6da8] text-sm">
              <Plus className="w-4 h-4" /> New Template
            </button>
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            <div className="relative flex-1 min-w-[200px]">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
              <input type="text" placeholder="Search templates..." value={searchTerm} onChange={e => setSearchTerm(e.target.value)}
                className="w-full pl-9 pr-4 py-2 border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#3c81c3]/30" />
            </div>
            <select value={channelFilter} onChange={e => setChannelFilter(e.target.value)}
              className="px-3 py-2 border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#3c81c3]/30">
              <option value="">All Channels</option>
              <option value="email">Email</option>
              <option value="sms">SMS</option>
              <option value="push">Push</option>
            </select>
          </div>
        </header>

        <div className="p-4 md:p-6">
          {loading ? (
            <div className="flex items-center justify-center h-64"><div className="animate-spin w-8 h-8 border-4 border-[#3c81c3] border-t-transparent rounded-full" /></div>
          ) : (
            <div className="space-y-3">
              {templates.map(template => {
                const Icon = channelIcons[template.channel] || FileText;
                return (
                  <div key={template.id} className="bg-white rounded-xl border p-4 hover:shadow-sm transition-shadow">
                    <div className="flex items-start justify-between">
                      <div className="flex items-start gap-3">
                        <div className="w-10 h-10 rounded-lg bg-[#3c81c3]/10 flex items-center justify-center">
                          <Icon className="w-5 h-5 text-[#3c81c3]" />
                        </div>
                        <div>
                          <div className="flex items-center gap-2">
                            <h3 className="font-medium text-gray-900">{template.name}</h3>
                            <span className={`text-xs px-2 py-0.5 rounded-full ${channelColors[template.channel] || "bg-gray-100 text-gray-700"}`}>{template.channel}</span>
                            {template.category && <span className="text-xs px-2 py-0.5 rounded-full bg-gray-100 text-gray-700">{template.category}</span>}
                            {!template.isActive && <span className="text-xs px-2 py-0.5 rounded-full bg-red-100 text-red-700">Inactive</span>}
                          </div>
                          {template.subject && <p className="text-sm text-gray-500 mt-0.5">Subject: {template.subject}</p>}
                          <p className="text-sm text-gray-400 mt-1 line-clamp-2">{template.body}</p>
                          {template.variables && template.variables.length > 0 && (
                            <div className="flex gap-1 mt-2 flex-wrap">
                              {template.variables.map((v, i) => (
                                <span key={i} className="text-xs bg-gray-50 text-gray-600 px-2 py-0.5 rounded border font-mono">{`{{${v}}}`}</span>
                              ))}
                            </div>
                          )}
                        </div>
                      </div>
                      <div className="flex items-center gap-1">
                        <button onClick={() => { setEditing(template); setIsNew(false); }} className="p-2 hover:bg-gray-100 rounded-lg text-xs text-gray-500">Edit</button>
                        <button onClick={() => deleteTemplate(template.id)} className="p-2 hover:bg-red-50 rounded-lg text-xs text-red-500">Archive</button>
                      </div>
                    </div>
                  </div>
                );
              })}
              {templates.length === 0 && (
                <div className="text-center py-12 text-gray-500">
                  <p className="text-lg font-medium">No templates yet</p>
                  <p className="text-sm mt-1">Create reusable message templates for Email, SMS, and Push notifications.</p>
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {editing && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-lg mx-4 p-6 max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-bold">{isNew ? "New Template" : "Edit Template"}</h2>
              <button onClick={() => { setEditing(null); setIsNew(false); }} className="p-1 hover:bg-gray-100 rounded"><X className="w-5 h-5" /></button>
            </div>
            <div className="space-y-3">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Name *</label>
                <input type="text" value={editing.name || ""} onChange={e => setEditing({ ...editing, name: e.target.value })}
                  className="w-full px-3 py-2 border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#3c81c3]/30" />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Channel</label>
                  <select value={editing.channel || "email"} onChange={e => setEditing({ ...editing, channel: e.target.value })}
                    className="w-full px-3 py-2 border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#3c81c3]/30">
                    <option value="email">Email</option>
                    <option value="sms">SMS</option>
                    <option value="push">Push Notification</option>
                  </select>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Category</label>
                  <input type="text" value={editing.category || ""} onChange={e => setEditing({ ...editing, category: e.target.value })}
                    className="w-full px-3 py-2 border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#3c81c3]/30" placeholder="e.g. welcome, reminder" />
                </div>
              </div>
              {(editing.channel === "email" || !editing.channel) && (
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Subject</label>
                  <input type="text" value={editing.subject || ""} onChange={e => setEditing({ ...editing, subject: e.target.value })}
                    className="w-full px-3 py-2 border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#3c81c3]/30" />
                </div>
              )}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Body * (HTML or plain text)</label>
                <textarea value={editing.body || ""} onChange={e => setEditing({ ...editing, body: e.target.value })} rows={8}
                  className="w-full px-3 py-2 border rounded-lg text-sm font-mono focus:outline-none focus:ring-2 focus:ring-[#3c81c3]/30" />
              </div>
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={editing.isActive ?? true} onChange={e => setEditing({ ...editing, isActive: e.target.checked })} className="rounded" /> Active
              </label>
              <div className="flex gap-2 pt-2">
                <button onClick={() => { setEditing(null); setIsNew(false); }} className="flex-1 px-4 py-2 border rounded-lg text-sm hover:bg-gray-50">Cancel</button>
                <button onClick={saveTemplate} disabled={!editing.name || !editing.body}
                  className="flex-1 px-4 py-2 bg-[#3c81c3] text-white rounded-lg text-sm hover:bg-[#2d6da8] disabled:opacity-50">Save</button>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
