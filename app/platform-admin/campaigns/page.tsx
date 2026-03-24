"use client";

import { useState, useEffect, useCallback } from "react";
import { Plus, Search, X, Mail, MessageSquare, Bell, BarChart3, Eye, MousePointer, Send } from "lucide-react";

interface Campaign {
  id: string;
  name: string;
  type: string;
  status: string;
  subject: string | null;
  body: string | null;
  scheduledAt: string | null;
  sentAt: string | null;
  totalRecipients: number;
  delivered: number;
  opened: number;
  clicked: number;
  bounced: number;
  unsubscribed: number;
  notes: string | null;
  createdAt: string;
}

export default function CampaignsPage() {
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [typeFilter, setTypeFilter] = useState("");
  const [editing, setEditing] = useState<Partial<Campaign> | null>(null);
  const [isNew, setIsNew] = useState(false);
  const [selectedCampaign, setSelectedCampaign] = useState<Campaign | null>(null);

  const loadCampaigns = useCallback(async () => {
    try {
      const params = new URLSearchParams();
      if (searchTerm) params.set("search", searchTerm);
      if (statusFilter) params.set("status", statusFilter);
      if (typeFilter) params.set("type", typeFilter);
      const res = await fetch(`/api/platform-admin/campaigns?${params}`);
      const data = await res.json();
      if (data.ok) setCampaigns(data.campaigns);
    } catch (e) {
      console.error("Error loading campaigns:", e);
    } finally {
      setLoading(false);
    }
  }, [searchTerm, statusFilter, typeFilter]);

  useEffect(() => { loadCampaigns(); }, [loadCampaigns]);

  const saveCampaign = async () => {
    if (!editing?.name) return;
    try {
      const method = isNew ? "POST" : "PUT";
      const res = await fetch("/api/platform-admin/campaigns", {
        method, headers: { "Content-Type": "application/json" },
        body: JSON.stringify(editing),
      });
      const data = await res.json();
      if (data.ok) {
        if (isNew) setCampaigns([data.campaign, ...campaigns]);
        else setCampaigns(campaigns.map(c => c.id === data.campaign.id ? data.campaign : c));
        setEditing(null); setIsNew(false);
      }
    } catch (e) {
      console.error("Error saving campaign:", e);
    }
  };

  const deleteCampaign = async (id: string) => {
    if (!confirm("Archive this campaign?")) return;
    try {
      await fetch(`/api/platform-admin/campaigns?id=${id}`, { method: "DELETE" });
      setCampaigns(campaigns.filter(c => c.id !== id));
    } catch (e) {
      console.error("Error deleting campaign:", e);
    }
  };

  const typeIcons: Record<string, any> = { email: Mail, sms: MessageSquare, push: Bell };
  const statusColors: Record<string, string> = {
    draft: "bg-gray-100 text-gray-700",
    scheduled: "bg-blue-100 text-blue-700",
    sending: "bg-yellow-100 text-yellow-700",
    sent: "bg-green-100 text-green-700",
    paused: "bg-orange-100 text-orange-700",
  };

  return (
    <>
    <div className="flex-1 overflow-y-auto">
        <header className="bg-white border-b px-4 md:px-6 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div>
                <h1 className="text-xl md:text-2xl font-bold text-gray-900">Campaigns</h1>
                <p className="text-sm text-gray-500">{campaigns.length} campaigns</p>
              </div>
            </div>
            <button onClick={() => { setEditing({ name: "", type: "email", status: "draft", subject: "", body: "" }); setIsNew(true); }}
              className="flex items-center gap-2 px-4 py-2 bg-[#3c81c3] text-white rounded-lg hover:bg-[#2d6da8] text-sm">
              <Plus className="w-4 h-4" /> New Campaign
            </button>
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            <div className="relative flex-1 min-w-[200px]">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
              <input type="text" placeholder="Search campaigns..." value={searchTerm} onChange={e => setSearchTerm(e.target.value)}
                className="w-full pl-9 pr-4 py-2 border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#3c81c3]/30" />
            </div>
            <select value={statusFilter} onChange={e => setStatusFilter(e.target.value)}
              className="px-3 py-2 border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#3c81c3]/30">
              <option value="">All Statuses</option>
              <option value="draft">Draft</option>
              <option value="scheduled">Scheduled</option>
              <option value="sent">Sent</option>
            </select>
            <select value={typeFilter} onChange={e => setTypeFilter(e.target.value)}
              className="px-3 py-2 border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#3c81c3]/30">
              <option value="">All Types</option>
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
              {campaigns.map(campaign => {
                const Icon = typeIcons[campaign.type] || Mail;
                return (
                  <div key={campaign.id} className="bg-white rounded-xl border p-4 hover:shadow-sm transition-shadow">
                    <div className="flex items-start justify-between">
                      <div className="flex items-start gap-3">
                        <div className="w-10 h-10 rounded-lg bg-[#3c81c3]/10 flex items-center justify-center">
                          <Icon className="w-5 h-5 text-[#3c81c3]" />
                        </div>
                        <div>
                          <div className="flex items-center gap-2">
                            <h3 className="font-medium text-gray-900">{campaign.name}</h3>
                            <span className={`text-xs px-2 py-0.5 rounded-full ${statusColors[campaign.status] || "bg-gray-100 text-gray-700"}`}>{campaign.status}</span>
                          </div>
                          {campaign.subject && <p className="text-sm text-gray-500 mt-0.5">{campaign.subject}</p>}
                          <p className="text-xs text-gray-400 mt-1">Created {new Date(campaign.createdAt).toLocaleDateString()}</p>
                        </div>
                      </div>
                      <div className="flex items-center gap-1">
                        <button onClick={() => setSelectedCampaign(campaign)} className="p-2 hover:bg-gray-100 rounded-lg text-xs text-gray-500"><BarChart3 className="w-4 h-4" /></button>
                        <button onClick={() => { setEditing(campaign); setIsNew(false); }} className="p-2 hover:bg-gray-100 rounded-lg text-xs text-gray-500">Edit</button>
                        <button onClick={() => deleteCampaign(campaign.id)} className="p-2 hover:bg-red-50 rounded-lg text-xs text-red-500">Archive</button>
                      </div>
                    </div>
                    {campaign.status === "sent" && (
                      <div className="mt-3 grid grid-cols-4 gap-3">
                        <div className="text-center"><p className="text-lg font-semibold text-gray-900">{campaign.delivered}</p><p className="text-xs text-gray-500">Delivered</p></div>
                        <div className="text-center"><p className="text-lg font-semibold text-gray-900">{campaign.opened}</p><p className="text-xs text-gray-500">Opened</p></div>
                        <div className="text-center"><p className="text-lg font-semibold text-gray-900">{campaign.clicked}</p><p className="text-xs text-gray-500">Clicked</p></div>
                        <div className="text-center"><p className="text-lg font-semibold text-gray-900">{campaign.bounced}</p><p className="text-xs text-gray-500">Bounced</p></div>
                      </div>
                    )}
                  </div>
                );
              })}
              {campaigns.length === 0 && (
                <div className="text-center py-12 text-gray-500">
                  <p className="text-lg font-medium">No campaigns yet</p>
                  <p className="text-sm mt-1">Create your first campaign to get started.</p>
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
              <h2 className="text-lg font-bold">{isNew ? "New Campaign" : "Edit Campaign"}</h2>
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
                  <label className="block text-sm font-medium text-gray-700 mb-1">Type</label>
                  <select value={editing.type || "email"} onChange={e => setEditing({ ...editing, type: e.target.value })}
                    className="w-full px-3 py-2 border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#3c81c3]/30">
                    <option value="email">Email</option>
                    <option value="sms">SMS</option>
                    <option value="push">Push Notification</option>
                  </select>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Status</label>
                  <select value={editing.status || "draft"} onChange={e => setEditing({ ...editing, status: e.target.value })}
                    className="w-full px-3 py-2 border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#3c81c3]/30">
                    <option value="draft">Draft</option>
                    <option value="scheduled">Scheduled</option>
                    <option value="sent">Sent</option>
                    <option value="paused">Paused</option>
                  </select>
                </div>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Subject</label>
                <input type="text" value={editing.subject || ""} onChange={e => setEditing({ ...editing, subject: e.target.value })}
                  className="w-full px-3 py-2 border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#3c81c3]/30" />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Body</label>
                <textarea value={editing.body || ""} onChange={e => setEditing({ ...editing, body: e.target.value })} rows={6}
                  className="w-full px-3 py-2 border rounded-lg text-sm font-mono focus:outline-none focus:ring-2 focus:ring-[#3c81c3]/30" />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Notes</label>
                <textarea value={editing.notes || ""} onChange={e => setEditing({ ...editing, notes: e.target.value })} rows={2}
                  className="w-full px-3 py-2 border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#3c81c3]/30" />
              </div>
              <div className="flex gap-2 pt-2">
                <button onClick={() => { setEditing(null); setIsNew(false); }} className="flex-1 px-4 py-2 border rounded-lg text-sm hover:bg-gray-50">Cancel</button>
                <button onClick={saveCampaign} disabled={!editing.name}
                  className="flex-1 px-4 py-2 bg-[#3c81c3] text-white rounded-lg text-sm hover:bg-[#2d6da8] disabled:opacity-50">Save</button>
              </div>
            </div>
          </div>
        </div>
      )}

      {selectedCampaign && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-lg mx-4 p-6">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-bold">{selectedCampaign.name} - Metrics</h2>
              <button onClick={() => setSelectedCampaign(null)} className="p-1 hover:bg-gray-100 rounded"><X className="w-5 h-5" /></button>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="bg-gray-50 rounded-lg p-4 text-center">
                <Send className="w-5 h-5 mx-auto text-blue-500 mb-1" />
                <p className="text-2xl font-bold">{selectedCampaign.totalRecipients}</p>
                <p className="text-sm text-gray-500">Total Recipients</p>
              </div>
              <div className="bg-gray-50 rounded-lg p-4 text-center">
                <Mail className="w-5 h-5 mx-auto text-green-500 mb-1" />
                <p className="text-2xl font-bold">{selectedCampaign.delivered}</p>
                <p className="text-sm text-gray-500">Delivered</p>
              </div>
              <div className="bg-gray-50 rounded-lg p-4 text-center">
                <Eye className="w-5 h-5 mx-auto text-purple-500 mb-1" />
                <p className="text-2xl font-bold">{selectedCampaign.opened}</p>
                <p className="text-sm text-gray-500">Opened</p>
              </div>
              <div className="bg-gray-50 rounded-lg p-4 text-center">
                <MousePointer className="w-5 h-5 mx-auto text-orange-500 mb-1" />
                <p className="text-2xl font-bold">{selectedCampaign.clicked}</p>
                <p className="text-sm text-gray-500">Clicked</p>
              </div>
            </div>
            <div className="mt-4 grid grid-cols-2 gap-4">
              <div className="text-center"><p className="text-lg font-semibold text-red-600">{selectedCampaign.bounced}</p><p className="text-xs text-gray-500">Bounced</p></div>
              <div className="text-center"><p className="text-lg font-semibold text-red-600">{selectedCampaign.unsubscribed}</p><p className="text-xs text-gray-500">Unsubscribed</p></div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
