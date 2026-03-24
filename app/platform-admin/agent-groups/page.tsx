"use client";

import { useState } from "react";
import {
  Users,
  Plus,
  Search,
  Edit2,
  Trash2,
  X,
  Save,
  Target,
  UserPlus,
  ChevronDown,
  ChevronRight,
  TrendingUp,
} from "lucide-react";

interface AgentTarget {
  id: string;
  agentName: string;
  agentEmail: string;
  callsTarget: number;
  conversionTarget: number;
  revenueTarget: number;
  callsActual: number;
  conversionActual: number;
  revenueActual: number;
  period: string;
}

interface Group {
  id: string;
  name: string;
  description: string;
  status: "active" | "inactive";
  agents: AgentTarget[];
}

const DEMO_GROUPS: Group[] = [
  {
    id: "1",
    name: "Service Advisors",
    description: "Front-line service team handling customer intake",
    status: "active",
    agents: [
      { id: "a1", agentName: "Mike Johnson", agentEmail: "mike@shop.com", callsTarget: 50, conversionTarget: 75, revenueTarget: 25000, callsActual: 42, conversionActual: 78, revenueActual: 22100, period: "monthly" },
      { id: "a2", agentName: "Sarah Chen", agentEmail: "sarah@shop.com", callsTarget: 50, conversionTarget: 75, revenueTarget: 25000, callsActual: 55, conversionActual: 82, revenueActual: 28500, period: "monthly" },
      { id: "a3", agentName: "Tom Davis", agentEmail: "tom@shop.com", callsTarget: 50, conversionTarget: 75, revenueTarget: 25000, callsActual: 38, conversionActual: 65, revenueActual: 19800, period: "monthly" },
    ],
  },
  {
    id: "2",
    name: "Support Team",
    description: "Customer support and follow-up specialists",
    status: "active",
    agents: [
      { id: "a4", agentName: "Lisa Park", agentEmail: "lisa@shop.com", callsTarget: 40, conversionTarget: 60, revenueTarget: 15000, callsActual: 44, conversionActual: 68, revenueActual: 16200, period: "monthly" },
      { id: "a5", agentName: "James Wilson", agentEmail: "james@shop.com", callsTarget: 40, conversionTarget: 60, revenueTarget: 15000, callsActual: 35, conversionActual: 55, revenueActual: 12300, period: "monthly" },
    ],
  },
  {
    id: "3",
    name: "Evening Crew",
    description: "After-hours call handling team",
    status: "inactive",
    agents: [],
  },
];

function ProgressBar({ actual, target, color }: { actual: number; target: number; color: string }) {
  const pct = target > 0 ? Math.min((actual / target) * 100, 100) : 0;
  return (
    <div className="w-full bg-gray-100 rounded-full h-2">
      <div className={`h-2 rounded-full ${color}`} style={{ width: `${pct}%` }} />
    </div>
  );
}

export default function AgentGroupsPage() {
  const [groups, setGroups] = useState<Group[]>(DEMO_GROUPS);
  const [searchQuery, setSearchQuery] = useState("");
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set(["1"]));
  const [showGroupForm, setShowGroupForm] = useState(false);
  const [showAgentForm, setShowAgentForm] = useState<string | null>(null);
  const [editingGroupId, setEditingGroupId] = useState<string | null>(null);
  const [groupForm, setGroupForm] = useState({ name: "", description: "", status: "active" as "active" | "inactive" });
  const [agentForm, setAgentForm] = useState({
    agentName: "", agentEmail: "", callsTarget: 50, conversionTarget: 75, revenueTarget: 25000, period: "monthly",
  });

  const toggleGroup = (id: string) => {
    const next = new Set(expandedGroups);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setExpandedGroups(next);
  };

  const filtered = groups.filter((g) => {
    if (!searchQuery) return true;
    const q = searchQuery.toLowerCase();
    return g.name.toLowerCase().includes(q) || g.description.toLowerCase().includes(q);
  });

  const openGroupForm = (group?: Group) => {
    if (group) {
      setEditingGroupId(group.id);
      setGroupForm({ name: group.name, description: group.description, status: group.status });
    } else {
      setEditingGroupId(null);
      setGroupForm({ name: "", description: "", status: "active" });
    }
    setShowGroupForm(true);
  };

  const saveGroup = () => {
    if (editingGroupId) {
      setGroups((prev) => prev.map((g) => g.id === editingGroupId ? { ...g, ...groupForm } : g));
    } else {
      setGroups((prev) => [...prev, { id: `new-${Date.now()}`, ...groupForm, agents: [] }]);
    }
    setShowGroupForm(false);
  };

  const deleteGroup = (id: string) => {
    setGroups((prev) => prev.filter((g) => g.id !== id));
  };

  const addAgent = (groupId: string) => {
    setGroups((prev) =>
      prev.map((g) =>
        g.id === groupId
          ? {
              ...g,
              agents: [
                ...g.agents,
                {
                  id: `a-${Date.now()}`,
                  ...agentForm,
                  callsActual: 0,
                  conversionActual: 0,
                  revenueActual: 0,
                },
              ],
            }
          : g
      )
    );
    setShowAgentForm(null);
    setAgentForm({ agentName: "", agentEmail: "", callsTarget: 50, conversionTarget: 75, revenueTarget: 25000, period: "monthly" });
  };

  const removeAgent = (groupId: string, agentId: string) => {
    setGroups((prev) =>
      prev.map((g) =>
        g.id === groupId ? { ...g, agents: g.agents.filter((a) => a.id !== agentId) } : g
      )
    );
  };

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 flex items-center gap-2">
            <Users className="w-7 h-7 text-blue-600" />
            Agent Groups
          </h1>
          <p className="text-gray-600">Organize agents into groups with performance targets</p>
        </div>
        <button
          onClick={() => openGroupForm()}
          className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors text-sm"
        >
          <Plus className="w-4 h-4" />
          New Group
        </button>
      </div>

      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
        <input
          type="text"
          placeholder="Search groups..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="w-full pl-10 pr-4 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
      </div>

      {showGroupForm && (
        <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-semibold text-gray-900">
              {editingGroupId ? "Edit Group" : "Create Group"}
            </h2>
            <button onClick={() => setShowGroupForm(false)} className="text-gray-400 hover:text-gray-600">
              <X className="w-5 h-5" />
            </button>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Group Name</label>
              <input
                type="text"
                value={groupForm.name}
                onChange={(e) => setGroupForm({ ...groupForm, name: e.target.value })}
                placeholder="Service Advisors"
                className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Status</label>
              <select
                value={groupForm.status}
                onChange={(e) => setGroupForm({ ...groupForm, status: e.target.value as "active" | "inactive" })}
                className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
              >
                <option value="active">Active</option>
                <option value="inactive">Inactive</option>
              </select>
            </div>
            <div className="col-span-2">
              <label className="block text-sm font-medium text-gray-700 mb-1">Description</label>
              <input
                type="text"
                value={groupForm.description}
                onChange={(e) => setGroupForm({ ...groupForm, description: e.target.value })}
                placeholder="Team description..."
                className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
          </div>
          <div className="flex justify-end gap-2 mt-4">
            <button onClick={() => setShowGroupForm(false)} className="px-4 py-2 text-sm text-gray-600 hover:text-gray-800">Cancel</button>
            <button onClick={saveGroup} className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors text-sm">
              <Save className="w-4 h-4" />
              {editingGroupId ? "Update" : "Create"} Group
            </button>
          </div>
        </div>
      )}

      <div className="space-y-4">
        {filtered.length === 0 ? (
          <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-12 text-center text-gray-500">
            <Users className="w-12 h-12 mx-auto mb-4 opacity-50" />
            <p className="mb-2">No groups found</p>
            <p className="text-sm">Create a group to organize your agents</p>
          </div>
        ) : (
          filtered.map((group) => (
            <div key={group.id} className="bg-white rounded-xl shadow-sm border border-gray-100">
              <div
                className="flex items-center justify-between p-4 cursor-pointer hover:bg-gray-50 transition-colors"
                onClick={() => toggleGroup(group.id)}
              >
                <div className="flex items-center gap-3">
                  {expandedGroups.has(group.id) ? (
                    <ChevronDown className="w-5 h-5 text-gray-400" />
                  ) : (
                    <ChevronRight className="w-5 h-5 text-gray-400" />
                  )}
                  <div>
                    <div className="flex items-center gap-2">
                      <h3 className="font-semibold text-gray-900">{group.name}</h3>
                      <span className={`px-2 py-0.5 rounded-full text-[10px] font-medium border ${
                        group.status === "active" ? "text-green-700 bg-green-50 border-green-200" : "text-gray-500 bg-gray-50 border-gray-200"
                      }`}>
                        {group.status}
                      </span>
                    </div>
                    <p className="text-sm text-gray-500">{group.description}</p>
                  </div>
                </div>
                <div className="flex items-center gap-3">
                  <span className="text-sm text-gray-400">{group.agents.length} agents</span>
                  <button
                    onClick={(e) => { e.stopPropagation(); openGroupForm(group); }}
                    className="p-1.5 text-gray-400 hover:text-blue-600 rounded transition-colors"
                  >
                    <Edit2 className="w-4 h-4" />
                  </button>
                  <button
                    onClick={(e) => { e.stopPropagation(); deleteGroup(group.id); }}
                    className="p-1.5 text-gray-400 hover:text-red-600 rounded transition-colors"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              </div>

              {expandedGroups.has(group.id) && (
                <div className="border-t border-gray-100">
                  {group.agents.length > 0 && (
                    <div className="overflow-x-auto">
                      <table className="w-full">
                        <thead>
                          <tr className="bg-gray-50/50">
                            <th className="text-left px-4 py-2.5 text-xs font-medium text-gray-500 uppercase">Agent</th>
                            <th className="text-left px-4 py-2.5 text-xs font-medium text-gray-500 uppercase">Calls</th>
                            <th className="text-left px-4 py-2.5 text-xs font-medium text-gray-500 uppercase">Conversion</th>
                            <th className="text-left px-4 py-2.5 text-xs font-medium text-gray-500 uppercase">Revenue</th>
                            <th className="w-10"></th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-gray-100">
                          {group.agents.map((agent) => (
                            <tr key={agent.id} className="hover:bg-gray-50">
                              <td className="px-4 py-3">
                                <div className="font-medium text-sm text-gray-900">{agent.agentName}</div>
                                <div className="text-xs text-gray-400">{agent.agentEmail}</div>
                              </td>
                              <td className="px-4 py-3">
                                <div className="text-sm text-gray-900">{agent.callsActual} / {agent.callsTarget}</div>
                                <ProgressBar actual={agent.callsActual} target={agent.callsTarget} color="bg-blue-500" />
                              </td>
                              <td className="px-4 py-3">
                                <div className="text-sm text-gray-900">{agent.conversionActual}% / {agent.conversionTarget}%</div>
                                <ProgressBar actual={agent.conversionActual} target={agent.conversionTarget} color="bg-green-500" />
                              </td>
                              <td className="px-4 py-3">
                                <div className="text-sm text-gray-900">${agent.revenueActual.toLocaleString()} / ${agent.revenueTarget.toLocaleString()}</div>
                                <ProgressBar actual={agent.revenueActual} target={agent.revenueTarget} color="bg-purple-500" />
                              </td>
                              <td className="px-4 py-3">
                                <button
                                  onClick={() => removeAgent(group.id, agent.id)}
                                  className="p-1 text-gray-400 hover:text-red-600 rounded transition-colors"
                                >
                                  <Trash2 className="w-3.5 h-3.5" />
                                </button>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}

                  {showAgentForm === group.id ? (
                    <div className="p-4 border-t border-gray-100 bg-gray-50/50">
                      <h4 className="text-sm font-medium text-gray-700 mb-3">Add Agent</h4>
                      <div className="grid grid-cols-3 gap-3">
                        <div>
                          <input
                            type="text"
                            value={agentForm.agentName}
                            onChange={(e) => setAgentForm({ ...agentForm, agentName: e.target.value })}
                            placeholder="Agent name"
                            className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                          />
                        </div>
                        <div>
                          <input
                            type="email"
                            value={agentForm.agentEmail}
                            onChange={(e) => setAgentForm({ ...agentForm, agentEmail: e.target.value })}
                            placeholder="Email"
                            className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                          />
                        </div>
                        <div className="flex items-center gap-2">
                          <input
                            type="number"
                            value={agentForm.callsTarget}
                            onChange={(e) => setAgentForm({ ...agentForm, callsTarget: parseInt(e.target.value) || 0 })}
                            placeholder="Calls target"
                            className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                          />
                        </div>
                        <div>
                          <input
                            type="number"
                            value={agentForm.conversionTarget}
                            onChange={(e) => setAgentForm({ ...agentForm, conversionTarget: parseInt(e.target.value) || 0 })}
                            placeholder="Conversion % target"
                            className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                          />
                        </div>
                        <div>
                          <input
                            type="number"
                            value={agentForm.revenueTarget}
                            onChange={(e) => setAgentForm({ ...agentForm, revenueTarget: parseInt(e.target.value) || 0 })}
                            placeholder="Revenue target"
                            className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                          />
                        </div>
                        <div className="flex items-center gap-2">
                          <button onClick={() => setShowAgentForm(null)} className="px-3 py-2 text-sm text-gray-600 hover:text-gray-800">Cancel</button>
                          <button onClick={() => addAgent(group.id)} className="flex items-center gap-1 px-3 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 text-sm">
                            <Plus className="w-3.5 h-3.5" /> Add
                          </button>
                        </div>
                      </div>
                    </div>
                  ) : (
                    <div className="p-3 border-t border-gray-100">
                      <button
                        onClick={() => setShowAgentForm(group.id)}
                        className="flex items-center gap-2 px-3 py-2 text-sm text-blue-600 hover:bg-blue-50 rounded-lg transition-colors"
                      >
                        <UserPlus className="w-4 h-4" />
                        Add Agent
                      </button>
                    </div>
                  )}
                </div>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
