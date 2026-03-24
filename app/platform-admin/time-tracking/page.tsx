"use client";

import { useState } from "react";
import {
  Clock,
  Play,
  Square,
  Coffee,
  Search,
  Filter,
  X,
  User,
} from "lucide-react";

type ShiftStatus = "clocked-in" | "on-break" | "clocked-out";

interface TimeEntry {
  id: string;
  agentName: string;
  agentEmail: string;
  status: ShiftStatus;
  clockIn: string;
  clockOut: string | null;
  breakStart: string | null;
  totalBreakMinutes: number;
  notes: string;
}

const DEMO_ENTRIES: TimeEntry[] = [
  {
    id: "t1",
    agentName: "Mike Johnson",
    agentEmail: "mike@shop.com",
    status: "clocked-in",
    clockIn: "2026-03-24T08:00:00Z",
    clockOut: null,
    breakStart: null,
    totalBreakMinutes: 30,
    notes: "",
  },
  {
    id: "t2",
    agentName: "Sarah Chen",
    agentEmail: "sarah@shop.com",
    status: "on-break",
    clockIn: "2026-03-24T07:30:00Z",
    clockOut: null,
    breakStart: "2026-03-24T12:00:00Z",
    totalBreakMinutes: 0,
    notes: "Lunch break",
  },
  {
    id: "t3",
    agentName: "Tom Davis",
    agentEmail: "tom@shop.com",
    status: "clocked-in",
    clockIn: "2026-03-24T09:00:00Z",
    clockOut: null,
    breakStart: null,
    totalBreakMinutes: 15,
    notes: "",
  },
  {
    id: "t4",
    agentName: "Lisa Park",
    agentEmail: "lisa@shop.com",
    status: "clocked-out",
    clockIn: "2026-03-24T06:00:00Z",
    clockOut: "2026-03-24T14:00:00Z",
    breakStart: null,
    totalBreakMinutes: 45,
    notes: "Early shift",
  },
  {
    id: "t5",
    agentName: "James Wilson",
    agentEmail: "james@shop.com",
    status: "clocked-out",
    clockIn: "2026-03-23T08:00:00Z",
    clockOut: "2026-03-23T17:00:00Z",
    breakStart: null,
    totalBreakMinutes: 60,
    notes: "",
  },
  {
    id: "t6",
    agentName: "Mike Johnson",
    agentEmail: "mike@shop.com",
    status: "clocked-out",
    clockIn: "2026-03-23T07:30:00Z",
    clockOut: "2026-03-23T16:30:00Z",
    breakStart: null,
    totalBreakMinutes: 30,
    notes: "",
  },
];

const statusConfig: Record<ShiftStatus, { label: string; color: string; bgColor: string }> = {
  "clocked-in": { label: "Clocked In", color: "text-green-700", bgColor: "bg-green-50 border-green-200" },
  "on-break": { label: "On Break", color: "text-yellow-700", bgColor: "bg-yellow-50 border-yellow-200" },
  "clocked-out": { label: "Clocked Out", color: "text-gray-500", bgColor: "bg-gray-50 border-gray-200" },
};

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function calcHours(clockIn: string, clockOut: string | null, breakMin: number): string {
  const end = clockOut ? new Date(clockOut).getTime() : Date.now();
  const totalMin = (end - new Date(clockIn).getTime()) / 60000 - breakMin;
  const h = Math.floor(totalMin / 60);
  const m = Math.round(totalMin % 60);
  return `${h}h ${m}m`;
}

export default function TimeTrackingPage() {
  const [entries, setEntries] = useState<TimeEntry[]>(DEMO_ENTRIES);
  const [searchQuery, setSearchQuery] = useState("");
  const [filterStatus, setFilterStatus] = useState<ShiftStatus | "all">("all");
  const [showFilters, setShowFilters] = useState(false);
  const [clockInName, setClockInName] = useState("");
  const [clockInEmail, setClockInEmail] = useState("");
  const [showClockIn, setShowClockIn] = useState(false);

  const activeEntries = entries.filter((e) => e.status !== "clocked-out");
  const historyEntries = entries.filter((e) => e.status === "clocked-out");

  const filtered = (filterStatus === "all" ? entries : entries.filter((e) => e.status === filterStatus)).filter((e) => {
    if (!searchQuery) return true;
    const q = searchQuery.toLowerCase();
    return e.agentName.toLowerCase().includes(q) || e.agentEmail.toLowerCase().includes(q);
  });

  const handleClockIn = () => {
    if (!clockInName.trim()) return;
    setEntries((prev) => [
      {
        id: `t-${Date.now()}`,
        agentName: clockInName,
        agentEmail: clockInEmail,
        status: "clocked-in",
        clockIn: new Date().toISOString(),
        clockOut: null,
        breakStart: null,
        totalBreakMinutes: 0,
        notes: "",
      },
      ...prev,
    ]);
    setClockInName("");
    setClockInEmail("");
    setShowClockIn(false);
  };

  const handleClockOut = (id: string) => {
    setEntries((prev) =>
      prev.map((e) =>
        e.id === id ? { ...e, status: "clocked-out" as ShiftStatus, clockOut: new Date().toISOString(), breakStart: null } : e
      )
    );
  };

  const handleBreakStart = (id: string) => {
    setEntries((prev) =>
      prev.map((e) =>
        e.id === id ? { ...e, status: "on-break" as ShiftStatus, breakStart: new Date().toISOString() } : e
      )
    );
  };

  const handleBreakEnd = (id: string) => {
    setEntries((prev) =>
      prev.map((e) => {
        if (e.id !== id || !e.breakStart) return e;
        const breakMin = Math.round((Date.now() - new Date(e.breakStart).getTime()) / 60000);
        return {
          ...e,
          status: "clocked-in" as ShiftStatus,
          breakStart: null,
          totalBreakMinutes: e.totalBreakMinutes + breakMin,
        };
      })
    );
  };

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 flex items-center gap-2">
            <Clock className="w-7 h-7 text-blue-600" />
            Time Tracking
          </h1>
          <p className="text-gray-600">Agent clock in/out and break management</p>
        </div>
        <button
          onClick={() => setShowClockIn(!showClockIn)}
          className="flex items-center gap-2 px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 transition-colors text-sm"
        >
          <Play className="w-4 h-4" />
          Clock In
        </button>
      </div>

      {showClockIn && (
        <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6">
          <h2 className="text-lg font-semibold text-gray-900 mb-4">Clock In</h2>
          <div className="grid grid-cols-3 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Agent Name</label>
              <input
                type="text"
                value={clockInName}
                onChange={(e) => setClockInName(e.target.value)}
                placeholder="Agent name"
                className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Email</label>
              <input
                type="email"
                value={clockInEmail}
                onChange={(e) => setClockInEmail(e.target.value)}
                placeholder="agent@shop.com"
                className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
            <div className="flex items-end gap-2">
              <button onClick={() => setShowClockIn(false)} className="px-4 py-2 text-sm text-gray-600 hover:text-gray-800">Cancel</button>
              <button onClick={handleClockIn} className="flex items-center gap-2 px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 text-sm">
                <Play className="w-4 h-4" /> Clock In
              </button>
            </div>
          </div>
        </div>
      )}

      {activeEntries.length > 0 && (
        <div>
          <h2 className="text-sm font-medium text-gray-500 uppercase tracking-wide mb-3">Currently Active ({activeEntries.length})</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {activeEntries.map((entry) => (
              <div key={entry.id} className={`bg-white rounded-xl shadow-sm border p-4 ${entry.status === "on-break" ? "border-yellow-200" : "border-green-200"}`}>
                <div className="flex items-center justify-between mb-3">
                  <div className="flex items-center gap-2">
                    <div className="w-8 h-8 rounded-full bg-blue-100 text-blue-600 flex items-center justify-center text-sm font-medium">
                      {entry.agentName.split(" ").map((n) => n[0]).join("")}
                    </div>
                    <div>
                      <p className="font-medium text-gray-900 text-sm">{entry.agentName}</p>
                      <p className="text-xs text-gray-400">{entry.agentEmail}</p>
                    </div>
                  </div>
                  <span className={`px-2 py-0.5 rounded-full text-[10px] font-medium border ${statusConfig[entry.status].bgColor} ${statusConfig[entry.status].color}`}>
                    {statusConfig[entry.status].label}
                  </span>
                </div>
                <div className="space-y-1 text-sm text-gray-600 mb-3">
                  <div className="flex justify-between">
                    <span>Clock In:</span>
                    <span className="font-medium">{formatTime(entry.clockIn)}</span>
                  </div>
                  <div className="flex justify-between">
                    <span>Working:</span>
                    <span className="font-medium">{calcHours(entry.clockIn, null, entry.totalBreakMinutes)}</span>
                  </div>
                  <div className="flex justify-between">
                    <span>Breaks:</span>
                    <span className="font-medium">{entry.totalBreakMinutes}m</span>
                  </div>
                </div>
                <div className="flex gap-2">
                  {entry.status === "clocked-in" && (
                    <>
                      <button
                        onClick={() => handleBreakStart(entry.id)}
                        className="flex-1 flex items-center justify-center gap-1 px-3 py-1.5 text-xs bg-yellow-50 text-yellow-700 border border-yellow-200 rounded-lg hover:bg-yellow-100 transition-colors"
                      >
                        <Coffee className="w-3.5 h-3.5" /> Break
                      </button>
                      <button
                        onClick={() => handleClockOut(entry.id)}
                        className="flex-1 flex items-center justify-center gap-1 px-3 py-1.5 text-xs bg-red-50 text-red-700 border border-red-200 rounded-lg hover:bg-red-100 transition-colors"
                      >
                        <Square className="w-3.5 h-3.5" /> Clock Out
                      </button>
                    </>
                  )}
                  {entry.status === "on-break" && (
                    <button
                      onClick={() => handleBreakEnd(entry.id)}
                      className="flex-1 flex items-center justify-center gap-1 px-3 py-1.5 text-xs bg-green-50 text-green-700 border border-green-200 rounded-lg hover:bg-green-100 transition-colors"
                    >
                      <Play className="w-3.5 h-3.5" /> End Break
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      <div>
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-medium text-gray-500 uppercase tracking-wide">Shift History</h2>
          <div className="flex items-center gap-2">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
              <input
                type="text"
                placeholder="Search agents..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="pl-9 pr-3 py-1.5 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 w-48"
              />
            </div>
          </div>
        </div>

        <div className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden">
          <table className="w-full">
            <thead>
              <tr className="border-b border-gray-100 bg-gray-50/50">
                <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase">Agent</th>
                <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase">Date</th>
                <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase">Clock In</th>
                <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase">Clock Out</th>
                <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase">Breaks</th>
                <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase">Total</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {historyEntries.filter((e) => {
                if (!searchQuery) return true;
                const q = searchQuery.toLowerCase();
                return e.agentName.toLowerCase().includes(q);
              }).length === 0 ? (
                <tr>
                  <td colSpan={6} className="p-12 text-center text-gray-500">
                    <Clock className="w-12 h-12 mx-auto mb-4 opacity-50" />
                    <p>No shift history found</p>
                  </td>
                </tr>
              ) : (
                historyEntries
                  .filter((e) => {
                    if (!searchQuery) return true;
                    const q = searchQuery.toLowerCase();
                    return e.agentName.toLowerCase().includes(q);
                  })
                  .map((entry) => (
                    <tr key={entry.id} className="hover:bg-gray-50">
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2">
                          <User className="w-4 h-4 text-gray-400" />
                          <div>
                            <div className="font-medium text-sm text-gray-900">{entry.agentName}</div>
                            <div className="text-xs text-gray-400">{entry.agentEmail}</div>
                          </div>
                        </div>
                      </td>
                      <td className="px-4 py-3 text-sm text-gray-600">{formatDate(entry.clockIn)}</td>
                      <td className="px-4 py-3 text-sm text-gray-600">{formatTime(entry.clockIn)}</td>
                      <td className="px-4 py-3 text-sm text-gray-600">{entry.clockOut ? formatTime(entry.clockOut) : "-"}</td>
                      <td className="px-4 py-3 text-sm text-gray-600">{entry.totalBreakMinutes}m</td>
                      <td className="px-4 py-3 text-sm font-medium text-gray-900">
                        {entry.clockOut ? calcHours(entry.clockIn, entry.clockOut, entry.totalBreakMinutes) : "-"}
                      </td>
                    </tr>
                  ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
