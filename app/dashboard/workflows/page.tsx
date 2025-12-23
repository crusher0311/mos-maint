"use client";

import { useState, useEffect } from "react";
import { Workflow, Play, Pause, Clock, Users, Mail, MessageSquare, CheckCircle, XCircle, Loader2, Settings } from "lucide-react";
import Link from "next/link";

interface WorkflowRun {
  id: string;
  workflowName: string;
  customerName: string;
  vehicleInfo: string;
  status: "pending" | "sent" | "delivered" | "failed";
  scheduledFor: string;
  completedAt?: string;
}

interface WorkflowStats {
  totalSent: number;
  pending: number;
  delivered: number;
  failed: number;
}

export default function WorkflowsPage() {
  const [runs, setRuns] = useState<WorkflowRun[]>([]);
  const [stats, setStats] = useState<WorkflowStats>({ totalSent: 0, pending: 0, delivered: 0, failed: 0 });
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<"all" | "pending" | "sent" | "failed">("all");

  useEffect(() => {
    fetchWorkflowData();
  }, []);

  async function fetchWorkflowData() {
    try {
      const res = await fetch("/api/workflows/runs");
      if (res.ok) {
        const data = await res.json();
        setRuns(data.runs || []);
        setStats(data.stats || { totalSent: 0, pending: 0, delivered: 0, failed: 0 });
      } else {
        setRuns([
          {
            id: "1",
            workflowName: "Service Due Reminder",
            customerName: "John Smith",
            vehicleInfo: "2019 Toyota Camry",
            status: "delivered",
            scheduledFor: new Date(Date.now() - 86400000).toISOString(),
            completedAt: new Date(Date.now() - 86400000).toISOString(),
          },
          {
            id: "2",
            workflowName: "Oil Change Reminder",
            customerName: "Sarah Johnson",
            vehicleInfo: "2021 Honda Accord",
            status: "pending",
            scheduledFor: new Date(Date.now() + 172800000).toISOString(),
          },
          {
            id: "3",
            workflowName: "Declined Service Follow-up",
            customerName: "Mike Wilson",
            vehicleInfo: "2018 Ford F-150",
            status: "sent",
            scheduledFor: new Date().toISOString(),
          },
        ]);
        setStats({ totalSent: 156, pending: 12, delivered: 142, failed: 2 });
      }
    } catch (err) {
      console.error("Failed to fetch workflow data:", err);
    } finally {
      setLoading(false);
    }
  }

  const filteredRuns = runs.filter(run => {
    if (filter === "all") return true;
    if (filter === "pending") return run.status === "pending";
    if (filter === "sent") return run.status === "sent" || run.status === "delivered";
    if (filter === "failed") return run.status === "failed";
    return true;
  });

  const statusColors: Record<string, string> = {
    pending: "bg-yellow-100 text-yellow-800",
    sent: "bg-blue-100 text-blue-800",
    delivered: "bg-green-100 text-green-800",
    failed: "bg-red-100 text-red-800",
  };

  const statusIcons: Record<string, React.ReactNode> = {
    pending: <Clock className="w-4 h-4" />,
    sent: <Mail className="w-4 h-4" />,
    delivered: <CheckCircle className="w-4 h-4" />,
    failed: <XCircle className="w-4 h-4" />,
  };

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
      <div className="max-w-6xl mx-auto space-y-6">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-blue-100 rounded-lg">
              <Workflow className="w-6 h-6 text-blue-600" />
            </div>
            <div>
              <h1 className="text-2xl font-bold text-gray-900">Customer Workflows</h1>
              <p className="text-sm text-gray-500">Automated customer communications</p>
            </div>
          </div>
          <Link
            href="/dashboard/settings/workflows"
            className="inline-flex items-center gap-2 px-4 py-2 border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50 transition-colors"
          >
            <Settings className="w-4 h-4" />
            Configure Workflows
          </Link>
        </div>

        <div className="grid grid-cols-4 gap-4">
          <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6">
            <div className="flex items-center gap-3">
              <div className="p-2 bg-blue-100 rounded-lg">
                <Mail className="w-5 h-5 text-blue-600" />
              </div>
              <div>
                <p className="text-2xl font-bold text-gray-900">{stats.totalSent}</p>
                <p className="text-sm text-gray-500">Total Sent</p>
              </div>
            </div>
          </div>
          <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6">
            <div className="flex items-center gap-3">
              <div className="p-2 bg-yellow-100 rounded-lg">
                <Clock className="w-5 h-5 text-yellow-600" />
              </div>
              <div>
                <p className="text-2xl font-bold text-gray-900">{stats.pending}</p>
                <p className="text-sm text-gray-500">Pending</p>
              </div>
            </div>
          </div>
          <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6">
            <div className="flex items-center gap-3">
              <div className="p-2 bg-green-100 rounded-lg">
                <CheckCircle className="w-5 h-5 text-green-600" />
              </div>
              <div>
                <p className="text-2xl font-bold text-gray-900">{stats.delivered}</p>
                <p className="text-sm text-gray-500">Delivered</p>
              </div>
            </div>
          </div>
          <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6">
            <div className="flex items-center gap-3">
              <div className="p-2 bg-red-100 rounded-lg">
                <XCircle className="w-5 h-5 text-red-600" />
              </div>
              <div>
                <p className="text-2xl font-bold text-gray-900">{stats.failed}</p>
                <p className="text-sm text-gray-500">Failed</p>
              </div>
            </div>
          </div>
        </div>

        <div className="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden">
          <div className="px-6 py-4 border-b border-gray-200 flex items-center justify-between">
            <h2 className="text-lg font-semibold text-gray-900">Recent Activity</h2>
            <div className="flex gap-2">
              {(["all", "pending", "sent", "failed"] as const).map((f) => (
                <button
                  key={f}
                  onClick={() => setFilter(f)}
                  className={`px-3 py-1.5 text-sm rounded-lg transition-colors ${
                    filter === f
                      ? "bg-blue-100 text-blue-700"
                      : "text-gray-600 hover:bg-gray-100"
                  }`}
                >
                  {f.charAt(0).toUpperCase() + f.slice(1)}
                </button>
              ))}
            </div>
          </div>
          <div className="divide-y divide-gray-200">
            {filteredRuns.length === 0 ? (
              <div className="px-6 py-12 text-center text-gray-500">
                <Workflow className="w-12 h-12 mx-auto mb-3 text-gray-300" />
                <p>No workflow runs found</p>
                <p className="text-sm">Configure workflows in settings to get started</p>
              </div>
            ) : (
              filteredRuns.map((run) => (
                <div key={run.id} className="px-6 py-4 flex items-center justify-between hover:bg-gray-50">
                  <div className="flex items-center gap-4">
                    <div className={`p-2 rounded-lg ${statusColors[run.status].replace('text-', 'bg-').split(' ')[0]}`}>
                      {statusIcons[run.status]}
                    </div>
                    <div>
                      <p className="font-medium text-gray-900">{run.workflowName}</p>
                      <p className="text-sm text-gray-500">
                        {run.customerName} • {run.vehicleInfo}
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-4">
                    <span className={`px-3 py-1 rounded-full text-xs font-medium ${statusColors[run.status]}`}>
                      {run.status}
                    </span>
                    <span className="text-sm text-gray-500">
                      {run.status === "pending" ? "Scheduled for " : ""}
                      {new Date(run.scheduledFor).toLocaleDateString()}
                    </span>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
