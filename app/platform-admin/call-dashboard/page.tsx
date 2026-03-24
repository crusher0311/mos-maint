"use client";

import { useState } from "react";
import {
  Phone,
  PhoneIncoming,
  PhoneForwarded,
  PhoneMissed,
  Users,
  Clock,
  TrendingUp,
  Award,
  Activity,
  Headphones,
  Coffee,
  Circle,
} from "lucide-react";

interface AgentStatus {
  id: string;
  name: string;
  status: "available" | "on-call" | "on-break" | "offline";
  currentCall: string | null;
  callDuration: number | null;
  callsHandled: number;
  avgCallDuration: number;
}

interface QueueItem {
  id: string;
  callerName: string;
  callerPhone: string;
  waitTime: number;
  priority: "normal" | "high" | "vip";
}

interface LeaderboardEntry {
  rank: number;
  agentName: string;
  group: string;
  callsHandled: number;
  callsTarget: number;
  conversionRate: number;
  conversionTarget: number;
  avgHandleTime: number;
  revenue: number;
  revenueTarget: number;
}

const DEMO_AGENTS: AgentStatus[] = [
  { id: "1", name: "Mike Johnson", status: "on-call", currentCall: "John Martinez", callDuration: 245, callsHandled: 18, avgCallDuration: 180 },
  { id: "2", name: "Sarah Chen", status: "available", currentCall: null, callDuration: null, callsHandled: 24, avgCallDuration: 155 },
  { id: "3", name: "Tom Davis", status: "on-call", currentCall: "Lisa Park", callDuration: 120, callsHandled: 15, avgCallDuration: 200 },
  { id: "4", name: "Lisa Park", status: "on-break", currentCall: null, callDuration: null, callsHandled: 20, avgCallDuration: 168 },
  { id: "5", name: "James Wilson", status: "available", currentCall: null, callDuration: null, callsHandled: 12, avgCallDuration: 195 },
  { id: "6", name: "Amy Martinez", status: "offline", currentCall: null, callDuration: null, callsHandled: 0, avgCallDuration: 0 },
];

const DEMO_QUEUE: QueueItem[] = [
  { id: "q1", callerName: "Robert Williams", callerPhone: "+1 (555) 222-3344", waitTime: 45, priority: "normal" },
  { id: "q2", callerName: "Emily Rodriguez", callerPhone: "+1 (555) 111-2233", waitTime: 120, priority: "high" },
  { id: "q3", callerName: "Unknown Caller", callerPhone: "+1 (555) 999-8877", waitTime: 15, priority: "normal" },
];

const DEMO_LEADERBOARD: LeaderboardEntry[] = [
  { rank: 1, agentName: "Sarah Chen", group: "Service Advisors", callsHandled: 55, callsTarget: 50, conversionRate: 82, conversionTarget: 75, avgHandleTime: 155, revenue: 28500, revenueTarget: 25000 },
  { rank: 2, agentName: "Lisa Park", group: "Support Team", callsHandled: 44, callsTarget: 40, conversionRate: 68, conversionTarget: 60, avgHandleTime: 168, revenue: 16200, revenueTarget: 15000 },
  { rank: 3, agentName: "Mike Johnson", group: "Service Advisors", callsHandled: 42, callsTarget: 50, conversionRate: 78, conversionTarget: 75, avgHandleTime: 180, revenue: 22100, revenueTarget: 25000 },
  { rank: 4, agentName: "Tom Davis", group: "Service Advisors", callsHandled: 38, callsTarget: 50, conversionRate: 65, conversionTarget: 75, avgHandleTime: 200, revenue: 19800, revenueTarget: 25000 },
  { rank: 5, agentName: "James Wilson", group: "Support Team", callsHandled: 35, callsTarget: 40, conversionRate: 55, conversionTarget: 60, avgHandleTime: 195, revenue: 12300, revenueTarget: 15000 },
];

const agentStatusConfig: Record<string, { label: string; color: string; dotColor: string }> = {
  available: { label: "Available", color: "text-green-700 bg-green-50", dotColor: "bg-green-500" },
  "on-call": { label: "On Call", color: "text-blue-700 bg-blue-50", dotColor: "bg-blue-500" },
  "on-break": { label: "On Break", color: "text-yellow-700 bg-yellow-50", dotColor: "bg-yellow-500" },
  offline: { label: "Offline", color: "text-gray-500 bg-gray-50", dotColor: "bg-gray-400" },
};

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function formatWaitTime(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}m ${s}s`;
}

export default function CallDashboardPage() {
  const [agents] = useState(DEMO_AGENTS);
  const [queue] = useState(DEMO_QUEUE);
  const [leaderboard] = useState(DEMO_LEADERBOARD);
  const [activeTab, setActiveTab] = useState<"overview" | "leaderboard">("overview");

  const totalCalls = agents.reduce((s, a) => s + a.callsHandled, 0);
  const activeCalls = agents.filter((a) => a.status === "on-call").length;
  const availableAgents = agents.filter((a) => a.status === "available").length;
  const avgWait = queue.length > 0 ? Math.round(queue.reduce((s, q) => s + q.waitTime, 0) / queue.length) : 0;

  return (
    <div className="p-6 max-w-6xl mx-auto space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 flex items-center gap-2">
            <Activity className="w-7 h-7 text-blue-600" />
            Call Dashboard
          </h1>
          <p className="text-gray-600">Call activity overview and agent performance</p>
        </div>
        <div className="flex items-center gap-1 bg-gray-100 rounded-lg p-1">
          <button
            onClick={() => setActiveTab("overview")}
            className={`px-3 py-1.5 text-sm rounded-md transition-colors ${activeTab === "overview" ? "bg-white shadow-sm font-medium text-gray-900" : "text-gray-600 hover:text-gray-900"}`}
          >
            Overview
          </button>
          <button
            onClick={() => setActiveTab("leaderboard")}
            className={`px-3 py-1.5 text-sm rounded-md transition-colors ${activeTab === "leaderboard" ? "bg-white shadow-sm font-medium text-gray-900" : "text-gray-600 hover:text-gray-900"}`}
          >
            Leaderboard
          </button>
        </div>
      </div>

      <div className="grid grid-cols-4 gap-4">
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-4">
          <div className="flex items-center gap-2 text-gray-500 text-sm mb-2">
            <Phone className="w-4 h-4" />
            Total Calls Today
          </div>
          <p className="text-3xl font-bold text-gray-900">{totalCalls}</p>
        </div>
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-4">
          <div className="flex items-center gap-2 text-gray-500 text-sm mb-2">
            <PhoneIncoming className="w-4 h-4" />
            Active Calls
          </div>
          <p className="text-3xl font-bold text-blue-600">{activeCalls}</p>
        </div>
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-4">
          <div className="flex items-center gap-2 text-gray-500 text-sm mb-2">
            <Users className="w-4 h-4" />
            Available Agents
          </div>
          <p className="text-3xl font-bold text-green-600">{availableAgents}</p>
        </div>
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-4">
          <div className="flex items-center gap-2 text-gray-500 text-sm mb-2">
            <Clock className="w-4 h-4" />
            Avg Queue Wait
          </div>
          <p className="text-3xl font-bold text-gray-900">{formatWaitTime(avgWait)}</p>
        </div>
      </div>

      {activeTab === "overview" && (
        <div className="grid grid-cols-2 gap-6">
          <div>
            <h2 className="text-lg font-semibold text-gray-900 mb-4 flex items-center gap-2">
              <Headphones className="w-5 h-5 text-blue-600" />
              Agent Availability
            </h2>
            <div className="bg-white rounded-xl shadow-sm border border-gray-100 divide-y divide-gray-100">
              {agents.map((agent) => {
                const cfg = agentStatusConfig[agent.status];
                return (
                  <div key={agent.id} className="p-4 flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <div className="relative">
                        <div className="w-9 h-9 rounded-full bg-blue-100 text-blue-600 flex items-center justify-center text-sm font-medium">
                          {agent.name.split(" ").map((n) => n[0]).join("")}
                        </div>
                        <span className={`absolute -bottom-0.5 -right-0.5 w-3 h-3 rounded-full border-2 border-white ${cfg.dotColor}`} />
                      </div>
                      <div>
                        <p className="font-medium text-sm text-gray-900">{agent.name}</p>
                        {agent.currentCall ? (
                          <p className="text-xs text-blue-600">On call with {agent.currentCall} ({formatDuration(agent.callDuration || 0)})</p>
                        ) : (
                          <p className="text-xs text-gray-400">{agent.callsHandled} calls today</p>
                        )}
                      </div>
                    </div>
                    <span className={`px-2 py-0.5 rounded-full text-[10px] font-medium ${cfg.color}`}>
                      {cfg.label}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>

          <div>
            <h2 className="text-lg font-semibold text-gray-900 mb-4 flex items-center gap-2">
              <Phone className="w-5 h-5 text-blue-600" />
              Call Queue ({queue.length})
            </h2>
            <div className="bg-white rounded-xl shadow-sm border border-gray-100">
              {queue.length === 0 ? (
                <div className="p-8 text-center text-gray-500">
                  <Phone className="w-10 h-10 mx-auto mb-3 opacity-50" />
                  <p className="text-sm">No calls in queue</p>
                </div>
              ) : (
                <div className="divide-y divide-gray-100">
                  {queue.map((item) => (
                    <div key={item.id} className="p-4 flex items-center justify-between">
                      <div className="flex items-center gap-3">
                        <div className={`w-2 h-2 rounded-full ${item.priority === "high" ? "bg-red-500" : item.priority === "vip" ? "bg-purple-500" : "bg-gray-400"}`} />
                        <div>
                          <p className="font-medium text-sm text-gray-900">{item.callerName}</p>
                          <p className="text-xs text-gray-400">{item.callerPhone}</p>
                        </div>
                      </div>
                      <div className="text-right">
                        <p className={`text-sm font-medium ${item.waitTime > 60 ? "text-red-600" : "text-gray-600"}`}>
                          {formatWaitTime(item.waitTime)}
                        </p>
                        {item.priority !== "normal" && (
                          <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded ${item.priority === "high" ? "bg-red-50 text-red-700" : "bg-purple-50 text-purple-700"}`}>
                            {item.priority.toUpperCase()}
                          </span>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {activeTab === "leaderboard" && (
        <div>
          <h2 className="text-lg font-semibold text-gray-900 mb-4 flex items-center gap-2">
            <Award className="w-5 h-5 text-yellow-600" />
            Agent Leaderboard
          </h2>
          <div className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden">
            <table className="w-full">
              <thead>
                <tr className="border-b border-gray-100 bg-gray-50/50">
                  <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase">Rank</th>
                  <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase">Agent</th>
                  <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase">Group</th>
                  <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase">Calls</th>
                  <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase">Conversion</th>
                  <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase">Avg Handle</th>
                  <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase">Revenue</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {leaderboard.map((entry) => {
                  const callsPct = entry.callsTarget > 0 ? (entry.callsHandled / entry.callsTarget) * 100 : 0;
                  const convPct = entry.conversionTarget > 0 ? (entry.conversionRate / entry.conversionTarget) * 100 : 0;
                  const revPct = entry.revenueTarget > 0 ? (entry.revenue / entry.revenueTarget) * 100 : 0;
                  return (
                    <tr key={entry.rank} className="hover:bg-gray-50">
                      <td className="px-4 py-3">
                        <span className={`w-7 h-7 rounded-full flex items-center justify-center text-sm font-bold ${
                          entry.rank === 1 ? "bg-yellow-100 text-yellow-700" :
                          entry.rank === 2 ? "bg-gray-100 text-gray-700" :
                          entry.rank === 3 ? "bg-orange-100 text-orange-700" :
                          "bg-gray-50 text-gray-500"
                        }`}>
                          {entry.rank}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        <span className="font-medium text-sm text-gray-900">{entry.agentName}</span>
                      </td>
                      <td className="px-4 py-3 text-sm text-gray-500">{entry.group}</td>
                      <td className="px-4 py-3">
                        <div className="text-sm text-gray-900">{entry.callsHandled} / {entry.callsTarget}</div>
                        <div className="w-20 bg-gray-100 rounded-full h-1.5 mt-1">
                          <div className={`h-1.5 rounded-full ${callsPct >= 100 ? "bg-green-500" : callsPct >= 75 ? "bg-blue-500" : "bg-red-500"}`} style={{ width: `${Math.min(callsPct, 100)}%` }} />
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        <div className={`text-sm font-medium ${convPct >= 100 ? "text-green-600" : convPct >= 80 ? "text-blue-600" : "text-red-600"}`}>
                          {entry.conversionRate}%
                        </div>
                        <div className="text-[10px] text-gray-400">Target: {entry.conversionTarget}%</div>
                      </td>
                      <td className="px-4 py-3 text-sm text-gray-600">{formatDuration(entry.avgHandleTime)}</td>
                      <td className="px-4 py-3">
                        <div className={`text-sm font-medium ${revPct >= 100 ? "text-green-600" : revPct >= 80 ? "text-blue-600" : "text-red-600"}`}>
                          ${entry.revenue.toLocaleString()}
                        </div>
                        <div className="text-[10px] text-gray-400">Target: ${entry.revenueTarget.toLocaleString()}</div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
