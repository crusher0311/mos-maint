"use client";

import { useState } from "react";
import {
  MessageSquare,
  Phone,
  Mail,
  Voicemail,
  Search,
  Filter,
  ChevronRight,
  ArrowLeft,
  Circle,
  Clock,
  CheckCircle,
  X,
} from "lucide-react";
import { ChannelBadge, MessageBubble } from "@/components/communications/MessageBubble";
import { formatPhoneNumber } from "@/components/communications/PhoneFormatter";

type Channel = "call" | "sms" | "email" | "voicemail";
type Status = "open" | "pending" | "resolved";

interface Message {
  id: string;
  content: string;
  channel: Channel;
  timestamp: string;
  isOutbound: boolean;
  senderName: string;
}

interface Conversation {
  id: string;
  contactName: string;
  phone: string;
  lastMessage: string;
  channel: Channel;
  status: Status;
  unreadCount: number;
  timestamp: string;
  shopName: string;
  messages: Message[];
}

const DEMO_CONVERSATIONS: Conversation[] = [
  {
    id: "1",
    contactName: "John Martinez",
    phone: "5551234567",
    lastMessage: "Thanks for the update on my brake job. When can I pick up?",
    channel: "sms",
    status: "open",
    unreadCount: 2,
    timestamp: "2026-03-24T14:30:00Z",
    shopName: "Downtown Auto Care",
    messages: [
      { id: "m1", content: "Hi, I wanted to check on the status of my 2019 Honda Civic brake job.", channel: "sms", timestamp: "2026-03-24T10:00:00Z", isOutbound: false, senderName: "John Martinez" },
      { id: "m2", content: "Hi John! Your brake pads and rotors have been replaced. We're finishing up the test drive now.", channel: "sms", timestamp: "2026-03-24T10:15:00Z", isOutbound: true, senderName: "Service Advisor" },
      { id: "m3", content: "Thanks for the update on my brake job. When can I pick up?", channel: "sms", timestamp: "2026-03-24T14:30:00Z", isOutbound: false, senderName: "John Martinez" },
    ],
  },
  {
    id: "2",
    contactName: "Sarah Johnson",
    phone: "5559876543",
    lastMessage: "Left a voicemail about oil change appointment",
    channel: "voicemail",
    status: "pending",
    unreadCount: 1,
    timestamp: "2026-03-24T12:15:00Z",
    shopName: "Downtown Auto Care",
    messages: [
      { id: "m4", content: "Left a voicemail about oil change appointment", channel: "voicemail", timestamp: "2026-03-24T12:15:00Z", isOutbound: false, senderName: "Sarah Johnson" },
    ],
  },
  {
    id: "3",
    contactName: "Mike Chen",
    phone: "5555551234",
    lastMessage: "Call completed - discussed transmission diagnosis results",
    channel: "call",
    status: "resolved",
    unreadCount: 0,
    timestamp: "2026-03-23T16:45:00Z",
    shopName: "Westside Motors",
    messages: [
      { id: "m5", content: "Incoming call - customer asking about transmission diagnosis", channel: "call", timestamp: "2026-03-23T16:30:00Z", isOutbound: false, senderName: "Mike Chen" },
      { id: "m6", content: "Call completed - discussed transmission diagnosis results", channel: "call", timestamp: "2026-03-23T16:45:00Z", isOutbound: true, senderName: "Service Advisor" },
    ],
  },
  {
    id: "4",
    contactName: "Lisa Park",
    phone: "5558887766",
    lastMessage: "Your vehicle is ready for pickup. Total: $847.50",
    channel: "sms",
    status: "resolved",
    unreadCount: 0,
    timestamp: "2026-03-23T11:00:00Z",
    shopName: "Downtown Auto Care",
    messages: [
      { id: "m7", content: "Hi, checking if my Subaru Outback is done yet?", channel: "sms", timestamp: "2026-03-23T09:00:00Z", isOutbound: false, senderName: "Lisa Park" },
      { id: "m8", content: "Your vehicle is ready for pickup. Total: $847.50", channel: "sms", timestamp: "2026-03-23T11:00:00Z", isOutbound: true, senderName: "Service Advisor" },
    ],
  },
  {
    id: "5",
    contactName: "Robert Williams",
    phone: "5552223344",
    lastMessage: "Sent estimate via email for engine diagnostic",
    channel: "email",
    status: "open",
    unreadCount: 1,
    timestamp: "2026-03-24T09:30:00Z",
    shopName: "Westside Motors",
    messages: [
      { id: "m9", content: "I'd like to get an estimate for an engine diagnostic on my 2020 Ford F-150.", channel: "email", timestamp: "2026-03-24T08:00:00Z", isOutbound: false, senderName: "Robert Williams" },
      { id: "m10", content: "Sent estimate via email for engine diagnostic", channel: "email", timestamp: "2026-03-24T09:30:00Z", isOutbound: true, senderName: "Service Advisor" },
    ],
  },
];

const statusConfig: Record<Status, { label: string; icon: typeof Circle; color: string }> = {
  open: { label: "Open", icon: Circle, color: "text-blue-600 bg-blue-50" },
  pending: { label: "Pending", icon: Clock, color: "text-yellow-600 bg-yellow-50" },
  resolved: { label: "Resolved", icon: CheckCircle, color: "text-green-600 bg-green-50" },
};

export default function ConversationsPage() {
  const [conversations] = useState<Conversation[]>(DEMO_CONVERSATIONS);
  const [selected, setSelected] = useState<Conversation | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [filterStatus, setFilterStatus] = useState<Status | "all">("all");
  const [filterChannel, setFilterChannel] = useState<Channel | "all">("all");
  const [filterShop, setFilterShop] = useState<string>("all");
  const [showFilters, setShowFilters] = useState(false);

  const shops = Array.from(new Set(conversations.map((c) => c.shopName)));

  const filtered = conversations.filter((c) => {
    if (filterStatus !== "all" && c.status !== filterStatus) return false;
    if (filterChannel !== "all" && c.channel !== filterChannel) return false;
    if (filterShop !== "all" && c.shopName !== filterShop) return false;
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      return (
        c.contactName.toLowerCase().includes(q) ||
        c.phone.includes(q) ||
        c.lastMessage.toLowerCase().includes(q)
      );
    }
    return true;
  });

  if (selected) {
    return (
      <div className="p-6 max-w-4xl mx-auto">
        <button
          onClick={() => setSelected(null)}
          className="flex items-center gap-2 text-gray-600 hover:text-gray-900 mb-4"
        >
          <ArrowLeft className="w-4 h-4" />
          Back to Conversations
        </button>

        <div className="bg-white rounded-xl shadow-sm border border-gray-100">
          <div className="p-4 border-b border-gray-100 flex items-center justify-between">
            <div>
              <h2 className="text-lg font-semibold text-gray-900">{selected.contactName}</h2>
              <div className="flex items-center gap-3 mt-1">
                <span className="text-sm text-gray-500">{formatPhoneNumber(selected.phone)}</span>
                <ChannelBadge channel={selected.channel} />
                <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium ${statusConfig[selected.status].color}`}>
                  {selected.status}
                </span>
              </div>
            </div>
            <span className="text-xs text-gray-400">{selected.shopName}</span>
          </div>

          <div className="p-4 space-y-4 max-h-[60vh] overflow-y-auto bg-gray-50">
            {selected.messages.map((msg) => (
              <MessageBubble
                key={msg.id}
                content={msg.content}
                channel={msg.channel}
                timestamp={msg.timestamp}
                isOutbound={msg.isOutbound}
                senderName={msg.senderName}
              />
            ))}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 flex items-center gap-2">
            <MessageSquare className="w-7 h-7 text-blue-600" />
            Conversations
          </h1>
          <p className="text-gray-600">Unified message threads across all channels</p>
        </div>
      </div>

      <div className="flex items-center gap-3">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
          <input
            type="text"
            placeholder="Search by name, phone, or message..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full pl-10 pr-4 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>
        <button
          onClick={() => setShowFilters(!showFilters)}
          className={`flex items-center gap-2 px-3 py-2 border rounded-lg text-sm transition-colors ${
            showFilters ? "border-blue-300 bg-blue-50 text-blue-700" : "border-gray-200 text-gray-600 hover:bg-gray-50"
          }`}
        >
          <Filter className="w-4 h-4" />
          Filters
        </button>
      </div>

      {showFilters && (
        <div className="flex items-center gap-3 flex-wrap bg-gray-50 rounded-lg p-3 border border-gray-100">
          <select
            value={filterShop}
            onChange={(e) => setFilterShop(e.target.value)}
            className="px-3 py-1.5 border border-gray-200 rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
            <option value="all">All Shops</option>
            {shops.map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
          <select
            value={filterStatus}
            onChange={(e) => setFilterStatus(e.target.value as Status | "all")}
            className="px-3 py-1.5 border border-gray-200 rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
            <option value="all">All Statuses</option>
            <option value="open">Open</option>
            <option value="pending">Pending</option>
            <option value="resolved">Resolved</option>
          </select>
          <select
            value={filterChannel}
            onChange={(e) => setFilterChannel(e.target.value as Channel | "all")}
            className="px-3 py-1.5 border border-gray-200 rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
            <option value="all">All Channels</option>
            <option value="call">Calls</option>
            <option value="sms">SMS</option>
            <option value="email">Email</option>
            <option value="voicemail">Voicemail</option>
          </select>
          {(filterShop !== "all" || filterStatus !== "all" || filterChannel !== "all") && (
            <button
              onClick={() => { setFilterShop("all"); setFilterStatus("all"); setFilterChannel("all"); }}
              className="flex items-center gap-1 px-2 py-1.5 text-xs text-gray-500 hover:text-gray-700"
            >
              <X className="w-3 h-3" /> Clear
            </button>
          )}
        </div>
      )}

      <div className="bg-white rounded-xl shadow-sm border border-gray-100">
        <div className="divide-y divide-gray-100">
          {filtered.length === 0 ? (
            <div className="p-12 text-center text-gray-500">
              <MessageSquare className="w-12 h-12 mx-auto mb-4 opacity-50" />
              <p className="mb-2">No conversations found</p>
              <p className="text-sm">Adjust your filters or search query</p>
            </div>
          ) : (
            filtered.map((conv) => {
              const StatusIcon = statusConfig[conv.status].icon;
              return (
                <div
                  key={conv.id}
                  onClick={() => setSelected(conv)}
                  className="p-4 hover:bg-gray-50 cursor-pointer transition-colors flex items-center gap-4"
                >
                  <div className="flex-shrink-0 w-10 h-10 rounded-full bg-blue-100 text-blue-600 flex items-center justify-center font-medium text-sm">
                    {conv.contactName.split(" ").map((n) => n[0]).join("").slice(0, 2)}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-0.5">
                      <span className="font-medium text-gray-900">{conv.contactName}</span>
                      <span className="text-xs text-gray-400">{formatPhoneNumber(conv.phone)}</span>
                      {conv.unreadCount > 0 && (
                        <span className="flex items-center justify-center min-w-[18px] h-[18px] px-1 text-[10px] font-bold bg-blue-600 text-white rounded-full">
                          {conv.unreadCount}
                        </span>
                      )}
                    </div>
                    <p className="text-sm text-gray-500 truncate">{conv.lastMessage}</p>
                    <div className="flex items-center gap-2 mt-1">
                      <ChannelBadge channel={conv.channel} />
                      <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium ${statusConfig[conv.status].color}`}>
                        <StatusIcon className="w-2.5 h-2.5" />
                        {conv.status}
                      </span>
                      <span className="text-[10px] text-gray-400">{conv.shopName}</span>
                    </div>
                  </div>
                  <div className="flex-shrink-0 text-right">
                    <span className="text-xs text-gray-400">
                      {new Date(conv.timestamp).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "America/Chicago" })}
                    </span>
                    <ChevronRight className="w-4 h-4 text-gray-300 ml-auto mt-1" />
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
