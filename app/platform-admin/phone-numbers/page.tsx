"use client";

import { useState } from "react";
import {
  Phone,
  Plus,
  Search,
  Edit2,
  Trash2,
  X,
  Save,
  PhoneForwarded,
  Tag,
  Building2,
} from "lucide-react";

type PhoneNumberType = "local" | "toll_free" | "mobile";
type PhoneNumberStatus = "active" | "inactive" | "pending" | "released";

interface PhoneNumber {
  id: string;
  phoneNumber: string;
  friendlyName: string;
  type: PhoneNumberType;
  status: PhoneNumberStatus;
  accountName: string;
  locationName: string;
  forwardTo: string;
  capabilities: { sms: boolean; voice: boolean; mms: boolean };
  isDefault: boolean;
}

const DEMO_NUMBERS: PhoneNumber[] = [
  {
    id: "1",
    phoneNumber: "+15551234567",
    friendlyName: "Main Line",
    type: "local",
    status: "active",
    accountName: "Downtown Auto Care",
    locationName: "Main Shop",
    forwardTo: "+15559876543",
    capabilities: { sms: true, voice: true, mms: true },
    isDefault: true,
  },
  {
    id: "2",
    phoneNumber: "+18005551234",
    friendlyName: "Toll Free Support",
    type: "toll_free",
    status: "active",
    accountName: "Downtown Auto Care",
    locationName: "All Locations",
    forwardTo: "+15551234567",
    capabilities: { sms: true, voice: true, mms: false },
    isDefault: false,
  },
  {
    id: "3",
    phoneNumber: "+15557778899",
    friendlyName: "Westside Line",
    type: "local",
    status: "active",
    accountName: "Westside Motors",
    locationName: "Westside Shop",
    forwardTo: "",
    capabilities: { sms: true, voice: true, mms: true },
    isDefault: true,
  },
  {
    id: "4",
    phoneNumber: "+15552223344",
    friendlyName: "SMS Only",
    type: "mobile",
    status: "inactive",
    accountName: "Downtown Auto Care",
    locationName: "Express Lane",
    forwardTo: "",
    capabilities: { sms: true, voice: false, mms: true },
    isDefault: false,
  },
];

const statusColors: Record<PhoneNumberStatus, string> = {
  active: "text-green-700 bg-green-50 border-green-200",
  inactive: "text-gray-500 bg-gray-50 border-gray-200",
  pending: "text-yellow-700 bg-yellow-50 border-yellow-200",
  released: "text-red-700 bg-red-50 border-red-200",
};

const typeLabels: Record<PhoneNumberType, string> = {
  local: "Local",
  toll_free: "Toll-Free",
  mobile: "Mobile",
};

export default function PhoneNumbersPage() {
  const [numbers, setNumbers] = useState<PhoneNumber[]>(DEMO_NUMBERS);
  const [searchQuery, setSearchQuery] = useState("");
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [formData, setFormData] = useState({
    phoneNumber: "",
    friendlyName: "",
    type: "local" as PhoneNumberType,
    status: "active" as PhoneNumberStatus,
    accountName: "",
    locationName: "",
    forwardTo: "",
  });

  const filtered = numbers.filter((n) => {
    if (!searchQuery) return true;
    const q = searchQuery.toLowerCase();
    return (
      n.phoneNumber.includes(q) ||
      n.friendlyName.toLowerCase().includes(q) ||
      n.accountName.toLowerCase().includes(q) ||
      n.locationName.toLowerCase().includes(q)
    );
  });

  const openForm = (number?: PhoneNumber) => {
    if (number) {
      setEditingId(number.id);
      setFormData({
        phoneNumber: number.phoneNumber,
        friendlyName: number.friendlyName,
        type: number.type,
        status: number.status,
        accountName: number.accountName,
        locationName: number.locationName,
        forwardTo: number.forwardTo,
      });
    } else {
      setEditingId(null);
      setFormData({
        phoneNumber: "",
        friendlyName: "",
        type: "local",
        status: "active",
        accountName: "",
        locationName: "",
        forwardTo: "",
      });
    }
    setShowForm(true);
  };

  const saveNumber = () => {
    if (editingId) {
      setNumbers((prev) =>
        prev.map((n) =>
          n.id === editingId
            ? { ...n, ...formData }
            : n
        )
      );
    } else {
      setNumbers((prev) => [
        ...prev,
        {
          id: `new-${Date.now()}`,
          ...formData,
          capabilities: { sms: true, voice: true, mms: true },
          isDefault: false,
        },
      ]);
    }
    setShowForm(false);
  };

  const deleteNumber = (id: string) => {
    setNumbers((prev) => prev.filter((n) => n.id !== id));
  };

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 flex items-center gap-2">
            <Phone className="w-7 h-7 text-blue-600" />
            Phone Numbers
          </h1>
          <p className="text-gray-600">Manage phone numbers assigned to accounts and locations</p>
        </div>
        <button
          onClick={() => openForm()}
          className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors text-sm"
        >
          <Plus className="w-4 h-4" />
          Add Number
        </button>
      </div>

      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
        <input
          type="text"
          placeholder="Search by number, name, account, or location..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="w-full pl-10 pr-4 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
      </div>

      {showForm && (
        <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-semibold text-gray-900">
              {editingId ? "Edit Phone Number" : "Add Phone Number"}
            </h2>
            <button onClick={() => setShowForm(false)} className="text-gray-400 hover:text-gray-600">
              <X className="w-5 h-5" />
            </button>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Phone Number</label>
              <input
                type="tel"
                value={formData.phoneNumber}
                onChange={(e) => setFormData({ ...formData, phoneNumber: e.target.value })}
                placeholder="+15551234567"
                className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Friendly Name</label>
              <input
                type="text"
                value={formData.friendlyName}
                onChange={(e) => setFormData({ ...formData, friendlyName: e.target.value })}
                placeholder="Main Line"
                className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Type</label>
              <select
                value={formData.type}
                onChange={(e) => setFormData({ ...formData, type: e.target.value as PhoneNumberType })}
                className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
              >
                <option value="local">Local</option>
                <option value="toll_free">Toll-Free</option>
                <option value="mobile">Mobile</option>
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Status</label>
              <select
                value={formData.status}
                onChange={(e) => setFormData({ ...formData, status: e.target.value as PhoneNumberStatus })}
                className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
              >
                <option value="active">Active</option>
                <option value="inactive">Inactive</option>
                <option value="pending">Pending</option>
                <option value="released">Released</option>
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Account</label>
              <input
                type="text"
                value={formData.accountName}
                onChange={(e) => setFormData({ ...formData, accountName: e.target.value })}
                placeholder="Account name"
                className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Location</label>
              <input
                type="text"
                value={formData.locationName}
                onChange={(e) => setFormData({ ...formData, locationName: e.target.value })}
                placeholder="Location name"
                className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
            <div className="col-span-2">
              <label className="block text-sm font-medium text-gray-700 mb-1">Forward To</label>
              <input
                type="tel"
                value={formData.forwardTo}
                onChange={(e) => setFormData({ ...formData, forwardTo: e.target.value })}
                placeholder="+15559876543 (optional)"
                className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
          </div>
          <div className="flex justify-end gap-2 mt-4">
            <button
              onClick={() => setShowForm(false)}
              className="px-4 py-2 text-sm text-gray-600 hover:text-gray-800"
            >
              Cancel
            </button>
            <button
              onClick={saveNumber}
              className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors text-sm"
            >
              <Save className="w-4 h-4" />
              {editingId ? "Update" : "Add"} Number
            </button>
          </div>
        </div>
      )}

      <div className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden">
        <table className="w-full">
          <thead>
            <tr className="border-b border-gray-100 bg-gray-50/50">
              <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase">Number</th>
              <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase">Account / Location</th>
              <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase">Type</th>
              <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase">Status</th>
              <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase">Capabilities</th>
              <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase">Forward To</th>
              <th className="w-20"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {filtered.length === 0 ? (
              <tr>
                <td colSpan={7} className="p-12 text-center text-gray-500">
                  <Phone className="w-12 h-12 mx-auto mb-4 opacity-50" />
                  <p className="mb-2">No phone numbers found</p>
                  <p className="text-sm">Add a phone number to get started</p>
                </td>
              </tr>
            ) : (
              filtered.map((num) => (
                <tr key={num.id} className="hover:bg-gray-50 transition-colors">
                  <td className="px-4 py-3">
                    <div className="font-medium text-gray-900 text-sm">{num.phoneNumber}</div>
                    <div className="text-xs text-gray-400 flex items-center gap-1">
                      <Tag className="w-3 h-3" />
                      {num.friendlyName}
                      {num.isDefault && (
                        <span className="ml-1 px-1.5 py-0.5 text-[10px] font-medium bg-blue-50 text-blue-700 rounded">Default</span>
                      )}
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <div className="text-sm text-gray-900 flex items-center gap-1">
                      <Building2 className="w-3.5 h-3.5 text-gray-400" />
                      {num.accountName}
                    </div>
                    <div className="text-xs text-gray-400">{num.locationName}</div>
                  </td>
                  <td className="px-4 py-3 text-sm text-gray-600">{typeLabels[num.type]}</td>
                  <td className="px-4 py-3">
                    <span className={`px-2 py-0.5 rounded-full text-xs font-medium border ${statusColors[num.status]}`}>
                      {num.status}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex gap-1">
                      {num.capabilities.voice && <span className="px-1.5 py-0.5 text-[10px] bg-gray-100 text-gray-600 rounded">Voice</span>}
                      {num.capabilities.sms && <span className="px-1.5 py-0.5 text-[10px] bg-gray-100 text-gray-600 rounded">SMS</span>}
                      {num.capabilities.mms && <span className="px-1.5 py-0.5 text-[10px] bg-gray-100 text-gray-600 rounded">MMS</span>}
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    {num.forwardTo ? (
                      <span className="text-sm text-gray-600 flex items-center gap-1">
                        <PhoneForwarded className="w-3.5 h-3.5 text-gray-400" />
                        {num.forwardTo}
                      </span>
                    ) : (
                      <span className="text-xs text-gray-400">None</span>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-1">
                      <button
                        onClick={() => openForm(num)}
                        className="p-1.5 text-gray-400 hover:text-blue-600 rounded transition-colors"
                      >
                        <Edit2 className="w-4 h-4" />
                      </button>
                      <button
                        onClick={() => deleteNumber(num.id)}
                        className="p-1.5 text-gray-400 hover:text-red-600 rounded transition-colors"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
