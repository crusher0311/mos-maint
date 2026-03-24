"use client";

import { useState } from "react";
import {
  MessageSquare,
  Plus,
  Search,
  Edit2,
  Trash2,
  X,
  Save,
  Copy,
  Tag,
  Zap,
  ToggleLeft,
  ToggleRight,
} from "lucide-react";

interface CannedMessage {
  id: string;
  title: string;
  body: string;
  category: string;
  shortcut: string;
  isActive: boolean;
  usageCount: number;
}

const DEMO_MESSAGES: CannedMessage[] = [
  {
    id: "1",
    title: "Appointment Confirmation",
    body: "Hi {name}, this is {shop_name}. We're confirming your appointment on {date} at {time}. Please reply YES to confirm or call us to reschedule. Thank you!",
    category: "Appointments",
    shortcut: "/confirm",
    isActive: true,
    usageCount: 245,
  },
  {
    id: "2",
    title: "Vehicle Ready for Pickup",
    body: "Great news, {name}! Your {vehicle} is ready for pickup. Your total is {amount}. We're open until {close_time} today. See you soon!",
    category: "Service Updates",
    shortcut: "/ready",
    isActive: true,
    usageCount: 189,
  },
  {
    id: "3",
    title: "Estimate Follow-up",
    body: "Hi {name}, we sent you an estimate for your {vehicle}. Would you like to proceed with the repairs? Feel free to call us with any questions at {phone}.",
    category: "Sales",
    shortcut: "/followup",
    isActive: true,
    usageCount: 132,
  },
  {
    id: "4",
    title: "Service Reminder",
    body: "Hi {name}, it's been {months} months since your last service at {shop_name}. We recommend scheduling a {service_type}. Book online or call us at {phone}.",
    category: "Marketing",
    shortcut: "/remind",
    isActive: true,
    usageCount: 98,
  },
  {
    id: "5",
    title: "Thank You After Service",
    body: "Thank you for choosing {shop_name}, {name}! We hope you're satisfied with the service on your {vehicle}. We'd appreciate a review: {review_link}",
    category: "Follow-up",
    shortcut: "/thanks",
    isActive: true,
    usageCount: 167,
  },
  {
    id: "6",
    title: "Parts on Order",
    body: "Hi {name}, the parts for your {vehicle} have been ordered and should arrive by {eta}. We'll contact you to schedule the installation. Thanks for your patience!",
    category: "Service Updates",
    shortcut: "/parts",
    isActive: false,
    usageCount: 45,
  },
  {
    id: "7",
    title: "After Hours Response",
    body: "Thanks for reaching out to {shop_name}! We're currently closed but will respond first thing in the morning. Our hours are {hours}. For emergencies, call {emergency_phone}.",
    category: "Auto-replies",
    shortcut: "/closed",
    isActive: true,
    usageCount: 312,
  },
];

const categoryColors: Record<string, string> = {
  Appointments: "text-blue-700 bg-blue-50 border-blue-200",
  "Service Updates": "text-green-700 bg-green-50 border-green-200",
  Sales: "text-purple-700 bg-purple-50 border-purple-200",
  Marketing: "text-orange-700 bg-orange-50 border-orange-200",
  "Follow-up": "text-teal-700 bg-teal-50 border-teal-200",
  "Auto-replies": "text-gray-700 bg-gray-50 border-gray-200",
};

export default function CannedMessagesPage() {
  const [messages, setMessages] = useState<CannedMessage[]>(DEMO_MESSAGES);
  const [searchQuery, setSearchQuery] = useState("");
  const [filterCategory, setFilterCategory] = useState("all");
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [formData, setFormData] = useState({
    title: "",
    body: "",
    category: "",
    shortcut: "",
  });

  const categories = Array.from(new Set(messages.map((m) => m.category)));

  const filtered = messages.filter((m) => {
    if (filterCategory !== "all" && m.category !== filterCategory) return false;
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      return (
        m.title.toLowerCase().includes(q) ||
        m.body.toLowerCase().includes(q) ||
        m.shortcut.toLowerCase().includes(q)
      );
    }
    return true;
  });

  const openForm = (msg?: CannedMessage) => {
    if (msg) {
      setEditingId(msg.id);
      setFormData({ title: msg.title, body: msg.body, category: msg.category, shortcut: msg.shortcut });
    } else {
      setEditingId(null);
      setFormData({ title: "", body: "", category: "", shortcut: "" });
    }
    setShowForm(true);
  };

  const saveMessage = () => {
    if (editingId) {
      setMessages((prev) => prev.map((m) => m.id === editingId ? { ...m, ...formData } : m));
    } else {
      setMessages((prev) => [
        ...prev,
        { id: `new-${Date.now()}`, ...formData, isActive: true, usageCount: 0 },
      ]);
    }
    setShowForm(false);
  };

  const toggleActive = (id: string) => {
    setMessages((prev) => prev.map((m) => m.id === id ? { ...m, isActive: !m.isActive } : m));
  };

  const deleteMessage = (id: string) => {
    setMessages((prev) => prev.filter((m) => m.id !== id));
  };

  const copyBody = (msg: CannedMessage) => {
    navigator.clipboard.writeText(msg.body);
    setCopiedId(msg.id);
    setTimeout(() => setCopiedId(null), 2000);
  };

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 flex items-center gap-2">
            <MessageSquare className="w-7 h-7 text-blue-600" />
            Canned Messages
          </h1>
          <p className="text-gray-600">Pre-built message templates for quick agent responses</p>
        </div>
        <button
          onClick={() => openForm()}
          className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors text-sm"
        >
          <Plus className="w-4 h-4" />
          New Template
        </button>
      </div>

      <div className="flex items-center gap-3">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
          <input
            type="text"
            placeholder="Search templates by title, body, or shortcut..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full pl-10 pr-4 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>
        <select
          value={filterCategory}
          onChange={(e) => setFilterCategory(e.target.value)}
          className="px-3 py-2 border border-gray-200 rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
        >
          <option value="all">All Categories</option>
          {categories.map((c) => (
            <option key={c} value={c}>{c}</option>
          ))}
        </select>
      </div>

      {showForm && (
        <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-semibold text-gray-900">
              {editingId ? "Edit Template" : "New Template"}
            </h2>
            <button onClick={() => setShowForm(false)} className="text-gray-400 hover:text-gray-600">
              <X className="w-5 h-5" />
            </button>
          </div>
          <div className="space-y-4">
            <div className="grid grid-cols-3 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Title</label>
                <input
                  type="text"
                  value={formData.title}
                  onChange={(e) => setFormData({ ...formData, title: e.target.value })}
                  placeholder="Template title"
                  className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Category</label>
                <input
                  type="text"
                  value={formData.category}
                  onChange={(e) => setFormData({ ...formData, category: e.target.value })}
                  placeholder="e.g., Appointments"
                  className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Shortcut</label>
                <input
                  type="text"
                  value={formData.shortcut}
                  onChange={(e) => setFormData({ ...formData, shortcut: e.target.value })}
                  placeholder="/shortcut"
                  className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Message Body</label>
              <textarea
                value={formData.body}
                onChange={(e) => setFormData({ ...formData, body: e.target.value })}
                rows={4}
                placeholder="Use {variable_name} for dynamic content..."
                className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none"
              />
              <p className="text-xs text-gray-400 mt-1">
                Available variables: {"{name}"}, {"{vehicle}"}, {"{shop_name}"}, {"{phone}"}, {"{date}"}, {"{time}"}, {"{amount}"}
              </p>
            </div>
          </div>
          <div className="flex justify-end gap-2 mt-4">
            <button onClick={() => setShowForm(false)} className="px-4 py-2 text-sm text-gray-600 hover:text-gray-800">Cancel</button>
            <button onClick={saveMessage} className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors text-sm">
              <Save className="w-4 h-4" />
              {editingId ? "Update" : "Create"} Template
            </button>
          </div>
        </div>
      )}

      <div className="space-y-3">
        {filtered.length === 0 ? (
          <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-12 text-center text-gray-500">
            <MessageSquare className="w-12 h-12 mx-auto mb-4 opacity-50" />
            <p className="mb-2">No templates found</p>
            <p className="text-sm">Create a new template to get started</p>
          </div>
        ) : (
          filtered.map((msg) => (
            <div
              key={msg.id}
              className={`bg-white rounded-xl shadow-sm border border-gray-100 p-4 transition-opacity ${!msg.isActive ? "opacity-60" : ""}`}
            >
              <div className="flex items-start justify-between gap-4">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1">
                    <h3 className="font-semibold text-gray-900 text-sm">{msg.title}</h3>
                    <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium border ${categoryColors[msg.category] || "text-gray-700 bg-gray-50 border-gray-200"}`}>
                      {msg.category}
                    </span>
                    {msg.shortcut && (
                      <span className="flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[10px] font-mono bg-gray-100 text-gray-600">
                        <Zap className="w-2.5 h-2.5" />
                        {msg.shortcut}
                      </span>
                    )}
                    {!msg.isActive && (
                      <span className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-gray-100 text-gray-500">Disabled</span>
                    )}
                  </div>
                  <p className="text-sm text-gray-600 leading-relaxed">{msg.body}</p>
                  <div className="flex items-center gap-3 mt-2 text-xs text-gray-400">
                    <span>Used {msg.usageCount} times</span>
                  </div>
                </div>
                <div className="flex items-center gap-1 flex-shrink-0">
                  <button
                    onClick={() => copyBody(msg)}
                    className="p-1.5 text-gray-400 hover:text-blue-600 rounded transition-colors"
                    title="Copy message"
                  >
                    <Copy className="w-4 h-4" />
                  </button>
                  {copiedId === msg.id && (
                    <span className="text-[10px] text-green-600 font-medium">Copied!</span>
                  )}
                  <button
                    onClick={() => toggleActive(msg.id)}
                    className={`p-1 transition-colors ${msg.isActive ? "text-blue-600" : "text-gray-400"}`}
                    title={msg.isActive ? "Disable" : "Enable"}
                  >
                    {msg.isActive ? <ToggleRight className="w-6 h-6" /> : <ToggleLeft className="w-6 h-6" />}
                  </button>
                  <button
                    onClick={() => openForm(msg)}
                    className="p-1.5 text-gray-400 hover:text-blue-600 rounded transition-colors"
                  >
                    <Edit2 className="w-4 h-4" />
                  </button>
                  <button
                    onClick={() => deleteMessage(msg.id)}
                    className="p-1.5 text-gray-400 hover:text-red-600 rounded transition-colors"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
