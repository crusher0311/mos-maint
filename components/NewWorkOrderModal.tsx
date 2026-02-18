"use client";

import { useState, useEffect } from "react";
import {
  X,
  Search,
  Loader2,
  User,
  Car,
  ChevronRight,
  ChevronLeft,
  CheckCircle,
  MessageSquareText,
  Send,
  RotateCcw,
  Plus,
  FileText,
  AlertTriangle,
} from "lucide-react";

type Contact = {
  id: string;
  firstName: string;
  lastName: string;
  fileAs: string;
  company: string;
  phone: string;
  email: string;
};

type Vehicle = {
  id: string;
  vin: string;
  year: number | null;
  make: string;
  model: string;
  submodel: string;
  color: string;
  plate: string;
  odometer: number | null;
};

type Exchange = {
  question: string;
  response: string;
};

type Step = "concern" | "customer" | "vehicle" | "confirm";

interface NewWorkOrderModalProps {
  isOpen: boolean;
  onClose: () => void;
  onCreated?: (workOrderNumber: number) => void;
}

export default function NewWorkOrderModal({ isOpen, onClose, onCreated }: NewWorkOrderModalProps) {
  const [step, setStep] = useState<Step>("customer");

  const [contactSearch, setContactSearch] = useState("");
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [selectedContact, setSelectedContact] = useState<Contact | null>(null);
  const [searchingContacts, setSearchingContacts] = useState(false);
  const [contactError, setContactError] = useState("");

  const [vehicles, setVehicles] = useState<Vehicle[]>([]);
  const [selectedVehicle, setSelectedVehicle] = useState<Vehicle | null>(null);
  const [loadingVehicles, setLoadingVehicles] = useState(false);
  const [vehicleError, setVehicleError] = useState("");

  const [concern, setConcern] = useState("");
  const [concernStage, setConcernStage] = useState<"start" | "questions" | "result">("start");
  const [questions, setQuestions] = useState<string[]>([]);
  const [exchanges, setExchanges] = useState<Exchange[]>([]);
  const [answers, setAnswers] = useState<Record<number, string>>({});
  const [cleanedText, setCleanedText] = useState("");
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [concernLoading, setConcernLoading] = useState(false);
  const [concernError, setConcernError] = useState("");

  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState("");
  const [createdWO, setCreatedWO] = useState<number | null>(null);

  useEffect(() => {
    if (!isOpen) {
      setStep("customer");
      setContactSearch("");
      setContacts([]);
      setSelectedContact(null);
      setContactError("");
      setVehicles([]);
      setSelectedVehicle(null);
      setVehicleError("");
      setConcern("");
      setConcernStage("start");
      setQuestions([]);
      setExchanges([]);
      setAnswers({});
      setCleanedText("");
      setConversationId(null);
      setConcernError("");
      setCreating(false);
      setCreateError("");
      setCreatedWO(null);
    }
  }, [isOpen]);

  async function searchContactsFn() {
    if (contactSearch.length < 2) return;
    setSearchingContacts(true);
    setContactError("");
    try {
      const res = await fetch(`/api/dashboard/protractor/contacts?q=${encodeURIComponent(contactSearch)}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Search failed");
      setContacts(data.contacts || []);
      if (data.contacts?.length === 0) setContactError("No customers found");
    } catch (err: any) {
      setContactError(err.message);
    } finally {
      setSearchingContacts(false);
    }
  }

  const selectContact = async (contact: Contact) => {
    setSelectedContact(contact);
    setStep("vehicle");
    setLoadingVehicles(true);
    setVehicleError("");
    try {
      const res = await fetch(`/api/dashboard/protractor/vehicles?ownerId=${contact.id}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to load vehicles");
      setVehicles(data.vehicles || []);
      if (data.vehicles?.length === 0) setVehicleError("No vehicles found for this customer");
    } catch (err: any) {
      setVehicleError(err.message);
    } finally {
      setLoadingVehicles(false);
    }
  };

  const selectVehicle = (vehicle: Vehicle) => {
    setSelectedVehicle(vehicle);
    setStep("concern");
  };

  async function handleConcernSubmit() {
    if (!concern.trim()) return;
    setConcernLoading(true);
    setConcernError("");
    try {
      const res = await fetch("/api/dashboard/concern-assistant", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "followup", concern: concern.trim() }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to generate questions");
      setQuestions(data.questions || []);
      setConversationId(data.conversationId);
      setConcernStage("questions");
    } catch (err: any) {
      setConcernError(err.message);
    } finally {
      setConcernLoading(false);
    }
  }

  async function handleAnswersSubmit() {
    setConcernLoading(true);
    setConcernError("");
    const newExchanges = questions.map((q, i) => ({
      question: q,
      response: answers[i] || "No answer provided",
    }));
    const allExchanges = [...exchanges, ...newExchanges];
    try {
      const res = await fetch("/api/dashboard/concern-assistant", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "cleanup",
          concern: concern.trim(),
          exchanges: allExchanges,
          conversationId,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to generate write-up");
      setCleanedText(data.cleanedText || "");
      setExchanges(allExchanges);
      setConcernStage("result");
    } catch (err: any) {
      setConcernError(err.message);
    } finally {
      setConcernLoading(false);
    }
  }

  async function handleCreateWorkOrder() {
    if (!selectedContact || !selectedVehicle) return;
    setCreating(true);
    setCreateError("");
    try {
      const note = cleanedText || concern || "";
      const res = await fetch("/api/dashboard/protractor/create-work-order", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contactId: selectedContact.id,
          vehicleId: selectedVehicle.id,
          note,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to create work order");
      setCreatedWO(data.workOrderNumber);
      setStep("confirm");
      if (onCreated) onCreated(data.workOrderNumber);
    } catch (err: any) {
      setCreateError(err.message);
    } finally {
      setCreating(false);
    }
  }

  if (!isOpen) return null;

  const vehicleDisplay = selectedVehicle
    ? [selectedVehicle.year, selectedVehicle.make, selectedVehicle.model].filter(Boolean).join(" ")
    : "";
  const contactDisplay = selectedContact
    ? [selectedContact.firstName, selectedContact.lastName].filter(Boolean).join(" ") || selectedContact.fileAs
    : "";

  const steps: { key: Step; label: string; icon: any }[] = [
    { key: "customer", label: "Customer", icon: User },
    { key: "vehicle", label: "Vehicle", icon: Car },
    { key: "concern", label: "Concern", icon: MessageSquareText },
    { key: "confirm", label: "Done", icon: CheckCircle },
  ];

  const currentStepIndex = steps.findIndex(s => s.key === step);

  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-2xl max-h-[90vh] flex flex-col">
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200">
          <div className="flex items-center gap-3">
            <FileText className="w-5 h-5 text-blue-600" />
            <h2 className="text-lg font-semibold text-gray-900">New Work Order</h2>
          </div>
          <button onClick={onClose} className="p-1.5 text-gray-400 hover:text-gray-600 rounded-lg hover:bg-gray-100">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="flex items-center gap-1 px-6 py-3 border-b border-gray-100 bg-gray-50">
          {steps.map((s, i) => {
            const Icon = s.icon;
            const isActive = s.key === step;
            const isDone = i < currentStepIndex;
            return (
              <div key={s.key} className="flex items-center gap-1 flex-1">
                <div className={`flex items-center gap-1.5 px-2 py-1 rounded-md text-xs font-medium ${
                  isActive ? "bg-blue-100 text-blue-700" : isDone ? "text-green-600" : "text-gray-400"
                }`}>
                  {isDone ? <CheckCircle className="w-3.5 h-3.5" /> : <Icon className="w-3.5 h-3.5" />}
                  <span className="hidden sm:inline">{s.label}</span>
                </div>
                {i < steps.length - 1 && <ChevronRight className="w-3 h-3 text-gray-300 flex-shrink-0" />}
              </div>
            );
          })}
        </div>

        <div className="flex-1 overflow-y-auto px-6 py-4">
          {step === "customer" && (
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Search Customer</label>
                <div className="flex gap-2">
                  <div className="relative flex-1">
                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
                    <input
                      type="text"
                      value={contactSearch}
                      onChange={e => setContactSearch(e.target.value)}
                      onKeyDown={e => e.key === "Enter" && searchContactsFn()}
                      placeholder="Name, phone, email, or company..."
                      className="w-full pl-9 pr-3 py-2.5 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                      autoFocus
                    />
                  </div>
                  <button
                    onClick={searchContactsFn}
                    disabled={contactSearch.length < 2 || searchingContacts}
                    className="px-4 py-2.5 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
                  >
                    {searchingContacts ? <Loader2 className="w-4 h-4 animate-spin" /> : <Search className="w-4 h-4" />}
                    Search
                  </button>
                </div>
              </div>

              {contactError && (
                <p className="text-sm text-amber-600 flex items-center gap-1.5">
                  <AlertTriangle className="w-4 h-4" /> {contactError}
                </p>
              )}

              {contacts.length > 0 && (
                <div className="space-y-1.5 max-h-72 overflow-y-auto">
                  {contacts.map(c => (
                    <button
                      key={c.id}
                      onClick={() => selectContact(c)}
                      className="w-full text-left p-3 rounded-lg border border-gray-200 hover:border-blue-300 hover:bg-blue-50 transition-colors"
                    >
                      <div className="flex items-center justify-between">
                        <div>
                          <div className="font-medium text-gray-900 text-sm">
                            {[c.firstName, c.lastName].filter(Boolean).join(" ") || c.fileAs}
                          </div>
                          <div className="text-xs text-gray-500 mt-0.5 flex items-center gap-3">
                            {c.company && <span>{c.company}</span>}
                            {c.phone && <span>{c.phone}</span>}
                            {c.email && <span>{c.email}</span>}
                          </div>
                        </div>
                        <ChevronRight className="w-4 h-4 text-gray-400" />
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          {step === "vehicle" && (
            <div className="space-y-4">
              <div className="flex items-center gap-2 text-sm text-gray-600 bg-gray-50 px-3 py-2 rounded-lg">
                <User className="w-4 h-4 text-blue-500" />
                <span className="font-medium">{contactDisplay}</span>
                <button onClick={() => setStep("customer")} className="ml-auto text-blue-600 hover:underline text-xs">
                  Change
                </button>
              </div>

              {loadingVehicles ? (
                <div className="flex items-center justify-center py-12">
                  <Loader2 className="w-6 h-6 animate-spin text-blue-500" />
                  <span className="ml-2 text-sm text-gray-500">Loading vehicles...</span>
                </div>
              ) : vehicleError ? (
                <p className="text-sm text-amber-600 flex items-center gap-1.5 py-4">
                  <AlertTriangle className="w-4 h-4" /> {vehicleError}
                </p>
              ) : (
                <div className="space-y-1.5 max-h-72 overflow-y-auto">
                  <label className="block text-sm font-medium text-gray-700 mb-1">Select Vehicle</label>
                  {vehicles.map(v => (
                    <button
                      key={v.id}
                      onClick={() => selectVehicle(v)}
                      className="w-full text-left p-3 rounded-lg border border-gray-200 hover:border-blue-300 hover:bg-blue-50 transition-colors"
                    >
                      <div className="flex items-center justify-between">
                        <div>
                          <div className="font-medium text-gray-900 text-sm">
                            {[v.year, v.make, v.model].filter(Boolean).join(" ")}
                            {v.submodel && <span className="text-gray-500 ml-1">{v.submodel}</span>}
                          </div>
                          <div className="text-xs text-gray-500 mt-0.5 flex items-center gap-3">
                            {v.vin && <span>VIN: {v.vin}</span>}
                            {v.plate && <span>Plate: {v.plate}</span>}
                            {v.color && <span>{v.color}</span>}
                            {v.odometer && <span>{v.odometer.toLocaleString()} mi</span>}
                          </div>
                        </div>
                        <ChevronRight className="w-4 h-4 text-gray-400" />
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          {step === "concern" && (
            <div className="space-y-4">
              <div className="flex items-center gap-2 text-sm text-gray-600 bg-gray-50 px-3 py-2 rounded-lg">
                <User className="w-4 h-4 text-blue-500" />
                <span className="font-medium">{contactDisplay}</span>
                <span className="text-gray-300 mx-1">|</span>
                <Car className="w-4 h-4 text-blue-500" />
                <span className="font-medium">{vehicleDisplay}</span>
              </div>

              {concernStage === "start" && (
                <div className="space-y-3">
                  <label className="block text-sm font-medium text-gray-700">
                    Customer Concern <span className="text-gray-400 font-normal">(optional)</span>
                  </label>
                  <textarea
                    value={concern}
                    onChange={e => setConcern(e.target.value)}
                    placeholder="What did the customer say? e.g. 'Car is making a grinding noise when braking...'"
                    className="w-full px-3 py-2.5 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 resize-none"
                    rows={4}
                  />
                  {concernError && <p className="text-sm text-red-600">{concernError}</p>}
                  <div className="flex gap-2">
                    <button
                      onClick={handleConcernSubmit}
                      disabled={!concern.trim() || concernLoading}
                      className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 disabled:opacity-50"
                    >
                      {concernLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <MessageSquareText className="w-4 h-4" />}
                      Build Concern Write-up
                    </button>
                    <button
                      onClick={handleCreateWorkOrder}
                      disabled={creating}
                      className="flex items-center gap-2 px-4 py-2 bg-gray-800 text-white text-sm font-medium rounded-lg hover:bg-gray-900 disabled:opacity-50"
                    >
                      {creating ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
                      Skip & Create WO
                    </button>
                  </div>
                  {createError && <p className="text-sm text-red-600">{createError}</p>}
                </div>
              )}

              {concernStage === "questions" && (
                <div className="space-y-3">
                  <p className="text-sm text-gray-600">Answer the follow-up questions to build a thorough write-up:</p>
                  {questions.map((q, i) => (
                    <div key={i} className="space-y-1">
                      <label className="block text-sm font-medium text-gray-700">{q}</label>
                      <input
                        type="text"
                        value={answers[i] || ""}
                        onChange={e => setAnswers(prev => ({ ...prev, [i]: e.target.value }))}
                        placeholder="Type answer..."
                        className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                      />
                    </div>
                  ))}
                  {concernError && <p className="text-sm text-red-600">{concernError}</p>}
                  <button
                    onClick={handleAnswersSubmit}
                    disabled={concernLoading}
                    className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 disabled:opacity-50"
                  >
                    {concernLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
                    Generate Write-up
                  </button>
                </div>
              )}

              {concernStage === "result" && (
                <div className="space-y-3">
                  <label className="block text-sm font-medium text-gray-700">Concern Write-up</label>
                  <textarea
                    value={cleanedText}
                    onChange={e => setCleanedText(e.target.value)}
                    className="w-full px-3 py-2.5 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 resize-none"
                    rows={5}
                  />
                  <div className="flex gap-2">
                    <button
                      onClick={() => { setConcernStage("start"); setConcern(""); setCleanedText(""); setQuestions([]); setExchanges([]); setAnswers({}); }}
                      className="flex items-center gap-2 px-4 py-2 text-gray-700 border border-gray-300 text-sm font-medium rounded-lg hover:bg-gray-50"
                    >
                      <RotateCcw className="w-4 h-4" />
                      Start Over
                    </button>
                    <button
                      onClick={handleCreateWorkOrder}
                      disabled={creating}
                      className="flex items-center gap-2 px-4 py-2 bg-green-600 text-white text-sm font-medium rounded-lg hover:bg-green-700 disabled:opacity-50"
                    >
                      {creating ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle className="w-4 h-4" />}
                      Create Work Order
                    </button>
                  </div>
                  {createError && <p className="text-sm text-red-600">{createError}</p>}
                </div>
              )}
            </div>
          )}

          {step === "confirm" && (
            <div className="flex flex-col items-center justify-center py-8 space-y-4">
              <div className="w-16 h-16 bg-green-100 rounded-full flex items-center justify-center">
                <CheckCircle className="w-8 h-8 text-green-600" />
              </div>
              <h3 className="text-lg font-semibold text-gray-900">Work Order Created</h3>
              <p className="text-sm text-gray-600 text-center">
                WO #{createdWO} has been created in Protractor for{" "}
                <span className="font-medium">{contactDisplay}</span> &mdash;{" "}
                <span className="font-medium">{vehicleDisplay}</span>
              </p>
              <p className="text-xs text-gray-400">It will appear on your dashboard shortly.</p>
              <button
                onClick={onClose}
                className="mt-4 px-6 py-2.5 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700"
              >
                Done
              </button>
            </div>
          )}
        </div>

        {step !== "confirm" && (
          <div className="border-t border-gray-200 px-6 py-3 flex items-center justify-between bg-gray-50">
            <button
              onClick={() => {
                if (step === "vehicle") setStep("customer");
                if (step === "concern") setStep("vehicle");
              }}
              disabled={step === "customer"}
              className="flex items-center gap-1.5 text-sm text-gray-600 hover:text-gray-800 disabled:opacity-30 disabled:cursor-not-allowed"
            >
              <ChevronLeft className="w-4 h-4" />
              Back
            </button>
            <button onClick={onClose} className="text-sm text-gray-500 hover:text-gray-700">
              Cancel
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
