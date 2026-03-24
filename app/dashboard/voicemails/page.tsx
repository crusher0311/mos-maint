"use client";

import { useState } from "react";
import {
  Voicemail,
  Search,
  Filter,
  ChevronRight,
  ArrowLeft,
  Eye,
  Archive,
  X,
  CheckSquare,
} from "lucide-react";
import { AudioPlayer } from "@/components/communications/AudioPlayer";
import { formatPhoneNumber } from "@/components/communications/PhoneFormatter";

type VoicemailStatus = "new" | "listened" | "archived";

interface VoicemailItem {
  id: string;
  callerName: string | null;
  phone: string;
  duration: number;
  transcription: string;
  status: VoicemailStatus;
  timestamp: string;
  shopName: string;
  audioUrl: string;
}

const DEMO_VOICEMAILS: VoicemailItem[] = [
  {
    id: "v1",
    callerName: "Sarah Johnson",
    phone: "5559876543",
    duration: 45,
    transcription: "Hi, this is Sarah Johnson. I'm calling about scheduling an oil change for my 2021 Toyota Camry. I'd like to come in sometime this week if possible. Please call me back at this number. Thanks!",
    status: "new",
    timestamp: "2026-03-24T12:15:00Z",
    shopName: "Downtown Auto Care",
    audioUrl: "",
  },
  {
    id: "v2",
    callerName: null,
    phone: "5554443322",
    duration: 32,
    transcription: "Yeah, I need to get my brakes looked at. My car is making a squealing noise when I stop. Can you fit me in today or tomorrow? My number is 555-444-3322.",
    status: "new",
    timestamp: "2026-03-24T11:00:00Z",
    shopName: "Downtown Auto Care",
    audioUrl: "",
  },
  {
    id: "v3",
    callerName: "David Thompson",
    phone: "5557778899",
    duration: 28,
    transcription: "Hello, this is David Thompson. I picked up my truck yesterday and the check engine light came back on this morning. Can someone take a look? I'll try to swing by this afternoon.",
    status: "listened",
    timestamp: "2026-03-24T08:30:00Z",
    shopName: "Westside Motors",
    audioUrl: "",
  },
  {
    id: "v4",
    callerName: "Emily Rodriguez",
    phone: "5551112233",
    duration: 18,
    transcription: "Hi, just calling to confirm my appointment for Thursday at 9 AM for a tire rotation. Thanks!",
    status: "listened",
    timestamp: "2026-03-23T16:00:00Z",
    shopName: "Downtown Auto Care",
    audioUrl: "",
  },
  {
    id: "v5",
    callerName: "Tom Baker",
    phone: "5556665544",
    duration: 55,
    transcription: "This is Tom Baker. I got the estimate you sent over and I'd like to go ahead with the timing belt replacement but hold off on the water pump for now. Give me a call when you get a chance to discuss the timeline.",
    status: "archived",
    timestamp: "2026-03-22T14:00:00Z",
    shopName: "Westside Motors",
    audioUrl: "",
  },
];

const statusConfig: Record<VoicemailStatus, { label: string; color: string; bgColor: string }> = {
  new: { label: "New", color: "text-blue-700", bgColor: "bg-blue-50 border-blue-100" },
  listened: { label: "Listened", color: "text-gray-600", bgColor: "bg-gray-50 border-gray-100" },
  archived: { label: "Archived", color: "text-gray-400", bgColor: "bg-gray-50 border-gray-100" },
};

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

export default function VoicemailsPage() {
  const [voicemails, setVoicemails] = useState<VoicemailItem[]>(DEMO_VOICEMAILS);
  const [selected, setSelected] = useState<VoicemailItem | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [filterStatus, setFilterStatus] = useState<VoicemailStatus | "all">("all");
  const [filterShop, setFilterShop] = useState<string>("all");
  const [showFilters, setShowFilters] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  const shops = Array.from(new Set(voicemails.map((v) => v.shopName)));

  const filtered = voicemails.filter((v) => {
    if (filterStatus !== "all" && v.status !== filterStatus) return false;
    if (filterShop !== "all" && v.shopName !== filterShop) return false;
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      return (
        (v.callerName?.toLowerCase().includes(q) ?? false) ||
        v.phone.includes(q) ||
        v.transcription.toLowerCase().includes(q)
      );
    }
    return true;
  });

  const toggleSelect = (id: string) => {
    const next = new Set(selectedIds);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelectedIds(next);
  };

  const bulkUpdateStatus = (newStatus: VoicemailStatus) => {
    setVoicemails((prev) =>
      prev.map((v) => (selectedIds.has(v.id) ? { ...v, status: newStatus } : v))
    );
    setSelectedIds(new Set());
  };

  const updateStatus = (id: string, newStatus: VoicemailStatus) => {
    setVoicemails((prev) =>
      prev.map((v) => (v.id === id ? { ...v, status: newStatus } : v))
    );
    if (selected?.id === id) {
      setSelected((s) => (s ? { ...s, status: newStatus } : null));
    }
  };

  if (selected) {
    return (
      <div className="p-6 max-w-4xl mx-auto">
        <button
          onClick={() => setSelected(null)}
          className="flex items-center gap-2 text-gray-600 hover:text-gray-900 mb-4"
        >
          <ArrowLeft className="w-4 h-4" />
          Back to Voicemails
        </button>

        <div className="bg-white rounded-xl shadow-sm border border-gray-100">
          <div className="p-6 border-b border-gray-100">
            <div className="flex items-center justify-between mb-3">
              <div>
                <h2 className="text-lg font-semibold text-gray-900">
                  {selected.callerName || "Unknown Caller"}
                </h2>
                <span className="text-sm text-gray-500">{formatPhoneNumber(selected.phone)}</span>
              </div>
              <div className="flex items-center gap-2">
                <span className={`px-2.5 py-1 rounded-full text-xs font-medium border ${statusConfig[selected.status].bgColor} ${statusConfig[selected.status].color}`}>
                  {statusConfig[selected.status].label}
                </span>
              </div>
            </div>
            <div className="flex items-center gap-4 text-sm text-gray-500">
              <span>Duration: {formatDuration(selected.duration)}</span>
              <span>{selected.shopName}</span>
              <span>
                {new Date(selected.timestamp).toLocaleString("en-US", {
                  weekday: "short",
                  month: "short",
                  day: "numeric",
                  hour: "numeric",
                  minute: "2-digit",
                })}
              </span>
            </div>
          </div>

          <div className="p-6 border-b border-gray-100">
            <h3 className="text-sm font-medium text-gray-700 mb-3">Playback</h3>
            {selected.audioUrl ? (
              <AudioPlayer src={selected.audioUrl} duration={selected.duration} />
            ) : (
              <div className="bg-gray-50 rounded-lg p-4 text-center text-sm text-gray-400">
                Audio file not available for demo
              </div>
            )}
          </div>

          <div className="p-6 border-b border-gray-100">
            <h3 className="text-sm font-medium text-gray-700 mb-3">Transcription</h3>
            <p className="text-gray-800 leading-relaxed">{selected.transcription}</p>
          </div>

          <div className="p-4 flex items-center gap-2">
            {selected.status === "new" && (
              <button
                onClick={() => updateStatus(selected.id, "listened")}
                className="flex items-center gap-2 px-3 py-2 text-sm text-gray-700 hover:bg-gray-100 rounded-lg transition-colors"
              >
                <Eye className="w-4 h-4" />
                Mark as Listened
              </button>
            )}
            {selected.status !== "archived" && (
              <button
                onClick={() => updateStatus(selected.id, "archived")}
                className="flex items-center gap-2 px-3 py-2 text-sm text-gray-700 hover:bg-gray-100 rounded-lg transition-colors"
              >
                <Archive className="w-4 h-4" />
                Archive
              </button>
            )}
            {selected.status === "archived" && (
              <button
                onClick={() => updateStatus(selected.id, "listened")}
                className="flex items-center gap-2 px-3 py-2 text-sm text-gray-700 hover:bg-gray-100 rounded-lg transition-colors"
              >
                <Eye className="w-4 h-4" />
                Unarchive
              </button>
            )}
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
            <Voicemail className="w-7 h-7 text-blue-600" />
            Voicemail Inbox
          </h1>
          <p className="text-gray-600">Manage voicemail messages with transcriptions</p>
        </div>
      </div>

      <div className="flex items-center gap-3">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
          <input
            type="text"
            placeholder="Search by caller, phone, or transcription..."
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
            onChange={(e) => setFilterStatus(e.target.value as VoicemailStatus | "all")}
            className="px-3 py-1.5 border border-gray-200 rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
            <option value="all">All Statuses</option>
            <option value="new">New</option>
            <option value="listened">Listened</option>
            <option value="archived">Archived</option>
          </select>
          {(filterShop !== "all" || filterStatus !== "all") && (
            <button
              onClick={() => { setFilterShop("all"); setFilterStatus("all"); }}
              className="flex items-center gap-1 px-2 py-1.5 text-xs text-gray-500 hover:text-gray-700"
            >
              <X className="w-3 h-3" /> Clear
            </button>
          )}
        </div>
      )}

      {selectedIds.size > 0 && (
        <div className="flex items-center gap-3 bg-blue-50 rounded-lg p-3 border border-blue-100">
          <span className="text-sm text-blue-700 font-medium">{selectedIds.size} selected</span>
          <button
            onClick={() => bulkUpdateStatus("listened")}
            className="flex items-center gap-1 px-3 py-1.5 text-sm bg-white border border-gray-200 rounded-lg hover:bg-gray-50"
          >
            <Eye className="w-3.5 h-3.5" /> Mark Listened
          </button>
          <button
            onClick={() => bulkUpdateStatus("archived")}
            className="flex items-center gap-1 px-3 py-1.5 text-sm bg-white border border-gray-200 rounded-lg hover:bg-gray-50"
          >
            <Archive className="w-3.5 h-3.5" /> Archive
          </button>
          <button
            onClick={() => setSelectedIds(new Set())}
            className="ml-auto text-xs text-blue-600 hover:text-blue-800"
          >
            Clear selection
          </button>
        </div>
      )}

      <div className="bg-white rounded-xl shadow-sm border border-gray-100">
        <div className="divide-y divide-gray-100">
          {filtered.length === 0 ? (
            <div className="p-12 text-center text-gray-500">
              <Voicemail className="w-12 h-12 mx-auto mb-4 opacity-50" />
              <p className="mb-2">No voicemails found</p>
              <p className="text-sm">Adjust your filters or search query</p>
            </div>
          ) : (
            filtered.map((vm) => (
              <div
                key={vm.id}
                className={`p-4 hover:bg-gray-50 transition-colors flex items-center gap-4 ${
                  vm.status === "new" ? "bg-blue-50/30" : ""
                }`}
              >
                <label className="flex-shrink-0 cursor-pointer" onClick={(e) => e.stopPropagation()}>
                  <input
                    type="checkbox"
                    checked={selectedIds.has(vm.id)}
                    onChange={() => toggleSelect(vm.id)}
                    className="w-4 h-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                  />
                </label>
                <div
                  className="flex-1 min-w-0 cursor-pointer"
                  onClick={() => setSelected(vm)}
                >
                  <div className="flex items-center gap-2 mb-0.5">
                    {vm.status === "new" && (
                      <span className="w-2 h-2 rounded-full bg-blue-600 flex-shrink-0" />
                    )}
                    <span className={`font-medium ${vm.status === "new" ? "text-gray-900" : "text-gray-700"}`}>
                      {vm.callerName || "Unknown Caller"}
                    </span>
                    <span className="text-xs text-gray-400">{formatPhoneNumber(vm.phone)}</span>
                    <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium border ${statusConfig[vm.status].bgColor} ${statusConfig[vm.status].color}`}>
                      {statusConfig[vm.status].label}
                    </span>
                  </div>
                  <p className="text-sm text-gray-500 truncate">{vm.transcription}</p>
                  <div className="flex items-center gap-3 mt-1 text-xs text-gray-400">
                    <span>{formatDuration(vm.duration)}</span>
                    <span>{vm.shopName}</span>
                    <span>
                      {new Date(vm.timestamp).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}
                    </span>
                  </div>
                </div>
                <ChevronRight
                  className="w-4 h-4 text-gray-300 flex-shrink-0 cursor-pointer"
                  onClick={() => setSelected(vm)}
                />
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
