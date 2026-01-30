"use client";

import { useState, useEffect } from "react";
import {
  Ticket,
  Plus,
  MessageSquare,
  Clock,
  CheckCircle,
  AlertCircle,
  XCircle,
  Send,
  ChevronRight,
  X,
  ArrowLeft
} from "lucide-react";
import Link from "next/link";

interface TicketMessage {
  id: string;
  from: "user" | "admin";
  fromEmail: string;
  fromName: string;
  message: string;
  createdAt: string;
}

interface SupportTicket {
  _id: string;
  ticketNumber: string;
  subject: string;
  description: string;
  category: string;
  priority: string;
  status: string;
  messages: TicketMessage[];
  createdAt: string;
  updatedAt: string;
}

const CATEGORIES = [
  { value: "general", label: "General Question" },
  { value: "billing", label: "Billing & Payments" },
  { value: "technical", label: "Technical Issue" },
  { value: "feature_request", label: "Feature Request" },
  { value: "bug", label: "Bug Report" },
  { value: "account", label: "Account Help" }
];

export default function SupportPage() {
  const [tickets, setTickets] = useState<SupportTicket[]>([]);
  const [loading, setLoading] = useState(true);
  const [showNewTicket, setShowNewTicket] = useState(false);
  const [selectedTicket, setSelectedTicket] = useState<SupportTicket | null>(null);
  const [userEmail, setUserEmail] = useState<string>("");
  const [newTicket, setNewTicket] = useState({
    subject: "",
    description: "",
    category: "general",
    priority: "medium"
  });
  const [submitting, setSubmitting] = useState(false);
  const [replyMessage, setReplyMessage] = useState("");
  const [sending, setSending] = useState(false);
  const [success, setSuccess] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    loadTickets();
    loadUserEmail();
  }, []);

  const loadUserEmail = async () => {
    try {
      const res = await fetch("/api/user/profile");
      const data = await res.json();
      if (data.ok && data.user?.email) {
        setUserEmail(data.user.email);
      }
    } catch (error) {
      console.error("Error loading user email:", error);
    }
  };

  const loadTickets = async () => {
    try {
      const res = await fetch("/api/support/tickets");
      const data = await res.json();
      if (data.ok) {
        setTickets(data.tickets);
      }
    } catch (error) {
      console.error("Error loading tickets:", error);
    } finally {
      setLoading(false);
    }
  };

  const createTicket = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newTicket.subject || !newTicket.description) return;

    setSubmitting(true);
    try {
      const res = await fetch("/api/support/tickets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(newTicket)
      });

      const data = await res.json();
      if (data.ok) {
        setSuccess(`Ticket ${data.ticketNumber} created successfully!`);
        setNewTicket({ subject: "", description: "", category: "general", priority: "medium" });
        setShowNewTicket(false);
        loadTickets();
        setTimeout(() => setSuccess(""), 3000);
      }
    } catch (error) {
      console.error("Error creating ticket:", error);
    } finally {
      setSubmitting(false);
    }
  };

  const sendReply = async () => {
    if (!selectedTicket || !replyMessage.trim()) return;

    setSending(true);
    setError("");
    try {
      const res = await fetch(`/api/support/tickets/${selectedTicket._id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: replyMessage.trim() })
      });

      const data = await res.json();
      if (data.ok) {
        setSelectedTicket(data.ticket);
        setReplyMessage("");
        loadTickets();
      } else {
        setError(data.error || "Failed to send reply. Please try again.");
      }
    } catch (err) {
      console.error("Error sending reply:", err);
      setError("Failed to send reply. Please check your connection and try again.");
    } finally {
      setSending(false);
    }
  };

  const getStatusIcon = (status: string) => {
    switch (status) {
      case "open": return <AlertCircle className="w-4 h-4 text-blue-500" />;
      case "in_progress": return <Clock className="w-4 h-4 text-yellow-500" />;
      case "resolved": return <CheckCircle className="w-4 h-4 text-green-500" />;
      case "closed": return <XCircle className="w-4 h-4 text-gray-500" />;
      default: return <AlertCircle className="w-4 h-4 text-gray-500" />;
    }
  };

  const getStatusColor = (status: string) => {
    switch (status) {
      case "open": return "bg-blue-100 text-blue-700";
      case "in_progress": return "bg-yellow-100 text-yellow-700";
      case "resolved": return "bg-green-100 text-green-700";
      case "closed": return "bg-gray-100 text-gray-700";
      default: return "bg-gray-100 text-gray-700";
    }
  };

  const formatDate = (date: string) => {
    return new Date(date).toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric"
    });
  };

  const formatFullDate = (date: string) => {
    return new Date(date).toLocaleString("en-US", {
      weekday: "short",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit"
    });
  };

  if (loading) {
    return (
      <div className="p-8">
        <div className="animate-pulse space-y-4">
          <div className="h-8 bg-gray-200 rounded w-1/4"></div>
          <div className="h-64 bg-gray-200 rounded-lg"></div>
        </div>
      </div>
    );
  }

  if (selectedTicket) {
    return (
      <div className="p-6 max-w-4xl mx-auto">
        <button
          onClick={() => setSelectedTicket(null)}
          className="flex items-center gap-2 text-gray-600 hover:text-gray-900 mb-4"
        >
          <ArrowLeft className="w-4 h-4" />
          Back to Tickets
        </button>

        <div className="bg-white rounded-xl shadow-sm border border-gray-100">
          <div className="p-6 border-b border-gray-100">
            <div className="flex items-center gap-2 mb-2">
              <span className="text-sm font-mono text-gray-500">{selectedTicket.ticketNumber}</span>
              <span className={`px-2 py-0.5 text-xs font-medium rounded ${getStatusColor(selectedTicket.status)}`}>
                {selectedTicket.status.replace("_", " ")}
              </span>
            </div>
            <h1 className="text-xl font-semibold text-gray-900">{selectedTicket.subject}</h1>
            <div className="flex items-center gap-4 mt-2 text-sm text-gray-500">
              <span>Category: {selectedTicket.category.replace("_", " ")}</span>
              <span>Created: {formatDate(selectedTicket.createdAt)}</span>
            </div>
          </div>

          <div className="p-6 space-y-4 max-h-[50vh] overflow-auto">
            {selectedTicket.messages?.map((msg) => (
              <div
                key={msg.id}
                className={`p-4 rounded-lg ${
                  msg.from === "admin"
                    ? "bg-blue-50 ml-8 border border-blue-100"
                    : "bg-gray-50 mr-8 border border-gray-100"
                }`}
              >
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-2">
                    <div className={`w-6 h-6 rounded-full flex items-center justify-center text-xs font-medium ${
                      msg.from === "admin" ? "bg-blue-600 text-white" : "bg-gray-600 text-white"
                    }`}>
                      {msg.fromName.charAt(0).toUpperCase()}
                    </div>
                    <span className="font-medium text-sm">
                      {msg.from === "admin" ? "Support Team" : "You"}
                    </span>
                  </div>
                  <span className="text-xs text-gray-500">{formatFullDate(msg.createdAt)}</span>
                </div>
                <p className="text-gray-700 whitespace-pre-wrap">{msg.message}</p>
              </div>
            ))}
          </div>

          {selectedTicket.status !== "closed" && (
            <div className="p-6 border-t border-gray-100">
              {error && (
                <div className="mb-3 p-3 bg-red-50 border border-red-200 text-red-700 rounded-lg text-sm">
                  {error}
                </div>
              )}
              <div className="flex gap-2">
                <textarea
                  value={replyMessage}
                  onChange={(e) => setReplyMessage(e.target.value)}
                  placeholder="Type your message..."
                  className="flex-1 px-4 py-3 border border-gray-200 rounded-lg resize-none focus:outline-none focus:ring-2 focus:ring-blue-500"
                  rows={3}
                />
                <button
                  onClick={sendReply}
                  disabled={sending || !replyMessage.trim()}
                  className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2 self-end"
                >
                  <Send className="w-4 h-4" />
                  {sending ? "Sending..." : "Send"}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="p-6 max-w-4xl mx-auto space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 flex items-center gap-2">
            <Ticket className="w-7 h-7 text-blue-600" />
            Support
          </h1>
          <p className="text-gray-600">Get help with your account or report issues</p>
        </div>
        <button
          onClick={() => setShowNewTicket(true)}
          className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
        >
          <Plus className="w-4 h-4" />
          New Ticket
        </button>
      </div>

      {success && (
        <div className="bg-green-50 border border-green-200 rounded-lg p-4 text-green-700">
          {success}
        </div>
      )}

      <div className="bg-white rounded-xl shadow-sm border border-gray-100">
        <div className="p-4 border-b border-gray-100">
          <h2 className="font-semibold text-gray-900">Your Tickets</h2>
        </div>

        <div className="divide-y divide-gray-100">
          {tickets.length === 0 ? (
            <div className="p-12 text-center text-gray-500">
              <Ticket className="w-12 h-12 mx-auto mb-4 opacity-50" />
              <p className="mb-2">No support tickets yet</p>
              <p className="text-sm">Create a ticket if you need help with anything</p>
            </div>
          ) : (
            tickets.map(ticket => (
              <div
                key={ticket._id}
                onClick={() => setSelectedTicket(ticket)}
                className="p-4 hover:bg-gray-50 cursor-pointer transition-colors flex items-center justify-between"
              >
                <div className="flex-1">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-xs font-mono text-gray-500">{ticket.ticketNumber}</span>
                    {getStatusIcon(ticket.status)}
                    <span className={`px-2 py-0.5 text-xs font-medium rounded ${getStatusColor(ticket.status)}`}>
                      {ticket.status.replace("_", " ")}
                    </span>
                  </div>
                  <h3 className="font-medium text-gray-900">{ticket.subject}</h3>
                  <div className="flex items-center gap-4 mt-1 text-sm text-gray-500">
                    <span className="capitalize">{ticket.category.replace("_", " ")}</span>
                    <span className="flex items-center gap-1">
                      <MessageSquare className="w-3 h-3" />
                      {ticket.messages?.length || 0} messages
                    </span>
                    <span>{formatDate(ticket.createdAt)}</span>
                  </div>
                </div>
                <ChevronRight className="w-5 h-5 text-gray-400" />
              </div>
            ))
          )}
        </div>
      </div>

      {showNewTicket && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-xl shadow-xl max-w-lg w-full">
            <div className="p-4 border-b border-gray-200 flex items-center justify-between">
              <h2 className="text-lg font-semibold text-gray-900">Create Support Ticket</h2>
              <button
                onClick={() => setShowNewTicket(false)}
                className="p-2 hover:bg-gray-100 rounded-lg transition-colors"
              >
                <X className="w-5 h-5 text-gray-500" />
              </button>
            </div>

            <form onSubmit={createTicket} className="p-6 space-y-4">
              {userEmail && (
                <div className="bg-gray-50 border border-gray-200 rounded-lg p-3">
                  <label className="block text-xs font-medium text-gray-500 mb-1">
                    Your Email
                  </label>
                  <p className="text-sm text-gray-900">{userEmail}</p>
                </div>
              )}

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Category
                </label>
                <select
                  value={newTicket.category}
                  onChange={(e) => setNewTicket(prev => ({ ...prev, category: e.target.value }))}
                  className="w-full px-3 py-2 border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                >
                  {CATEGORIES.map(c => (
                    <option key={c.value} value={c.value}>{c.label}</option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Subject
                </label>
                <input
                  type="text"
                  value={newTicket.subject}
                  onChange={(e) => setNewTicket(prev => ({ ...prev, subject: e.target.value }))}
                  placeholder="Brief description of your issue"
                  className="w-full px-3 py-2 border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                  required
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Description
                </label>
                <textarea
                  value={newTicket.description}
                  onChange={(e) => setNewTicket(prev => ({ ...prev, description: e.target.value }))}
                  placeholder="Please describe your issue in detail..."
                  className="w-full px-3 py-2 border border-gray-200 rounded-lg resize-none focus:outline-none focus:ring-2 focus:ring-blue-500"
                  rows={5}
                  required
                />
              </div>

              <div className="flex justify-end gap-3 pt-4">
                <button
                  type="button"
                  onClick={() => setShowNewTicket(false)}
                  className="px-4 py-2 text-gray-700 hover:bg-gray-100 rounded-lg transition-colors"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={submitting || !newTicket.subject || !newTicket.description}
                  className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {submitting ? "Creating..." : "Create Ticket"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
