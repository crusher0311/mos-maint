"use client";

import { useState } from "react";
import {
  Bot,
  Settings,
  Mic,
  Clock,
  PhoneForwarded,
  ShieldAlert,
  Plus,
  Trash2,
  Save,
  ToggleLeft,
  ToggleRight,
} from "lucide-react";

type TabId = "general" | "voice" | "hours" | "handling" | "safety";

interface OperatingSlot {
  day: string;
  enabled: boolean;
  startTime: string;
  endTime: string;
  mode: "ai" | "voicemail" | "off";
}

interface SafetyRule {
  id: string;
  rule: string;
}

const TABS: { id: TabId; label: string; icon: typeof Settings }[] = [
  { id: "general", label: "General", icon: Settings },
  { id: "voice", label: "Voice & Prompts", icon: Mic },
  { id: "hours", label: "Operating Hours", icon: Clock },
  { id: "handling", label: "Call Handling", icon: PhoneForwarded },
  { id: "safety", label: "Safety Rules", icon: ShieldAlert },
];

const VOICE_OPTIONS = [
  { id: "alloy", name: "Alloy", description: "Neutral and balanced" },
  { id: "echo", name: "Echo", description: "Warm and conversational" },
  { id: "fable", name: "Fable", description: "British and articulate" },
  { id: "onyx", name: "Onyx", description: "Deep and authoritative" },
  { id: "nova", name: "Nova", description: "Friendly and upbeat" },
  { id: "shimmer", name: "Shimmer", description: "Clear and professional" },
];

const DEFAULT_HOURS: OperatingSlot[] = [
  { day: "Monday", enabled: true, startTime: "08:00", endTime: "18:00", mode: "ai" },
  { day: "Tuesday", enabled: true, startTime: "08:00", endTime: "18:00", mode: "ai" },
  { day: "Wednesday", enabled: true, startTime: "08:00", endTime: "18:00", mode: "ai" },
  { day: "Thursday", enabled: true, startTime: "08:00", endTime: "18:00", mode: "ai" },
  { day: "Friday", enabled: true, startTime: "08:00", endTime: "17:00", mode: "ai" },
  { day: "Saturday", enabled: true, startTime: "09:00", endTime: "14:00", mode: "voicemail" },
  { day: "Sunday", enabled: false, startTime: "09:00", endTime: "14:00", mode: "off" },
];

const DEFAULT_SAFETY_RULES: SafetyRule[] = [
  { id: "s1", rule: "Never provide specific repair cost estimates without advisor approval" },
  { id: "s2", rule: "Always recommend professional inspection for safety-related concerns" },
  { id: "s3", rule: "Do not diagnose vehicle problems - only describe what the customer reports" },
  { id: "s4", rule: "Transfer to a human advisor if the caller becomes upset or frustrated" },
  { id: "s5", rule: "Never share other customers' personal information" },
];

export default function RescueRoverSettingsPage() {
  const [activeTab, setActiveTab] = useState<TabId>("general");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  const [enabled, setEnabled] = useState(true);
  const [mode, setMode] = useState<"full" | "after_hours" | "overflow">("full");

  const [systemPrompt, setSystemPrompt] = useState(
    "You are Rescue Rover, a friendly and professional AI phone assistant for an auto repair shop. Help customers with appointment scheduling, status updates, and general inquiries. Be warm, helpful, and concise."
  );
  const [greeting, setGreeting] = useState(
    "Thank you for calling! This is Rescue Rover, your virtual assistant. How can I help you today?"
  );
  const [voiceId, setVoiceId] = useState("nova");
  const [speechSpeed, setSpeechSpeed] = useState(1.0);

  const [hours, setHours] = useState<OperatingSlot[]>(DEFAULT_HOURS);

  const [maxDuration, setMaxDuration] = useState(300);
  const [transferNumber, setTransferNumber] = useState("");
  const [voicemailGreeting, setVoicemailGreeting] = useState(
    "Sorry we missed your call! Please leave a message and we'll get back to you as soon as possible."
  );
  const [enableTransfer, setEnableTransfer] = useState(true);

  const [safetyRules, setSafetyRules] = useState<SafetyRule[]>(DEFAULT_SAFETY_RULES);
  const [newRule, setNewRule] = useState("");

  const handleSave = async () => {
    setSaving(true);
    await new Promise((r) => setTimeout(r, 800));
    setSaving(false);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  const addSafetyRule = () => {
    if (!newRule.trim()) return;
    setSafetyRules((prev) => [...prev, { id: `s${Date.now()}`, rule: newRule.trim() }]);
    setNewRule("");
  };

  const removeSafetyRule = (id: string) => {
    setSafetyRules((prev) => prev.filter((r) => r.id !== id));
  };

  const updateHour = (index: number, field: keyof OperatingSlot, value: string | boolean) => {
    setHours((prev) => prev.map((h, i) => (i === index ? { ...h, [field]: value } : h)));
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 flex items-center gap-2">
            <Bot className="w-7 h-7 text-blue-600" />
            Rescue Rover Settings
          </h1>
          <p className="mt-1 text-sm text-gray-500">Configure the AI voice agent for your shop</p>
        </div>
        <button
          onClick={handleSave}
          disabled={saving}
          className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors disabled:opacity-50"
        >
          <Save className="w-4 h-4" />
          {saving ? "Saving..." : saved ? "Saved!" : "Save Changes"}
        </button>
      </div>

      <div className="flex gap-6">
        <div className="w-48 flex-shrink-0">
          <nav className="space-y-1">
            {TABS.map((tab) => {
              const Icon = tab.icon;
              return (
                <button
                  key={tab.id}
                  onClick={() => setActiveTab(tab.id)}
                  className={`w-full flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
                    activeTab === tab.id
                      ? "bg-blue-50 text-blue-700"
                      : "text-gray-600 hover:bg-gray-100"
                  }`}
                >
                  <Icon className="w-4 h-4" />
                  {tab.label}
                </button>
              );
            })}
          </nav>
        </div>

        <div className="flex-1 bg-white rounded-lg shadow-sm border border-gray-100 p-6">
          {activeTab === "general" && (
            <div className="space-y-6">
              <h2 className="text-lg font-semibold text-gray-900">General Settings</h2>
              <div className="flex items-center justify-between p-4 bg-gray-50 rounded-lg border border-gray-100">
                <div>
                  <p className="font-medium text-gray-900">Enable Rescue Rover</p>
                  <p className="text-sm text-gray-500">Turn the AI voice agent on or off for incoming calls</p>
                </div>
                <button
                  onClick={() => setEnabled(!enabled)}
                  className={`p-1 transition-colors ${enabled ? "text-blue-600" : "text-gray-400"}`}
                >
                  {enabled ? <ToggleRight className="w-10 h-10" /> : <ToggleLeft className="w-10 h-10" />}
                </button>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">Operating Mode</label>
                <div className="space-y-2">
                  {[
                    { value: "full" as const, label: "Full-time", desc: "Answer all calls during operating hours" },
                    { value: "after_hours" as const, label: "After Hours Only", desc: "Only answer when the shop is closed" },
                    { value: "overflow" as const, label: "Overflow", desc: "Answer when no staff picks up within 30 seconds" },
                  ].map((opt) => (
                    <label
                      key={opt.value}
                      className={`flex items-start gap-3 p-3 rounded-lg border cursor-pointer transition-colors ${
                        mode === opt.value ? "border-blue-300 bg-blue-50" : "border-gray-200 hover:bg-gray-50"
                      }`}
                    >
                      <input
                        type="radio"
                        name="mode"
                        value={opt.value}
                        checked={mode === opt.value}
                        onChange={() => setMode(opt.value)}
                        className="mt-0.5"
                      />
                      <div>
                        <p className="text-sm font-medium text-gray-900">{opt.label}</p>
                        <p className="text-xs text-gray-500">{opt.desc}</p>
                      </div>
                    </label>
                  ))}
                </div>
              </div>
            </div>
          )}

          {activeTab === "voice" && (
            <div className="space-y-6">
              <h2 className="text-lg font-semibold text-gray-900">Voice & Prompts</h2>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">System Prompt</label>
                <textarea
                  value={systemPrompt}
                  onChange={(e) => setSystemPrompt(e.target.value)}
                  rows={5}
                  className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none"
                  placeholder="Instructions for the AI agent..."
                />
                <p className="text-xs text-gray-400 mt-1">{systemPrompt.length} characters</p>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">Greeting Message</label>
                <textarea
                  value={greeting}
                  onChange={(e) => setGreeting(e.target.value)}
                  rows={3}
                  className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none"
                  placeholder="What the AI says when answering a call..."
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">Voice Selection</label>
                <div className="grid grid-cols-2 gap-2">
                  {VOICE_OPTIONS.map((voice) => (
                    <label
                      key={voice.id}
                      className={`flex items-center gap-2 p-3 rounded-lg border cursor-pointer transition-colors ${
                        voiceId === voice.id ? "border-blue-300 bg-blue-50" : "border-gray-200 hover:bg-gray-50"
                      }`}
                    >
                      <input
                        type="radio"
                        name="voice"
                        value={voice.id}
                        checked={voiceId === voice.id}
                        onChange={() => setVoiceId(voice.id)}
                      />
                      <div>
                        <p className="text-sm font-medium text-gray-900">{voice.name}</p>
                        <p className="text-xs text-gray-500">{voice.description}</p>
                      </div>
                    </label>
                  ))}
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Speech Speed: {speechSpeed.toFixed(1)}x
                </label>
                <input
                  type="range"
                  min="0.5"
                  max="2.0"
                  step="0.1"
                  value={speechSpeed}
                  onChange={(e) => setSpeechSpeed(parseFloat(e.target.value))}
                  className="w-full accent-blue-600"
                />
                <div className="flex justify-between text-xs text-gray-400 mt-1">
                  <span>0.5x (Slow)</span>
                  <span>1.0x (Normal)</span>
                  <span>2.0x (Fast)</span>
                </div>
              </div>
            </div>
          )}

          {activeTab === "hours" && (
            <div className="space-y-6">
              <h2 className="text-lg font-semibold text-gray-900">Operating Hours</h2>
              <p className="text-sm text-gray-500">Set when Rescue Rover answers calls and the mode for each time slot.</p>

              <div className="space-y-2">
                {hours.map((slot, i) => (
                  <div
                    key={slot.day}
                    className={`flex items-center gap-4 p-3 rounded-lg border transition-colors ${
                      slot.enabled ? "border-gray-200 bg-white" : "border-gray-100 bg-gray-50"
                    }`}
                  >
                    <label className="flex items-center gap-2 w-28 flex-shrink-0">
                      <input
                        type="checkbox"
                        checked={slot.enabled}
                        onChange={(e) => updateHour(i, "enabled", e.target.checked)}
                        className="w-4 h-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                      />
                      <span className={`text-sm font-medium ${slot.enabled ? "text-gray-900" : "text-gray-400"}`}>
                        {slot.day}
                      </span>
                    </label>
                    {slot.enabled && (
                      <>
                        <input
                          type="time"
                          value={slot.startTime}
                          onChange={(e) => updateHour(i, "startTime", e.target.value)}
                          className="px-2 py-1 border border-gray-200 rounded text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                        />
                        <span className="text-gray-400">to</span>
                        <input
                          type="time"
                          value={slot.endTime}
                          onChange={(e) => updateHour(i, "endTime", e.target.value)}
                          className="px-2 py-1 border border-gray-200 rounded text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                        />
                        <select
                          value={slot.mode}
                          onChange={(e) => updateHour(i, "mode", e.target.value)}
                          className="px-2 py-1 border border-gray-200 rounded text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                        >
                          <option value="ai">AI Agent</option>
                          <option value="voicemail">Voicemail Only</option>
                          <option value="off">Off</option>
                        </select>
                      </>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {activeTab === "handling" && (
            <div className="space-y-6">
              <h2 className="text-lg font-semibold text-gray-900">Call Handling</h2>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Max Call Duration: {Math.floor(maxDuration / 60)}m {maxDuration % 60}s
                </label>
                <input
                  type="range"
                  min="60"
                  max="600"
                  step="30"
                  value={maxDuration}
                  onChange={(e) => setMaxDuration(parseInt(e.target.value))}
                  className="w-full accent-blue-600"
                />
                <div className="flex justify-between text-xs text-gray-400 mt-1">
                  <span>1 min</span>
                  <span>5 min</span>
                  <span>10 min</span>
                </div>
              </div>

              <div className="flex items-center justify-between p-4 bg-gray-50 rounded-lg border border-gray-100">
                <div>
                  <p className="font-medium text-gray-900">Enable Call Transfer</p>
                  <p className="text-sm text-gray-500">Allow the AI to transfer calls to a staff member</p>
                </div>
                <button
                  onClick={() => setEnableTransfer(!enableTransfer)}
                  className={`p-1 transition-colors ${enableTransfer ? "text-blue-600" : "text-gray-400"}`}
                >
                  {enableTransfer ? <ToggleRight className="w-10 h-10" /> : <ToggleLeft className="w-10 h-10" />}
                </button>
              </div>

              {enableTransfer && (
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">Transfer Phone Number</label>
                  <input
                    type="tel"
                    value={transferNumber}
                    onChange={(e) => setTransferNumber(e.target.value)}
                    placeholder="(555) 123-4567"
                    className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                </div>
              )}

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">Voicemail Greeting</label>
                <textarea
                  value={voicemailGreeting}
                  onChange={(e) => setVoicemailGreeting(e.target.value)}
                  rows={3}
                  className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none"
                  placeholder="Message played when sending to voicemail..."
                />
              </div>
            </div>
          )}

          {activeTab === "safety" && (
            <div className="space-y-6">
              <h2 className="text-lg font-semibold text-gray-900">Safety Rules</h2>
              <p className="text-sm text-gray-500">Rules the AI must follow during conversations. These are included in the system prompt.</p>

              <div className="space-y-2">
                {safetyRules.map((rule) => (
                  <div
                    key={rule.id}
                    className="flex items-start gap-3 p-3 bg-gray-50 rounded-lg border border-gray-100 group"
                  >
                    <ShieldAlert className="w-4 h-4 text-amber-500 mt-0.5 flex-shrink-0" />
                    <p className="flex-1 text-sm text-gray-700">{rule.rule}</p>
                    <button
                      onClick={() => removeSafetyRule(rule.id)}
                      className="flex-shrink-0 p-1 text-gray-300 hover:text-red-500 opacity-0 group-hover:opacity-100 transition-all"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                ))}
              </div>

              <div className="flex gap-2">
                <input
                  type="text"
                  value={newRule}
                  onChange={(e) => setNewRule(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && addSafetyRule()}
                  placeholder="Add a new safety rule..."
                  className="flex-1 px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
                <button
                  onClick={addSafetyRule}
                  disabled={!newRule.trim()}
                  className="flex items-center gap-2 px-3 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors disabled:opacity-50 text-sm"
                >
                  <Plus className="w-4 h-4" />
                  Add
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
