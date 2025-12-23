"use client";

import { useState, useEffect } from "react";
import { Workflow, Save, Loader2, Plus, Trash2, Mail, MessageSquare, Bell } from "lucide-react";

interface WorkflowTrigger {
  id: string;
  name: string;
  trigger: "service_due" | "declined_service" | "inspection_failed" | "appointment_reminder";
  channel: "email" | "sms" | "both";
  timing: string;
  enabled: boolean;
  template?: string;
}

const exampleWorkflows: WorkflowTrigger[] = [
  {
    id: "example_1",
    name: "Service Due Reminder",
    trigger: "service_due",
    channel: "email",
    timing: "7 days before",
    enabled: true,
  },
  {
    id: "example_2",
    name: "Declined Service Follow-up",
    trigger: "declined_service",
    channel: "email",
    timing: "30 days after",
    enabled: false,
  },
  {
    id: "example_3",
    name: "Inspection Alert",
    trigger: "inspection_failed",
    channel: "sms",
    timing: "Immediately",
    enabled: true,
  },
];

const triggerLabels: Record<string, string> = {
  service_due: "Service Due",
  declined_service: "Declined Service",
  inspection_failed: "Failed Inspection",
  appointment_reminder: "Appointment Reminder",
};

const channelIcons: Record<string, React.ReactNode> = {
  email: <Mail className="w-4 h-4" />,
  sms: <MessageSquare className="w-4 h-4" />,
  both: <Bell className="w-4 h-4" />,
};

export default function WorkflowsSettingsPage() {
  const [workflows, setWorkflows] = useState<WorkflowTrigger[]>([]);
  const [hasData, setHasData] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [showAddForm, setShowAddForm] = useState(false);
  const [newWorkflow, setNewWorkflow] = useState<Partial<WorkflowTrigger>>({
    name: "",
    trigger: "service_due",
    channel: "email",
    timing: "",
  });

  useEffect(() => {
    fetchWorkflows();
  }, []);

  async function fetchWorkflows() {
    try {
      const res = await fetch("/api/settings/workflows");
      if (res.ok) {
        const data = await res.json();
        if (data.workflows?.length) {
          setWorkflows(data.workflows);
          setHasData(true);
        }
      }
    } catch (err) {
      console.error("Failed to fetch workflows:", err);
    } finally {
      setLoading(false);
    }
  }

  async function handleSave() {
    setSaving(true);
    try {
      await fetch("/api/settings/workflows", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workflows }),
      });
    } catch (err) {
      console.error("Failed to save workflows:", err);
    } finally {
      setSaving(false);
    }
  }

  function toggleWorkflow(id: string) {
    setWorkflows(workflows.map(w =>
      w.id === id ? { ...w, enabled: !w.enabled } : w
    ));
  }

  function removeWorkflow(id: string) {
    setWorkflows(workflows.filter(w => w.id !== id));
  }

  function addWorkflow() {
    if (!newWorkflow.name || !newWorkflow.timing) return;
    const workflow: WorkflowTrigger = {
      id: Date.now().toString(),
      name: newWorkflow.name,
      trigger: newWorkflow.trigger as any,
      channel: newWorkflow.channel as any,
      timing: newWorkflow.timing,
      enabled: true,
    };
    setWorkflows([...workflows, workflow]);
    setNewWorkflow({ name: "", trigger: "service_due", channel: "email", timing: "" });
    setShowAddForm(false);
  }

  if (loading) {
    return (
      <div className="flex-1 p-8">
        <div className="flex items-center justify-center h-64">
          <Loader2 className="w-8 h-8 animate-spin text-blue-600" />
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 p-8 overflow-auto">
      <div className="max-w-4xl mx-auto space-y-6">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-blue-100 rounded-lg">
              <Workflow className="w-6 h-6 text-blue-600" />
            </div>
            <div>
              <h1 className="text-2xl font-bold text-gray-900">Customer Workflows</h1>
              <p className="text-sm text-gray-500">Automate customer communications</p>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <button
              onClick={() => setShowAddForm(true)}
              className="inline-flex items-center gap-2 px-4 py-2 border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50 transition-colors"
            >
              <Plus className="w-4 h-4" />
              Add Workflow
            </button>
            <button
              onClick={handleSave}
              disabled={saving}
              className="inline-flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 transition-colors"
            >
              {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
              Save Changes
            </button>
          </div>
        </div>

        {showAddForm && (
          <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6">
            <h3 className="text-lg font-semibold text-gray-900 mb-4">Create New Workflow</h3>
            <div className="grid gap-4 md:grid-cols-2">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Workflow Name</label>
                <input
                  type="text"
                  value={newWorkflow.name}
                  onChange={(e) => setNewWorkflow({ ...newWorkflow, name: e.target.value })}
                  placeholder="e.g., Oil Change Reminder"
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Trigger</label>
                <select
                  value={newWorkflow.trigger}
                  onChange={(e) => setNewWorkflow({ ...newWorkflow, trigger: e.target.value as any })}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                >
                  <option value="service_due">Service Due</option>
                  <option value="declined_service">Declined Service</option>
                  <option value="inspection_failed">Failed Inspection</option>
                  <option value="appointment_reminder">Appointment Reminder</option>
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Channel</label>
                <select
                  value={newWorkflow.channel}
                  onChange={(e) => setNewWorkflow({ ...newWorkflow, channel: e.target.value as any })}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                >
                  <option value="email">Email</option>
                  <option value="sms">SMS</option>
                  <option value="both">Both</option>
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Timing</label>
                <input
                  type="text"
                  value={newWorkflow.timing}
                  onChange={(e) => setNewWorkflow({ ...newWorkflow, timing: e.target.value })}
                  placeholder="e.g., 7 days before"
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                />
              </div>
            </div>
            <div className="flex justify-end gap-3 mt-4">
              <button
                onClick={() => setShowAddForm(false)}
                className="px-4 py-2 text-gray-700 hover:bg-gray-100 rounded-lg transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={addWorkflow}
                disabled={!newWorkflow.name || !newWorkflow.timing}
                className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 transition-colors"
              >
                Create Workflow
              </button>
            </div>
          </div>
        )}

        <div className="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden">
          <div className="px-6 py-4 border-b border-gray-200">
            <h2 className="text-lg font-semibold text-gray-900">Active Workflows</h2>
          </div>
          <div className="divide-y divide-gray-200">
            {workflows.length === 0 ? (
              <div className="px-6 py-8 text-center text-gray-500">
                No workflows configured yet
              </div>
            ) : (
              workflows.map((workflow) => (
                <div key={workflow.id} className="px-6 py-4 flex items-center justify-between">
                  <div className="flex items-center gap-4">
                    <button
                      onClick={() => toggleWorkflow(workflow.id)}
                      className={`w-10 h-6 rounded-full transition-colors ${
                        workflow.enabled ? "bg-blue-600" : "bg-gray-300"
                      }`}
                    >
                      <div className={`w-4 h-4 rounded-full bg-white shadow transform transition-transform ${
                        workflow.enabled ? "translate-x-5" : "translate-x-1"
                      }`} />
                    </button>
                    <div>
                      <p className="font-medium text-gray-900">{workflow.name}</p>
                      <div className="flex items-center gap-3 text-sm text-gray-500">
                        <span className="px-2 py-0.5 bg-gray-100 rounded text-xs">
                          {triggerLabels[workflow.trigger]}
                        </span>
                        <span className="flex items-center gap-1">
                          {channelIcons[workflow.channel]}
                          {workflow.channel}
                        </span>
                        <span>{workflow.timing}</span>
                      </div>
                    </div>
                  </div>
                  <button
                    onClick={() => removeWorkflow(workflow.id)}
                    className="p-2 text-gray-400 hover:text-red-600 transition-colors"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              ))
            )}
          </div>
        </div>

        <div className="bg-blue-50 rounded-xl p-6 border border-blue-100">
          <h3 className="font-semibold text-blue-900 mb-2">How Workflows Work</h3>
          <ul className="space-y-2 text-sm text-blue-800">
            <li><strong>Service Due:</strong> Sends reminders when maintenance is coming due</li>
            <li><strong>Declined Service:</strong> Follows up on services the customer declined</li>
            <li><strong>Failed Inspection:</strong> Alerts for urgent safety issues found during DVI</li>
            <li><strong>Appointment Reminder:</strong> Confirms upcoming scheduled appointments</li>
          </ul>
        </div>
      </div>
    </div>
  );
}
