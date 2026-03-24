"use client";

import { useState, useEffect, useCallback } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import {
  ArrowLeft, User, Mail, Phone, Building2, MapPin, Briefcase,
  Plus, Trash2, CheckCircle, Clock, AlertCircle, X,
  StickyNote, ListTodo, Link2, Edit2,
} from "lucide-react";

interface Contact {
  id: string;
  firstName: string;
  lastName: string;
  email: string | null;
  phone: string | null;
  mobile: string | null;
  title: string | null;
  department: string | null;
  status: string;
  avatar: string | null;
  notes: string | null;
  address: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  createdAt: string;
  updatedAt: string;
}

interface Assignment {
  id: string;
  agencyId?: string;
  agencyName?: string | null;
  parentOrgId?: string;
  parentOrgName?: string | null;
  accountId?: string;
  accountName?: string | null;
  locationId?: string;
  locationName?: string | null;
  roleTypeId: string | null;
  roleName: string | null;
  isPrimary: boolean | null;
  createdAt: string;
}

interface Note {
  id: string;
  content: string;
  createdBy: string | null;
  createdAt: string;
}

interface Task {
  id: string;
  title: string;
  description: string | null;
  status: string;
  priority: string;
  dueDate: string | null;
  assignedTo: string | null;
  createdAt: string;
  completedAt: string | null;
}

interface RoleType {
  id: string;
  name: string;
}

interface EntityOption {
  id: string;
  name: string;
}

export default function ContactDetailPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const [contact, setContact] = useState<Contact | null>(null);
  const [assignments, setAssignments] = useState<{ agencies: Assignment[]; parentOrgs: Assignment[]; accounts: Assignment[]; locations: Assignment[] }>({ agencies: [], parentOrgs: [], accounts: [], locations: [] });
  const [notes, setNotes] = useState<Note[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [roleTypes, setRoleTypes] = useState<RoleType[]>([]);
  const [activeTab, setActiveTab] = useState<"assignments" | "notes" | "tasks">("assignments");
  const [loading, setLoading] = useState(true);

  const [showAssignForm, setShowAssignForm] = useState(false);
  const [assignType, setAssignType] = useState("agency");
  const [assignEntityId, setAssignEntityId] = useState("");
  const [assignRoleTypeId, setAssignRoleTypeId] = useState("");
  const [assignIsPrimary, setAssignIsPrimary] = useState(false);
  const [entityOptions, setEntityOptions] = useState<EntityOption[]>([]);

  const [newNote, setNewNote] = useState("");
  const [showTaskForm, setShowTaskForm] = useState(false);
  const [taskForm, setTaskForm] = useState({ title: "", description: "", priority: "Medium", dueDate: "", assignedTo: "" });

  const [showEditForm, setShowEditForm] = useState(false);
  const [editForm, setEditForm] = useState({
    firstName: "", lastName: "", email: "", phone: "", mobile: "",
    title: "", department: "", status: "Active",
    address: "", city: "", state: "", zip: "", notes: "",
  });

  const fetchContact = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/platform-admin/crm/contacts/${id}`);
      const data = await res.json();
      if (data.ok) {
        setContact(data.contact);
        setAssignments(data.assignments);
      }
    } catch (e) { console.error(e); }
    setLoading(false);
  }, [id]);

  const fetchNotes = useCallback(async () => {
    try {
      const res = await fetch(`/api/platform-admin/crm/contacts/${id}/notes`);
      const data = await res.json();
      if (data.ok) setNotes(data.notes);
    } catch (e) { console.error(e); }
  }, [id]);

  const fetchTasks = useCallback(async () => {
    try {
      const res = await fetch(`/api/platform-admin/crm/contacts/${id}/tasks`);
      const data = await res.json();
      if (data.ok) setTasks(data.tasks);
    } catch (e) { console.error(e); }
  }, [id]);

  const fetchRoleTypes = useCallback(async () => {
    try {
      const res = await fetch("/api/platform-admin/crm/contact-role-types");
      const data = await res.json();
      if (data.ok) setRoleTypes(data.roleTypes);
    } catch (e) { console.error(e); }
  }, []);

  useEffect(() => { fetchContact(); fetchNotes(); fetchTasks(); fetchRoleTypes(); }, [fetchContact, fetchNotes, fetchTasks, fetchRoleTypes]);

  const fetchEntityOptions = async (type: string) => {
    const endpoints: Record<string, string> = {
      agency: "/api/platform-admin/crm/agencies",
      parentOrg: "/api/platform-admin/crm/parent-orgs",
      account: "/api/platform-admin/crm/accounts",
      location: "/api/platform-admin/crm/locations",
    };
    const keys: Record<string, string> = {
      agency: "agencies",
      parentOrg: "organizations",
      account: "accounts",
      location: "locations",
    };
    try {
      const res = await fetch(endpoints[type]);
      const data = await res.json();
      if (data.ok) setEntityOptions(data[keys[type]] || []);
    } catch { setEntityOptions([]); }
  };

  useEffect(() => {
    if (showAssignForm) fetchEntityOptions(assignType);
  }, [assignType, showAssignForm]);

  const handleAddAssignment = async (e: React.FormEvent) => {
    e.preventDefault();
    const res = await fetch(`/api/platform-admin/crm/contacts/${id}/assignments`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: assignType, entityId: assignEntityId, roleTypeId: assignRoleTypeId || undefined, isPrimary: assignIsPrimary }),
    });
    const data = await res.json();
    if (data.ok) { setShowAssignForm(false); setAssignEntityId(""); setAssignRoleTypeId(""); setAssignIsPrimary(false); fetchContact(); }
  };

  const handleRemoveAssignment = async (type: string, assignmentId: string) => {
    if (!confirm("Remove this assignment?")) return;
    await fetch(`/api/platform-admin/crm/contacts/${id}/assignments?type=${type}&assignmentId=${assignmentId}`, { method: "DELETE" });
    fetchContact();
  };

  const handleAddNote = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newNote.trim()) return;
    const res = await fetch(`/api/platform-admin/crm/contacts/${id}/notes`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: newNote }),
    });
    const data = await res.json();
    if (data.ok) { setNewNote(""); fetchNotes(); }
  };

  const handleDeleteNote = async (noteId: string) => {
    if (!confirm("Delete this note?")) return;
    await fetch(`/api/platform-admin/crm/contacts/${id}/notes?noteId=${noteId}`, { method: "DELETE" });
    fetchNotes();
  };

  const handleAddTask = async (e: React.FormEvent) => {
    e.preventDefault();
    const res = await fetch(`/api/platform-admin/crm/contacts/${id}/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(taskForm),
    });
    const data = await res.json();
    if (data.ok) { setShowTaskForm(false); setTaskForm({ title: "", description: "", priority: "Medium", dueDate: "", assignedTo: "" }); fetchTasks(); }
  };

  const handleCompleteTask = async (taskId: string) => {
    await fetch(`/api/platform-admin/crm/contacts/${id}/tasks`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: taskId, status: "Completed", completedAt: new Date().toISOString() }),
    });
    fetchTasks();
  };

  const handleDeleteTask = async (taskId: string) => {
    if (!confirm("Delete this task?")) return;
    await fetch(`/api/platform-admin/crm/contacts/${id}/tasks?taskId=${taskId}`, { method: "DELETE" });
    fetchTasks();
  };

  const openEditForm = () => {
    if (!contact) return;
    setEditForm({
      firstName: contact.firstName, lastName: contact.lastName,
      email: contact.email || "", phone: contact.phone || "",
      mobile: contact.mobile || "", title: contact.title || "",
      department: contact.department || "", status: contact.status,
      address: contact.address || "", city: contact.city || "",
      state: contact.state || "", zip: contact.zip || "",
      notes: contact.notes || "",
    });
    setShowEditForm(true);
  };

  const handleEditSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const res = await fetch("/api/platform-admin/crm/contacts", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, ...editForm }),
    });
    const data = await res.json();
    if (data.ok) { setShowEditForm(false); fetchContact(); }
  };

  if (loading) return <div className="p-6 text-center text-gray-500">Loading contact...</div>;
  if (!contact) return <div className="p-6 text-center text-gray-500">Contact not found</div>;

  const renderAssignmentList = (items: Assignment[], type: string, nameKey: string) => (
    <div className="space-y-2">
      {items.length === 0 ? (
        <p className="text-sm text-gray-400 italic">No {type} assignments</p>
      ) : items.map((a) => (
        <div key={a.id} className="flex items-center justify-between bg-gray-50 rounded-lg p-3">
          <div>
            <p className="font-medium text-gray-900 text-sm">{(a as any)[nameKey] || "Unknown"}</p>
            <div className="flex items-center gap-2 mt-0.5">
              {a.roleName && <span className="text-xs bg-blue-100 text-blue-700 px-2 py-0.5 rounded-full">{a.roleName}</span>}
              {a.isPrimary && <span className="text-xs bg-amber-100 text-amber-700 px-2 py-0.5 rounded-full">Primary</span>}
            </div>
          </div>
          <button onClick={() => handleRemoveAssignment(type, a.id)} className="p-1 text-gray-400 hover:text-red-500">
            <Trash2 className="w-4 h-4" />
          </button>
        </div>
      ))}
    </div>
  );

  const priorityColors: Record<string, string> = { Low: "text-gray-500", Medium: "text-blue-500", High: "text-orange-500", Urgent: "text-red-500" };

  return (
    <div className="p-6 max-w-5xl mx-auto">
      <div className="mb-6">
        <Link href="/platform-admin/crm/contacts" className="inline-flex items-center gap-1 text-sm text-gray-500 hover:text-gray-700 mb-4">
          <ArrowLeft className="w-4 h-4" /> Back to Contacts
        </Link>
        <div className="flex items-start justify-between">
          <div className="flex items-center gap-4">
            <div className="w-16 h-16 rounded-full bg-blue-100 flex items-center justify-center text-blue-600 font-bold text-xl">
              {contact.firstName[0]}{contact.lastName[0]}
            </div>
            <div>
              <h1 className="text-2xl font-bold text-gray-900">{contact.firstName} {contact.lastName}</h1>
              <div className="flex items-center gap-3 mt-1 text-sm text-gray-500">
                {contact.title && <span className="flex items-center gap-1"><Briefcase className="w-3.5 h-3.5" />{contact.title}</span>}
                {contact.department && <span>{contact.department}</span>}
              </div>
              <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium mt-2 ${
                contact.status === "Active" ? "bg-green-100 text-green-700" : "bg-gray-100 text-gray-700"
              }`}>{contact.status}</span>
            </div>
          </div>
          <button onClick={openEditForm} className="flex items-center gap-2 px-4 py-2 border border-gray-300 rounded-lg hover:bg-gray-50 text-sm">
            <Edit2 className="w-4 h-4" /> Edit
          </button>
        </div>
      </div>

      <div className="grid grid-cols-3 gap-4 mb-6">
        {contact.email && (
          <div className="bg-white rounded-lg border p-4 flex items-center gap-3">
            <Mail className="w-5 h-5 text-gray-400" />
            <div>
              <p className="text-xs text-gray-500">Email</p>
              <p className="text-sm font-medium text-gray-900">{contact.email}</p>
            </div>
          </div>
        )}
        {contact.phone && (
          <div className="bg-white rounded-lg border p-4 flex items-center gap-3">
            <Phone className="w-5 h-5 text-gray-400" />
            <div>
              <p className="text-xs text-gray-500">Phone</p>
              <p className="text-sm font-medium text-gray-900">{contact.phone}</p>
            </div>
          </div>
        )}
        {contact.mobile && (
          <div className="bg-white rounded-lg border p-4 flex items-center gap-3">
            <Phone className="w-5 h-5 text-gray-400" />
            <div>
              <p className="text-xs text-gray-500">Mobile</p>
              <p className="text-sm font-medium text-gray-900">{contact.mobile}</p>
            </div>
          </div>
        )}
        {(contact.address || contact.city) && (
          <div className="bg-white rounded-lg border p-4 flex items-center gap-3">
            <MapPin className="w-5 h-5 text-gray-400" />
            <div>
              <p className="text-xs text-gray-500">Address</p>
              <p className="text-sm font-medium text-gray-900">{[contact.address, contact.city, contact.state, contact.zip].filter(Boolean).join(", ")}</p>
            </div>
          </div>
        )}
      </div>

      <div className="bg-white rounded-lg border">
        <div className="border-b flex">
          {(["assignments", "notes", "tasks"] as const).map((tab) => (
            <button key={tab} onClick={() => setActiveTab(tab)}
              className={`px-6 py-3 text-sm font-medium border-b-2 transition-colors ${
                activeTab === tab ? "border-blue-600 text-blue-600" : "border-transparent text-gray-500 hover:text-gray-700"
              }`}>
              {tab === "assignments" && <><Link2 className="w-4 h-4 inline mr-1.5" />Entity Assignments</>}
              {tab === "notes" && <><StickyNote className="w-4 h-4 inline mr-1.5" />Notes ({notes.length})</>}
              {tab === "tasks" && <><ListTodo className="w-4 h-4 inline mr-1.5" />Tasks ({tasks.length})</>}
            </button>
          ))}
        </div>

        <div className="p-6">
          {activeTab === "assignments" && (
            <div>
              <div className="flex items-center justify-between mb-4">
                <h3 className="font-semibold text-gray-900">Entity Assignments</h3>
                <button onClick={() => setShowAssignForm(true)} className="flex items-center gap-1 text-sm text-blue-600 hover:text-blue-700">
                  <Plus className="w-4 h-4" /> Add Assignment
                </button>
              </div>

              {showAssignForm && (
                <form onSubmit={handleAddAssignment} className="bg-blue-50 rounded-lg p-4 mb-4 space-y-3">
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-xs font-medium text-gray-700 mb-1">Entity Type</label>
                      <select value={assignType} onChange={(e) => { setAssignType(e.target.value); setAssignEntityId(""); }}
                        className="w-full px-3 py-2 border rounded-lg text-sm">
                        <option value="agency">Agency</option>
                        <option value="parentOrg">Parent Org</option>
                        <option value="account">Account</option>
                        <option value="location">Location</option>
                      </select>
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-gray-700 mb-1">Entity</label>
                      <select value={assignEntityId} onChange={(e) => setAssignEntityId(e.target.value)} required
                        className="w-full px-3 py-2 border rounded-lg text-sm">
                        <option value="">Select...</option>
                        {entityOptions.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
                      </select>
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-xs font-medium text-gray-700 mb-1">Role</label>
                      <select value={assignRoleTypeId} onChange={(e) => setAssignRoleTypeId(e.target.value)}
                        className="w-full px-3 py-2 border rounded-lg text-sm">
                        <option value="">No Role</option>
                        {roleTypes.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
                      </select>
                    </div>
                    <div className="flex items-end">
                      <label className="flex items-center gap-2 text-sm">
                        <input type="checkbox" checked={assignIsPrimary} onChange={(e) => setAssignIsPrimary(e.target.checked)} className="rounded" />
                        Primary Contact
                      </label>
                    </div>
                  </div>
                  <div className="flex justify-end gap-2">
                    <button type="button" onClick={() => setShowAssignForm(false)} className="px-3 py-1.5 text-sm text-gray-600 hover:bg-gray-100 rounded">Cancel</button>
                    <button type="submit" className="px-3 py-1.5 text-sm bg-blue-600 text-white rounded hover:bg-blue-700">Add</button>
                  </div>
                </form>
              )}

              <div className="space-y-4">
                <div>
                  <h4 className="text-xs font-medium text-gray-500 uppercase mb-2 flex items-center gap-1"><Building2 className="w-3.5 h-3.5" /> Agencies</h4>
                  {renderAssignmentList(assignments.agencies, "agency", "agencyName")}
                </div>
                <div>
                  <h4 className="text-xs font-medium text-gray-500 uppercase mb-2 flex items-center gap-1"><Building2 className="w-3.5 h-3.5" /> Parent Orgs</h4>
                  {renderAssignmentList(assignments.parentOrgs, "parentOrg", "parentOrgName")}
                </div>
                <div>
                  <h4 className="text-xs font-medium text-gray-500 uppercase mb-2 flex items-center gap-1"><Building2 className="w-3.5 h-3.5" /> Accounts</h4>
                  {renderAssignmentList(assignments.accounts, "account", "accountName")}
                </div>
                <div>
                  <h4 className="text-xs font-medium text-gray-500 uppercase mb-2 flex items-center gap-1"><MapPin className="w-3.5 h-3.5" /> Locations</h4>
                  {renderAssignmentList(assignments.locations, "location", "locationName")}
                </div>
              </div>
            </div>
          )}

          {activeTab === "notes" && (
            <div>
              <form onSubmit={handleAddNote} className="mb-4">
                <textarea value={newNote} onChange={(e) => setNewNote(e.target.value)} placeholder="Add a note..."
                  className="w-full px-3 py-2 border rounded-lg focus:ring-2 focus:ring-blue-500 text-sm" rows={3} />
                <div className="flex justify-end mt-2">
                  <button type="submit" disabled={!newNote.trim()} className="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm hover:bg-blue-700 disabled:opacity-50">Add Note</button>
                </div>
              </form>
              <div className="space-y-3">
                {notes.length === 0 ? (
                  <p className="text-sm text-gray-400 italic text-center py-4">No notes yet</p>
                ) : notes.map((n) => (
                  <div key={n.id} className="bg-gray-50 rounded-lg p-4">
                    <div className="flex items-start justify-between">
                      <div>
                        <p className="text-sm text-gray-900 whitespace-pre-wrap">{n.content}</p>
                        <p className="text-xs text-gray-400 mt-2">{n.createdBy} · {new Date(n.createdAt).toLocaleString()}</p>
                      </div>
                      <button onClick={() => handleDeleteNote(n.id)} className="p-1 text-gray-400 hover:text-red-500">
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {activeTab === "tasks" && (
            <div>
              <div className="flex items-center justify-between mb-4">
                <h3 className="font-semibold text-gray-900">Tasks</h3>
                <button onClick={() => setShowTaskForm(true)} className="flex items-center gap-1 text-sm text-blue-600 hover:text-blue-700">
                  <Plus className="w-4 h-4" /> Add Task
                </button>
              </div>

              {showTaskForm && (
                <form onSubmit={handleAddTask} className="bg-blue-50 rounded-lg p-4 mb-4 space-y-3">
                  <div>
                    <label className="block text-xs font-medium text-gray-700 mb-1">Title *</label>
                    <input type="text" required value={taskForm.title} onChange={(e) => setTaskForm({ ...taskForm, title: e.target.value })}
                      className="w-full px-3 py-2 border rounded-lg text-sm" />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-gray-700 mb-1">Description</label>
                    <textarea value={taskForm.description} onChange={(e) => setTaskForm({ ...taskForm, description: e.target.value })}
                      className="w-full px-3 py-2 border rounded-lg text-sm" rows={2} />
                  </div>
                  <div className="grid grid-cols-3 gap-3">
                    <div>
                      <label className="block text-xs font-medium text-gray-700 mb-1">Priority</label>
                      <select value={taskForm.priority} onChange={(e) => setTaskForm({ ...taskForm, priority: e.target.value })}
                        className="w-full px-3 py-2 border rounded-lg text-sm">
                        <option value="Low">Low</option>
                        <option value="Medium">Medium</option>
                        <option value="High">High</option>
                        <option value="Urgent">Urgent</option>
                      </select>
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-gray-700 mb-1">Due Date</label>
                      <input type="date" value={taskForm.dueDate} onChange={(e) => setTaskForm({ ...taskForm, dueDate: e.target.value })}
                        className="w-full px-3 py-2 border rounded-lg text-sm" />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-gray-700 mb-1">Assigned To</label>
                      <input type="text" value={taskForm.assignedTo} onChange={(e) => setTaskForm({ ...taskForm, assignedTo: e.target.value })}
                        className="w-full px-3 py-2 border rounded-lg text-sm" />
                    </div>
                  </div>
                  <div className="flex justify-end gap-2">
                    <button type="button" onClick={() => setShowTaskForm(false)} className="px-3 py-1.5 text-sm text-gray-600 hover:bg-gray-100 rounded">Cancel</button>
                    <button type="submit" className="px-3 py-1.5 text-sm bg-blue-600 text-white rounded hover:bg-blue-700">Add Task</button>
                  </div>
                </form>
              )}

              <div className="space-y-2">
                {tasks.length === 0 ? (
                  <p className="text-sm text-gray-400 italic text-center py-4">No tasks yet</p>
                ) : tasks.map((t) => (
                  <div key={t.id} className={`flex items-start justify-between rounded-lg p-3 ${t.status === "Completed" ? "bg-green-50" : "bg-gray-50"}`}>
                    <div className="flex items-start gap-3">
                      {t.status === "Completed" ? (
                        <CheckCircle className="w-5 h-5 text-green-500 mt-0.5" />
                      ) : (
                        <button onClick={() => handleCompleteTask(t.id)} className="mt-0.5">
                          <Clock className="w-5 h-5 text-gray-400 hover:text-green-500" />
                        </button>
                      )}
                      <div>
                        <p className={`text-sm font-medium ${t.status === "Completed" ? "line-through text-gray-500" : "text-gray-900"}`}>{t.title}</p>
                        {t.description && <p className="text-xs text-gray-500 mt-0.5">{t.description}</p>}
                        <div className="flex items-center gap-2 mt-1">
                          <span className={`text-xs font-medium ${priorityColors[t.priority] || "text-gray-500"}`}>{t.priority}</span>
                          {t.dueDate && <span className="text-xs text-gray-400">Due: {new Date(t.dueDate).toLocaleDateString()}</span>}
                          {t.assignedTo && <span className="text-xs text-gray-400">→ {t.assignedTo}</span>}
                        </div>
                      </div>
                    </div>
                    <button onClick={() => handleDeleteTask(t.id)} className="p-1 text-gray-400 hover:text-red-500">
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>

      {showEditForm && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-lg max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between p-6 border-b">
              <h2 className="text-lg font-semibold">Edit Contact</h2>
              <button onClick={() => setShowEditForm(false)} className="p-1 hover:bg-gray-100 rounded"><X className="w-5 h-5" /></button>
            </div>
            <form onSubmit={handleEditSubmit} className="p-6 space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">First Name *</label>
                  <input type="text" required value={editForm.firstName} onChange={(e) => setEditForm({ ...editForm, firstName: e.target.value })}
                    className="w-full px-3 py-2 border rounded-lg focus:ring-2 focus:ring-blue-500" />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Last Name *</label>
                  <input type="text" required value={editForm.lastName} onChange={(e) => setEditForm({ ...editForm, lastName: e.target.value })}
                    className="w-full px-3 py-2 border rounded-lg focus:ring-2 focus:ring-blue-500" />
                </div>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Email</label>
                <input type="email" value={editForm.email} onChange={(e) => setEditForm({ ...editForm, email: e.target.value })}
                  className="w-full px-3 py-2 border rounded-lg focus:ring-2 focus:ring-blue-500" />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Phone</label>
                  <input type="text" value={editForm.phone} onChange={(e) => setEditForm({ ...editForm, phone: e.target.value })}
                    className="w-full px-3 py-2 border rounded-lg focus:ring-2 focus:ring-blue-500" />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Mobile</label>
                  <input type="text" value={editForm.mobile} onChange={(e) => setEditForm({ ...editForm, mobile: e.target.value })}
                    className="w-full px-3 py-2 border rounded-lg focus:ring-2 focus:ring-blue-500" />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Title</label>
                  <input type="text" value={editForm.title} onChange={(e) => setEditForm({ ...editForm, title: e.target.value })}
                    className="w-full px-3 py-2 border rounded-lg focus:ring-2 focus:ring-blue-500" />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Department</label>
                  <input type="text" value={editForm.department} onChange={(e) => setEditForm({ ...editForm, department: e.target.value })}
                    className="w-full px-3 py-2 border rounded-lg focus:ring-2 focus:ring-blue-500" />
                </div>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Status</label>
                <select value={editForm.status} onChange={(e) => setEditForm({ ...editForm, status: e.target.value })}
                  className="w-full px-3 py-2 border rounded-lg focus:ring-2 focus:ring-blue-500">
                  <option value="Active">Active</option>
                  <option value="Inactive">Inactive</option>
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Notes</label>
                <textarea value={editForm.notes} onChange={(e) => setEditForm({ ...editForm, notes: e.target.value })}
                  className="w-full px-3 py-2 border rounded-lg focus:ring-2 focus:ring-blue-500" rows={3} />
              </div>
              <div className="flex justify-end gap-3 pt-4 border-t">
                <button type="button" onClick={() => setShowEditForm(false)} className="px-4 py-2 text-gray-700 border rounded-lg hover:bg-gray-50">Cancel</button>
                <button type="submit" className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700">Save Changes</button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
