"use client";

import { useState, useEffect } from "react";
import { 
  Calendar, 
  Clock, 
  Settings, 
  Check, 
  X, 
  Loader2, 
  AlertCircle, 
  Plus, 
  Trash2,
  CalendarCheck,
  CalendarX,
  Users,
  Bell
} from "lucide-react";

interface Holiday {
  date: string;
  name: string;
}

interface AutoBookingSettings {
  enabled: boolean;
  leadTimeDays: number;
  blockSaturday: boolean;
  blockSunday: boolean;
  blockHolidays: boolean;
  useDefaultHolidays: boolean;
  customHolidays: Holiday[];
  businessHours: {
    start: string;
    end: string;
  };
  maxBookingsPerDay: number;
  confirmationMode: "auto" | "review";
  preferredTimeSlot: "morning" | "afternoon" | "any";
  timezone: string;
}

export default function AutoBookingSettingsPage() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [available, setAvailable] = useState(false);
  const [unavailableReason, setUnavailableReason] = useState("");
  const [settings, setSettings] = useState<AutoBookingSettings | null>(null);
  const [defaultHolidays, setDefaultHolidays] = useState<Holiday[]>([]);
  const [message, setMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);
  const [newHolidayDate, setNewHolidayDate] = useState("");
  const [newHolidayName, setNewHolidayName] = useState("");
  const [showHolidays, setShowHolidays] = useState(false);

  useEffect(() => {
    fetchSettings();
  }, []);

  async function fetchSettings() {
    try {
      const res = await fetch("/api/settings/auto-booking");
      const data = await res.json();
      
      if (data.available) {
        setAvailable(true);
        setSettings(data.settings);
        setDefaultHolidays(data.defaultHolidays || []);
      } else {
        setAvailable(false);
        setUnavailableReason(data.reason);
      }
    } catch (err) {
      setMessage({ type: "error", text: "Failed to load settings" });
    } finally {
      setLoading(false);
    }
  }

  async function saveSettings() {
    if (!settings) return;
    
    setSaving(true);
    setMessage(null);
    
    try {
      const res = await fetch("/api/settings/auto-booking", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(settings),
      });
      
      if (res.ok) {
        setMessage({ type: "success", text: "Settings saved successfully" });
      } else {
        const data = await res.json();
        setMessage({ type: "error", text: data.error || "Failed to save" });
      }
    } catch (err) {
      setMessage({ type: "error", text: "Failed to save settings" });
    } finally {
      setSaving(false);
    }
  }

  function addCustomHoliday() {
    if (!settings || !newHolidayDate || !newHolidayName) return;
    
    setSettings({
      ...settings,
      customHolidays: [
        ...settings.customHolidays,
        { date: newHolidayDate, name: newHolidayName }
      ].sort((a, b) => a.date.localeCompare(b.date)),
    });
    setNewHolidayDate("");
    setNewHolidayName("");
  }

  function removeCustomHoliday(index: number) {
    if (!settings) return;
    setSettings({
      ...settings,
      customHolidays: settings.customHolidays.filter((_, i) => i !== index),
    });
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

  if (!available) {
    return (
      <div className="flex-1 p-8 bg-gray-50">
        <div className="max-w-3xl mx-auto">
          <div className="flex items-center gap-3 mb-6">
            <div className="p-2 bg-blue-100 rounded-lg">
              <CalendarCheck className="w-6 h-6 text-blue-600" />
            </div>
            <div>
              <h1 className="text-2xl font-bold text-gray-900">Auto Booking</h1>
              <p className="text-gray-500">Automatically schedule appointments from sticker predictions</p>
            </div>
          </div>

          <div className="bg-amber-50 border border-amber-200 rounded-xl p-6">
            <div className="flex items-start gap-3">
              <AlertCircle className="w-5 h-5 text-amber-600 flex-shrink-0 mt-0.5" />
              <div>
                <h3 className="font-semibold text-amber-900">Feature Not Available</h3>
                <p className="text-sm text-amber-800 mt-1">{unavailableReason}</p>
                <a 
                  href="/dashboard/settings/billing" 
                  className="inline-block mt-3 text-sm font-medium text-amber-700 hover:text-amber-800"
                >
                  View Plans →
                </a>
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (!settings) return null;

  return (
    <div className="flex-1 p-8 overflow-auto bg-gray-50">
      <div className="max-w-3xl mx-auto space-y-6">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-blue-100 rounded-lg">
              <CalendarCheck className="w-6 h-6 text-blue-600" />
            </div>
            <div>
              <h1 className="text-2xl font-bold text-gray-900">Auto Booking</h1>
              <p className="text-gray-500">Automatically schedule appointments from sticker predictions</p>
            </div>
          </div>
        </div>

        {message && (
          <div className={`flex items-center gap-2 p-4 rounded-lg ${
            message.type === "success" ? "bg-green-50 text-green-700 border border-green-200" : "bg-red-50 text-red-700 border border-red-200"
          }`}>
            {message.type === "success" ? <Check className="w-5 h-5" /> : <AlertCircle className="w-5 h-5" />}
            <span className="font-medium">{message.text}</span>
          </div>
        )}

        <div className="bg-white rounded-xl border border-gray-200 p-6">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-lg font-semibold text-gray-900">Enable Auto Booking</h2>
              <p className="text-sm text-gray-500 mt-1">
                Automatically create appointments when oil change stickers are generated
              </p>
            </div>
            <label className="relative inline-flex items-center cursor-pointer">
              <input
                type="checkbox"
                checked={settings.enabled}
                onChange={(e) => setSettings({ ...settings, enabled: e.target.checked })}
                className="sr-only peer"
              />
              <div className="w-11 h-6 bg-gray-200 peer-focus:outline-none peer-focus:ring-4 peer-focus:ring-blue-100 rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-blue-600"></div>
            </label>
          </div>
        </div>

        <div className="bg-white rounded-xl border border-gray-200 p-6 space-y-6">
          <div className="flex items-center gap-2">
            <Bell className="w-5 h-5 text-gray-600" />
            <h2 className="text-lg font-semibold text-gray-900">Confirmation Mode</h2>
          </div>
          
          <div className="space-y-3">
            <label className="flex items-start gap-3 p-4 rounded-lg border cursor-pointer hover:bg-gray-50 transition-colors">
              <input
                type="radio"
                name="confirmationMode"
                checked={settings.confirmationMode === "auto"}
                onChange={() => setSettings({ ...settings, confirmationMode: "auto" })}
                className="w-4 h-4 text-blue-600 mt-1"
              />
              <div>
                <span className="font-medium text-gray-900">Fully Automatic</span>
                <p className="text-sm text-gray-500 mt-1">
                  Appointments are created immediately when stickers are generated. No staff review required.
                </p>
              </div>
            </label>
            
            <label className="flex items-start gap-3 p-4 rounded-lg border cursor-pointer hover:bg-gray-50 transition-colors">
              <input
                type="radio"
                name="confirmationMode"
                checked={settings.confirmationMode === "review"}
                onChange={() => setSettings({ ...settings, confirmationMode: "review" })}
                className="w-4 h-4 text-blue-600 mt-1"
              />
              <div>
                <span className="font-medium text-gray-900">Require Staff Review</span>
                <p className="text-sm text-gray-500 mt-1">
                  Appointments are queued for review. Staff must confirm before they're sent to the schedule.
                </p>
              </div>
            </label>
          </div>
        </div>

        <div className="bg-white rounded-xl border border-gray-200 p-6 space-y-6">
          <div className="flex items-center gap-2">
            <Clock className="w-5 h-5 text-gray-600" />
            <h2 className="text-lg font-semibold text-gray-900">Scheduling Preferences</h2>
          </div>

          <div className="grid sm:grid-cols-2 gap-6">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Lead Time (days before due date)
              </label>
              <select
                value={settings.leadTimeDays}
                onChange={(e) => setSettings({ ...settings, leadTimeDays: Number(e.target.value) })}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
              >
                <option value={0}>Same day (due date)</option>
                <option value={1}>1 day before</option>
                <option value={2}>2 days before</option>
                <option value={3}>3 days before</option>
                <option value={5}>5 days before</option>
                <option value={7}>1 week before</option>
                <option value={14}>2 weeks before</option>
              </select>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Preferred Time Slot
              </label>
              <select
                value={settings.preferredTimeSlot}
                onChange={(e) => setSettings({ ...settings, preferredTimeSlot: e.target.value as any })}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
              >
                <option value="morning">Morning (first available)</option>
                <option value="afternoon">Afternoon</option>
                <option value="any">Any available</option>
              </select>
            </div>
          </div>

          <div className="grid sm:grid-cols-2 gap-6">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Business Hours Start
              </label>
              <input
                type="time"
                value={settings.businessHours.start}
                onChange={(e) => setSettings({ 
                  ...settings, 
                  businessHours: { ...settings.businessHours, start: e.target.value } 
                })}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Business Hours End
              </label>
              <input
                type="time"
                value={settings.businessHours.end}
                onChange={(e) => setSettings({ 
                  ...settings, 
                  businessHours: { ...settings.businessHours, end: e.target.value } 
                })}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
              />
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">
              Maximum Bookings Per Day
            </label>
            <input
              type="number"
              min={1}
              max={100}
              value={settings.maxBookingsPerDay}
              onChange={(e) => setSettings({ ...settings, maxBookingsPerDay: Number(e.target.value) })}
              className="w-full max-w-xs px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
            />
            <p className="text-xs text-gray-500 mt-1">
              Limits auto-booked appointments per day (doesn't affect manual bookings)
            </p>
          </div>
        </div>

        <div className="bg-white rounded-xl border border-gray-200 p-6 space-y-6">
          <div className="flex items-center gap-2">
            <CalendarX className="w-5 h-5 text-gray-600" />
            <h2 className="text-lg font-semibold text-gray-900">Blocked Days</h2>
          </div>

          <div className="space-y-4">
            <div className="flex items-center justify-between py-3 border-b border-gray-100">
              <div>
                <h4 className="font-medium text-gray-900">Block Saturdays</h4>
                <p className="text-sm text-gray-500">Don't schedule auto-bookings on Saturdays</p>
              </div>
              <label className="relative inline-flex items-center cursor-pointer">
                <input
                  type="checkbox"
                  checked={settings.blockSaturday}
                  onChange={(e) => setSettings({ ...settings, blockSaturday: e.target.checked })}
                  className="sr-only peer"
                />
                <div className="w-11 h-6 bg-gray-200 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-blue-600"></div>
              </label>
            </div>

            <div className="flex items-center justify-between py-3 border-b border-gray-100">
              <div>
                <h4 className="font-medium text-gray-900">Block Sundays</h4>
                <p className="text-sm text-gray-500">Don't schedule auto-bookings on Sundays</p>
              </div>
              <label className="relative inline-flex items-center cursor-pointer">
                <input
                  type="checkbox"
                  checked={settings.blockSunday}
                  onChange={(e) => setSettings({ ...settings, blockSunday: e.target.checked })}
                  className="sr-only peer"
                />
                <div className="w-11 h-6 bg-gray-200 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-blue-600"></div>
              </label>
            </div>

            <div className="flex items-center justify-between py-3">
              <div>
                <h4 className="font-medium text-gray-900">Block Major Holidays</h4>
                <p className="text-sm text-gray-500">Don't schedule on US federal holidays</p>
              </div>
              <label className="relative inline-flex items-center cursor-pointer">
                <input
                  type="checkbox"
                  checked={settings.blockHolidays}
                  onChange={(e) => setSettings({ ...settings, blockHolidays: e.target.checked })}
                  className="sr-only peer"
                />
                <div className="w-11 h-6 bg-gray-200 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-blue-600"></div>
              </label>
            </div>
          </div>
        </div>

        <div className="bg-white rounded-xl border border-gray-200 p-6 space-y-6">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Calendar className="w-5 h-5 text-gray-600" />
              <h2 className="text-lg font-semibold text-gray-900">Holiday Management</h2>
            </div>
            <button
              onClick={() => setShowHolidays(!showHolidays)}
              className="text-sm text-blue-600 hover:text-blue-700"
            >
              {showHolidays ? "Hide" : "Show"} Holidays
            </button>
          </div>

          {showHolidays && (
            <>
              {settings.blockHolidays && settings.useDefaultHolidays && (
                <div>
                  <h4 className="text-sm font-medium text-gray-700 mb-2">Default US Holidays</h4>
                  <div className="bg-gray-50 rounded-lg p-3 max-h-48 overflow-y-auto">
                    <div className="grid gap-1 text-sm">
                      {defaultHolidays.map((h, i) => (
                        <div key={i} className="flex justify-between text-gray-600">
                          <span>{h.name}</span>
                          <span className="text-gray-400">{h.date}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              )}

              <div>
                <h4 className="text-sm font-medium text-gray-700 mb-2">Custom Blocked Dates</h4>
                <p className="text-xs text-gray-500 mb-3">Add shop-specific dates when you're closed</p>
                
                <div className="flex gap-2 mb-3">
                  <input
                    type="date"
                    value={newHolidayDate}
                    onChange={(e) => setNewHolidayDate(e.target.value)}
                    className="px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500"
                  />
                  <input
                    type="text"
                    value={newHolidayName}
                    onChange={(e) => setNewHolidayName(e.target.value)}
                    placeholder="Reason (e.g., Shop Closed)"
                    className="flex-1 px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500"
                  />
                  <button
                    onClick={addCustomHoliday}
                    disabled={!newHolidayDate || !newHolidayName}
                    className="px-3 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    <Plus className="w-4 h-4" />
                  </button>
                </div>

                {settings.customHolidays.length > 0 ? (
                  <div className="space-y-2">
                    {settings.customHolidays.map((h, i) => (
                      <div key={i} className="flex items-center justify-between p-2 bg-gray-50 rounded-lg">
                        <div className="text-sm">
                          <span className="font-medium text-gray-900">{h.name}</span>
                          <span className="text-gray-400 ml-2">{h.date}</span>
                        </div>
                        <button
                          onClick={() => removeCustomHoliday(i)}
                          className="p-1 text-red-500 hover:text-red-700 hover:bg-red-50 rounded"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="text-sm text-gray-400 italic">No custom blocked dates</p>
                )}
              </div>
            </>
          )}
        </div>

        <div className="flex justify-end gap-3 pt-4">
          <button
            onClick={fetchSettings}
            className="px-4 py-2 border border-gray-300 rounded-lg text-gray-700 hover:bg-gray-50"
          >
            Reset
          </button>
          <button
            onClick={saveSettings}
            disabled={saving}
            className="px-6 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 flex items-center gap-2"
          >
            {saving && <Loader2 className="w-4 h-4 animate-spin" />}
            Save Settings
          </button>
        </div>
      </div>
    </div>
  );
}
