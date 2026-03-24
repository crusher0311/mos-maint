"use client";

import { useState } from "react";
import {
  Phone,
  Search,
  Filter,
  ArrowLeft,
  PhoneIncoming,
  PhoneForwarded,
  Voicemail,
  PhoneMissed,
  X,
  Calendar,
  DollarSign,
  Clock,
} from "lucide-react";
import { TranscriptViewer } from "@/components/communications/TranscriptViewer";
import { formatPhoneNumber } from "@/components/communications/PhoneFormatter";

type Outcome = "answered" | "transferred" | "voicemail" | "missed";

interface CostBreakdown {
  deepgram: number;
  openai: number;
  total: number;
}

interface CallLog {
  id: string;
  callerName: string | null;
  phone: string;
  duration: number;
  outcome: Outcome;
  cost: CostBreakdown;
  timestamp: string;
  shopName: string;
  transcript: { speaker: "caller" | "agent" | "system"; text: string; timestamp?: string }[];
}

const DEMO_CALLS: CallLog[] = [
  {
    id: "c1",
    callerName: "John Martinez",
    phone: "5551234567",
    duration: 185,
    outcome: "answered",
    cost: { deepgram: 0.012, openai: 0.045, total: 0.057 },
    timestamp: "2026-03-24T14:30:00Z",
    shopName: "Downtown Auto Care",
    transcript: [
      { speaker: "agent", text: "Thank you for calling Downtown Auto Care! This is Rescue Rover, your virtual assistant. How can I help you today?", timestamp: "0:00" },
      { speaker: "caller", text: "Hi, I need to check on my brake job. I dropped my Honda Civic off this morning.", timestamp: "0:05" },
      { speaker: "agent", text: "I'd be happy to help you check on that! Can I get your name please?", timestamp: "0:10" },
      { speaker: "caller", text: "John Martinez.", timestamp: "0:14" },
      { speaker: "agent", text: "Thank you, John. Let me look that up for you. I can see your 2019 Honda Civic is in for brake pad and rotor replacement. It looks like the work is currently in progress and should be completed by end of day.", timestamp: "0:16" },
      { speaker: "caller", text: "Great, can I pick it up around 5?", timestamp: "0:28" },
      { speaker: "agent", text: "That should work perfectly. We close at 6 PM today. I'll make a note that you'll be picking up around 5 PM. Is there anything else I can help with?", timestamp: "0:31" },
      { speaker: "caller", text: "No, that's all. Thanks!", timestamp: "0:40" },
      { speaker: "agent", text: "You're welcome, John! We'll see you at 5. Have a great day!", timestamp: "0:42" },
    ],
  },
  {
    id: "c2",
    callerName: null,
    phone: "5554443322",
    duration: 92,
    outcome: "transferred",
    cost: { deepgram: 0.006, openai: 0.022, total: 0.028 },
    timestamp: "2026-03-24T11:00:00Z",
    shopName: "Downtown Auto Care",
    transcript: [
      { speaker: "agent", text: "Thank you for calling Downtown Auto Care! This is Rescue Rover. How can I help you?", timestamp: "0:00" },
      { speaker: "caller", text: "Yeah, my brakes are squealing really bad and I need to get them looked at today.", timestamp: "0:04" },
      { speaker: "agent", text: "I understand that can be concerning. Let me connect you with a service advisor who can check our availability for today.", timestamp: "0:10" },
      { speaker: "system", text: "Call transferred to service desk.", timestamp: "0:15" },
    ],
  },
  {
    id: "c3",
    callerName: "David Thompson",
    phone: "5557778899",
    duration: 0,
    outcome: "voicemail",
    cost: { deepgram: 0, openai: 0, total: 0 },
    timestamp: "2026-03-24T08:30:00Z",
    shopName: "Westside Motors",
    transcript: [],
  },
  {
    id: "c4",
    callerName: "Emily Rodriguez",
    phone: "5551112233",
    duration: 45,
    outcome: "answered",
    cost: { deepgram: 0.003, openai: 0.015, total: 0.018 },
    timestamp: "2026-03-23T16:00:00Z",
    shopName: "Downtown Auto Care",
    transcript: [
      { speaker: "agent", text: "Thank you for calling Downtown Auto Care! How can I help you today?", timestamp: "0:00" },
      { speaker: "caller", text: "Hi, I just want to confirm my appointment for Thursday at 9 AM for a tire rotation.", timestamp: "0:04" },
      { speaker: "agent", text: "Let me check that for you. Yes, I can confirm your appointment for Thursday, March 26th at 9:00 AM for a tire rotation. You're all set!", timestamp: "0:09" },
      { speaker: "caller", text: "Perfect, thank you!", timestamp: "0:18" },
    ],
  },
  {
    id: "c5",
    callerName: null,
    phone: "5553339999",
    duration: 0,
    outcome: "missed",
    cost: { deepgram: 0, openai: 0, total: 0 },
    timestamp: "2026-03-23T07:45:00Z",
    shopName: "Westside Motors",
    transcript: [],
  },
];

const outcomeConfig: Record<Outcome, { label: string; icon: typeof Phone; color: string }> = {
  answered: { label: "Answered", icon: PhoneIncoming, color: "text-green-600 bg-green-50" },
  transferred: { label: "Transferred", icon: PhoneForwarded, color: "text-blue-600 bg-blue-50" },
  voicemail: { label: "Voicemail", icon: Voicemail, color: "text-orange-600 bg-orange-50" },
  missed: { label: "Missed", icon: PhoneMissed, color: "text-red-600 bg-red-50" },
};

function formatDuration(seconds: number): string {
  if (seconds === 0) return "-";
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

export default function CallLogsPage() {
  const [calls] = useState<CallLog[]>(DEMO_CALLS);
  const [selected, setSelected] = useState<CallLog | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [filterOutcome, setFilterOutcome] = useState<Outcome | "all">("all");
  const [showFilters, setShowFilters] = useState(false);

  const filtered = calls.filter((c) => {
    if (filterOutcome !== "all" && c.outcome !== filterOutcome) return false;
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      return (
        (c.callerName?.toLowerCase().includes(q) ?? false) ||
        c.phone.includes(q)
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
          Back to Call Logs
        </button>

        <div className="bg-white rounded-xl shadow-sm border border-gray-100">
          <div className="p-6 border-b border-gray-100">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-lg font-semibold text-gray-900">
                  {selected.callerName || "Unknown Caller"}
                </h2>
                <span className="text-sm text-gray-500">{formatPhoneNumber(selected.phone)}</span>
              </div>
              <span className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium ${outcomeConfig[selected.outcome].color}`}>
                {(() => { const Icon = outcomeConfig[selected.outcome].icon; return <Icon className="w-3.5 h-3.5" />; })()}
                {outcomeConfig[selected.outcome].label}
              </span>
            </div>
            <div className="flex items-center gap-4 mt-3 text-sm text-gray-500">
              <span className="flex items-center gap-1">
                <Clock className="w-3.5 h-3.5" />
                {formatDuration(selected.duration)}
              </span>
              <span className="flex items-center gap-1">
                <Calendar className="w-3.5 h-3.5" />
                {new Date(selected.timestamp).toLocaleString("en-US", {
                  weekday: "short",
                  month: "short",
                  day: "numeric",
                  hour: "numeric",
                  minute: "2-digit",
                })}
              </span>
              <span>{selected.shopName}</span>
            </div>
          </div>

          <div className="p-6 border-b border-gray-100">
            <h3 className="text-sm font-medium text-gray-700 mb-3">Cost Breakdown</h3>
            <div className="grid grid-cols-3 gap-4">
              <div className="bg-gray-50 rounded-lg p-3 text-center">
                <p className="text-xs text-gray-500 mb-1">Deepgram (STT)</p>
                <p className="text-lg font-semibold text-gray-900">${selected.cost.deepgram.toFixed(3)}</p>
              </div>
              <div className="bg-gray-50 rounded-lg p-3 text-center">
                <p className="text-xs text-gray-500 mb-1">OpenAI (LLM)</p>
                <p className="text-lg font-semibold text-gray-900">${selected.cost.openai.toFixed(3)}</p>
              </div>
              <div className="bg-blue-50 rounded-lg p-3 text-center border border-blue-100">
                <p className="text-xs text-blue-600 mb-1">Total Cost</p>
                <p className="text-lg font-semibold text-blue-700">${selected.cost.total.toFixed(3)}</p>
              </div>
            </div>
          </div>

          <div className="p-6">
            <h3 className="text-sm font-medium text-gray-700 mb-3">Conversation Transcript</h3>
            <TranscriptViewer turns={selected.transcript} maxHeight="500px" />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900 flex items-center gap-2">
          <Phone className="w-7 h-7 text-blue-600" />
          Call Logs
        </h1>
        <p className="text-gray-600">Rescue Rover call history and transcripts</p>
      </div>

      <div className="flex items-center gap-3">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
          <input
            type="text"
            placeholder="Search by caller or phone number..."
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
            value={filterOutcome}
            onChange={(e) => setFilterOutcome(e.target.value as Outcome | "all")}
            className="px-3 py-1.5 border border-gray-200 rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
            <option value="all">All Outcomes</option>
            <option value="answered">Answered</option>
            <option value="transferred">Transferred</option>
            <option value="voicemail">Voicemail</option>
            <option value="missed">Missed</option>
          </select>
          {filterOutcome !== "all" && (
            <button
              onClick={() => setFilterOutcome("all")}
              className="flex items-center gap-1 px-2 py-1.5 text-xs text-gray-500 hover:text-gray-700"
            >
              <X className="w-3 h-3" /> Clear
            </button>
          )}
        </div>
      )}

      <div className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden">
        <table className="w-full">
          <thead>
            <tr className="border-b border-gray-100 bg-gray-50/50">
              <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase">Caller</th>
              <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase">Duration</th>
              <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase">Outcome</th>
              <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase">Cost</th>
              <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase">Time</th>
              <th className="w-10"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {filtered.length === 0 ? (
              <tr>
                <td colSpan={6} className="p-12 text-center text-gray-500">
                  <Phone className="w-12 h-12 mx-auto mb-4 opacity-50" />
                  <p className="mb-2">No call logs found</p>
                  <p className="text-sm">Adjust your filters or search query</p>
                </td>
              </tr>
            ) : (
              filtered.map((call) => {
                const OutcomeIcon = outcomeConfig[call.outcome].icon;
                return (
                  <tr
                    key={call.id}
                    onClick={() => setSelected(call)}
                    className="hover:bg-gray-50 cursor-pointer transition-colors"
                  >
                    <td className="px-4 py-3">
                      <div className="font-medium text-gray-900 text-sm">
                        {call.callerName || "Unknown Caller"}
                      </div>
                      <div className="text-xs text-gray-400">{formatPhoneNumber(call.phone)}</div>
                    </td>
                    <td className="px-4 py-3 text-sm text-gray-600">{formatDuration(call.duration)}</td>
                    <td className="px-4 py-3">
                      <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium ${outcomeConfig[call.outcome].color}`}>
                        <OutcomeIcon className="w-3 h-3" />
                        {outcomeConfig[call.outcome].label}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <span className="text-sm text-gray-600">
                        {call.cost.total > 0 ? `$${call.cost.total.toFixed(3)}` : "-"}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-xs text-gray-400">
                      {new Date(call.timestamp).toLocaleString("en-US", {
                        month: "short",
                        day: "numeric",
                        hour: "numeric",
                        minute: "2-digit",
                      })}
                    </td>
                    <td className="px-4 py-3">
                      <Phone className="w-4 h-4 text-gray-300" />
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
