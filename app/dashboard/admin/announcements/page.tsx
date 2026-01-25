"use client";

import { useState, useEffect } from "react";
import {
  Megaphone,
  Send,
  Eye,
  Trash2,
  Users,
  Building2,
  Shield,
  Settings,
  AlertTriangle,
  AlertCircle,
  Info,
  ChevronDown,
  Mail,
  Bell,
  CheckCircle,
} from "lucide-react";

interface Announcement {
  _id: string;
  title: string;
  message: string;
  priority: "info" | "warning" | "critical";
  target: {
    type: "all" | "shops" | "roles" | "sms_integration";
    shopIds?: number[];
    roles?: string[];
    smsIntegrations?: string[];
  };
  deliveryChannels: {
    inApp: boolean;
    email: boolean;
  };
  status: "draft" | "sent" | "scheduled";
  createdBy: string;
  createdAt: string;
  sentAt?: string;
  stats?: {
    totalRecipients: number;
    emailsSent: number;
    inAppSent: number;
  };
}

const SMS_INTEGRATIONS = [
  { value: "tekmetric", label: "Tekmetric" },
  { value: "protractor", label: "Protractor" },
  { value: "autoflow", label: "AutoFlow" },
  { value: "shopware", label: "Shopware" },
  { value: "shopmonkey", label: "Shopmonkey" },
];

const ROLES = [
  { value: "owner", label: "Shop Owners" },
  { value: "manager", label: "Managers" },
  { value: "technician", label: "Technicians" },
  { value: "service_writer", label: "Service Writers" },
];

const PRIORITY_STYLES = {
  info: { bg: "bg-blue-50", border: "border-blue-200", text: "text-blue-700", icon: Info },
  warning: { bg: "bg-amber-50", border: "border-amber-200", text: "text-amber-700", icon: AlertCircle },
  critical: { bg: "bg-red-50", border: "border-red-200", text: "text-red-700", icon: AlertTriangle },
};

export default function AnnouncementsPage() {
  const [announcements, setAnnouncements] = useState<Announcement[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [previewCount, setPreviewCount] = useState<number | null>(null);

  const [form, setForm] = useState({
    title: "",
    message: "",
    priority: "info" as "info" | "warning" | "critical",
    targetType: "all" as "all" | "shops" | "roles" | "sms_integration",
    shopIds: "",
    roles: [] as string[],
    smsIntegrations: [] as string[],
    inApp: true,
    email: true,
  });

  useEffect(() => {
    loadAnnouncements();
  }, []);

  const loadAnnouncements = async () => {
    try {
      const res = await fetch("/api/admin/announcements");
      const data = await res.json();
      if (data.announcements) {
        setAnnouncements(data.announcements);
      }
    } catch (error) {
      console.error("Error loading announcements:", error);
    } finally {
      setLoading(false);
    }
  };

  const handlePreview = async () => {
    try {
      const res = await fetch("/api/admin/announcements", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: form.title,
          message: form.message,
          priority: form.priority,
          target: buildTarget(),
          deliveryChannels: { inApp: form.inApp, email: form.email },
          previewOnly: true,
        }),
      });
      const data = await res.json();
      if (data.recipientCount !== undefined) {
        setPreviewCount(data.recipientCount);
      }
    } catch (error) {
      console.error("Error getting preview:", error);
    }
  };

  const buildTarget = () => {
    const target: Record<string, unknown> = { type: form.targetType };
    if (form.targetType === "shops" && form.shopIds) {
      target.shopIds = form.shopIds.split(",").map((id) => parseInt(id.trim())).filter(Boolean);
    } else if (form.targetType === "roles" && form.roles.length > 0) {
      target.roles = form.roles;
    } else if (form.targetType === "sms_integration" && form.smsIntegrations.length > 0) {
      target.smsIntegrations = form.smsIntegrations;
    }
    return target;
  };

  const handleSubmit = async (sendNow: boolean) => {
    if (!form.title || !form.message) return;

    setSubmitting(true);
    try {
      const res = await fetch("/api/admin/announcements", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: form.title,
          message: form.message,
          priority: form.priority,
          target: buildTarget(),
          deliveryChannels: { inApp: form.inApp, email: form.email },
          sendNow,
        }),
      });

      if (res.ok) {
        setForm({
          title: "",
          message: "",
          priority: "info",
          targetType: "all",
          shopIds: "",
          roles: [],
          smsIntegrations: [],
          inApp: true,
          email: true,
        });
        setShowCreate(false);
        setPreviewCount(null);
        loadAnnouncements();
      }
    } catch (error) {
      console.error("Error creating announcement:", error);
    } finally {
      setSubmitting(false);
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm("Are you sure you want to delete this announcement?")) return;

    try {
      await fetch(`/api/admin/announcements?id=${id}`, { method: "DELETE" });
      loadAnnouncements();
    } catch (error) {
      console.error("Error deleting announcement:", error);
    }
  };

  const handleSendDraft = async (id: string) => {
    if (!confirm("Send this announcement now?")) return;

    try {
      const res = await fetch(`/api/admin/announcements/${id}/send`, { method: "POST" });
      if (res.ok) {
        loadAnnouncements();
      }
    } catch (error) {
      console.error("Error sending announcement:", error);
    }
  };

  const toggleRole = (role: string) => {
    setForm((prev) => ({
      ...prev,
      roles: prev.roles.includes(role)
        ? prev.roles.filter((r) => r !== role)
        : [...prev.roles, role],
    }));
  };

  const toggleSmsIntegration = (sms: string) => {
    setForm((prev) => ({
      ...prev,
      smsIntegrations: prev.smsIntegrations.includes(sms)
        ? prev.smsIntegrations.filter((s) => s !== sms)
        : [...prev.smsIntegrations, sms],
    }));
  };

  const formatDate = (date: string) => {
    return new Date(date).toLocaleString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  };

  const getTargetLabel = (target: Announcement["target"]) => {
    switch (target.type) {
      case "all":
        return "All Users";
      case "shops":
        return `Shops: ${target.shopIds?.join(", ")}`;
      case "roles":
        return `Roles: ${target.roles?.join(", ")}`;
      case "sms_integration":
        return `SMS: ${target.smsIntegrations?.join(", ")}`;
      default:
        return target.type;
    }
  };

  return (
    <div className="p-6 max-w-6xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <div className="p-2 rounded-lg bg-blue-100">
            <Megaphone className="w-6 h-6 text-blue-600" />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-gray-900">System Announcements</h1>
            <p className="text-gray-500">Send in-app and email notifications to users</p>
          </div>
        </div>
        <button
          onClick={() => setShowCreate(!showCreate)}
          className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
        >
          <Megaphone className="w-4 h-4" />
          {showCreate ? "Cancel" : "New Announcement"}
        </button>
      </div>

      {showCreate && (
        <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6 mb-6">
          <h2 className="text-lg font-semibold mb-4">Create Announcement</h2>

          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Title</label>
              <input
                type="text"
                value={form.title}
                onChange={(e) => setForm({ ...form, title: e.target.value })}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                placeholder="Announcement title..."
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Message</label>
              <textarea
                value={form.message}
                onChange={(e) => setForm({ ...form, message: e.target.value })}
                rows={4}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                placeholder="Write your announcement message..."
              />
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Priority</label>
                <div className="flex gap-2">
                  {(["info", "warning", "critical"] as const).map((p) => {
                    const styles = PRIORITY_STYLES[p];
                    const Icon = styles.icon;
                    return (
                      <button
                        key={p}
                        onClick={() => setForm({ ...form, priority: p })}
                        className={`flex-1 flex items-center justify-center gap-2 px-3 py-2 rounded-lg border-2 transition-all ${
                          form.priority === p
                            ? `${styles.bg} ${styles.border} ${styles.text}`
                            : "border-gray-200 hover:border-gray-300"
                        }`}
                      >
                        <Icon className="w-4 h-4" />
                        <span className="capitalize">{p}</span>
                      </button>
                    );
                  })}
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Delivery Channels</label>
                <div className="flex gap-2">
                  <button
                    onClick={() => setForm({ ...form, inApp: !form.inApp })}
                    className={`flex-1 flex items-center justify-center gap-2 px-3 py-2 rounded-lg border-2 transition-all ${
                      form.inApp
                        ? "border-blue-500 bg-blue-50 text-blue-700"
                        : "border-gray-200 hover:border-gray-300"
                    }`}
                  >
                    <Bell className="w-4 h-4" />
                    In-App
                  </button>
                  <button
                    onClick={() => setForm({ ...form, email: !form.email })}
                    className={`flex-1 flex items-center justify-center gap-2 px-3 py-2 rounded-lg border-2 transition-all ${
                      form.email
                        ? "border-blue-500 bg-blue-50 text-blue-700"
                        : "border-gray-200 hover:border-gray-300"
                    }`}
                  >
                    <Mail className="w-4 h-4" />
                    Email
                  </button>
                </div>
              </div>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Target Audience</label>
              <div className="flex gap-2 mb-3">
                {[
                  { type: "all", label: "All Users", icon: Users },
                  { type: "shops", label: "By Shop", icon: Building2 },
                  { type: "roles", label: "By Role", icon: Shield },
                  { type: "sms_integration", label: "By SMS Integration", icon: Settings },
                ].map(({ type, label, icon: Icon }) => (
                  <button
                    key={type}
                    onClick={() => setForm({ ...form, targetType: type as typeof form.targetType })}
                    className={`flex items-center gap-2 px-3 py-2 rounded-lg border-2 transition-all ${
                      form.targetType === type
                        ? "border-blue-500 bg-blue-50 text-blue-700"
                        : "border-gray-200 hover:border-gray-300"
                    }`}
                  >
                    <Icon className="w-4 h-4" />
                    {label}
                  </button>
                ))}
              </div>

              {form.targetType === "shops" && (
                <input
                  type="text"
                  value={form.shopIds}
                  onChange={(e) => setForm({ ...form, shopIds: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg"
                  placeholder="Enter shop IDs separated by commas (e.g., 123, 456, 789)"
                />
              )}

              {form.targetType === "roles" && (
                <div className="flex flex-wrap gap-2">
                  {ROLES.map(({ value, label }) => (
                    <button
                      key={value}
                      onClick={() => toggleRole(value)}
                      className={`px-3 py-1 rounded-full border transition-all ${
                        form.roles.includes(value)
                          ? "border-blue-500 bg-blue-50 text-blue-700"
                          : "border-gray-200 hover:border-gray-300"
                      }`}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              )}

              {form.targetType === "sms_integration" && (
                <div className="flex flex-wrap gap-2">
                  {SMS_INTEGRATIONS.map(({ value, label }) => (
                    <button
                      key={value}
                      onClick={() => toggleSmsIntegration(value)}
                      className={`px-3 py-1 rounded-full border transition-all ${
                        form.smsIntegrations.includes(value)
                          ? "border-blue-500 bg-blue-50 text-blue-700"
                          : "border-gray-200 hover:border-gray-300"
                      }`}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              )}
            </div>

            {previewCount !== null && (
              <div className="flex items-center gap-2 p-3 bg-gray-50 rounded-lg">
                <Users className="w-4 h-4 text-gray-500" />
                <span className="text-sm text-gray-600">
                  This announcement will be sent to <strong>{previewCount}</strong> recipient{previewCount !== 1 ? "s" : ""}
                </span>
              </div>
            )}

            <div className="flex justify-end gap-3 pt-4 border-t">
              <button
                onClick={handlePreview}
                className="flex items-center gap-2 px-4 py-2 border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
              >
                <Eye className="w-4 h-4" />
                Preview Recipients
              </button>
              <button
                onClick={() => handleSubmit(false)}
                disabled={!form.title || !form.message || submitting}
                className="flex items-center gap-2 px-4 py-2 border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors disabled:opacity-50"
              >
                Save as Draft
              </button>
              <button
                onClick={() => handleSubmit(true)}
                disabled={!form.title || !form.message || submitting || (!form.inApp && !form.email)}
                className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors disabled:opacity-50"
              >
                <Send className="w-4 h-4" />
                {submitting ? "Sending..." : "Send Now"}
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="bg-white rounded-xl shadow-sm border border-gray-200">
        <div className="p-4 border-b border-gray-200">
          <h2 className="font-semibold">Announcement History</h2>
        </div>

        {loading ? (
          <div className="p-8 text-center text-gray-500">Loading announcements...</div>
        ) : announcements.length === 0 ? (
          <div className="p-8 text-center text-gray-500">
            <Megaphone className="w-12 h-12 mx-auto mb-3 text-gray-300" />
            <p>No announcements yet</p>
            <p className="text-sm">Create your first system announcement above</p>
          </div>
        ) : (
          <div className="divide-y divide-gray-100">
            {announcements.map((announcement) => {
              const styles = PRIORITY_STYLES[announcement.priority];
              const Icon = styles.icon;
              return (
                <div key={announcement._id} className="p-4 hover:bg-gray-50">
                  <div className="flex items-start justify-between">
                    <div className="flex-1">
                      <div className="flex items-center gap-2 mb-1">
                        <span
                          className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium ${styles.bg} ${styles.text}`}
                        >
                          <Icon className="w-3 h-3" />
                          {announcement.priority}
                        </span>
                        <span
                          className={`px-2 py-0.5 rounded text-xs font-medium ${
                            announcement.status === "sent"
                              ? "bg-green-100 text-green-700"
                              : "bg-gray-100 text-gray-600"
                          }`}
                        >
                          {announcement.status}
                        </span>
                        <span className="text-xs text-gray-400">
                          {formatDate(announcement.sentAt || announcement.createdAt)}
                        </span>
                      </div>
                      <h3 className="font-medium text-gray-900">{announcement.title}</h3>
                      <p className="text-sm text-gray-600 line-clamp-2 mt-1">{announcement.message}</p>
                      <div className="flex items-center gap-4 mt-2 text-xs text-gray-500">
                        <span>{getTargetLabel(announcement.target)}</span>
                        {announcement.stats && (
                          <>
                            <span className="flex items-center gap-1">
                              <Bell className="w-3 h-3" />
                              {announcement.stats.inAppSent} in-app
                            </span>
                            <span className="flex items-center gap-1">
                              <Mail className="w-3 h-3" />
                              {announcement.stats.emailsSent} emails
                            </span>
                          </>
                        )}
                      </div>
                    </div>
                    <div className="flex items-center gap-2 ml-4">
                      {announcement.status === "draft" && (
                        <button
                          onClick={() => handleSendDraft(announcement._id)}
                          className="p-2 text-blue-600 hover:bg-blue-50 rounded-lg transition-colors"
                          title="Send now"
                        >
                          <Send className="w-4 h-4" />
                        </button>
                      )}
                      <button
                        onClick={() => handleDelete(announcement._id)}
                        className="p-2 text-red-600 hover:bg-red-50 rounded-lg transition-colors"
                        title="Delete"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
