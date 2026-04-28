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
  Wrench,
  Clock,
  History,
  Package,
  Trash2,
  Camera,
  UserPlus,
  ChevronDown,
} from "lucide-react";

const US_STATES = [
  "AL","AK","AZ","AR","CA","CO","CT","DE","FL","GA","HI","ID","IL","IN","IA","KS","KY","LA","ME","MD",
  "MA","MI","MN","MS","MO","MT","NE","NV","NH","NJ","NM","NY","NC","ND","OH","OK","OR","PA","RI","SC",
  "SD","TN","TX","UT","VT","VA","WA","WV","WI","WY","DC",
];

const CA_PROVINCES = [
  "AB","BC","MB","NB","NL","NS","NT","NU","ON","PE","QC","SK","YT",
];

const UNSUPPORTED_PLATE_REGIONS: Record<string, string> = {
  AB: "Alberta",
  BC: "British Columbia",
  MB: "Manitoba",
  NB: "New Brunswick",
  NL: "Newfoundland and Labrador",
  NS: "Nova Scotia",
  NT: "Northwest Territories",
  NU: "Nunavut",
  ON: "Ontario",
  PE: "Prince Edward Island",
  QC: "Quebec",
  SK: "Saskatchewan",
  YT: "Yukon",
};

const STATE_NAME_TO_ABBR: Record<string, string> = {
  ALABAMA:"AL",ALASKA:"AK",ARIZONA:"AZ",ARKANSAS:"AR",CALIFORNIA:"CA",COLORADO:"CO",CONNECTICUT:"CT",
  DELAWARE:"DE",FLORIDA:"FL",GEORGIA:"GA",HAWAII:"HI",IDAHO:"ID",ILLINOIS:"IL",INDIANA:"IN",IOWA:"IA",
  KANSAS:"KS",KENTUCKY:"KY",LOUISIANA:"LA",MAINE:"ME",MARYLAND:"MD",MASSACHUSETTS:"MA",MICHIGAN:"MI",
  MINNESOTA:"MN",MISSISSIPPI:"MS",MISSOURI:"MO",MONTANA:"MT",NEBRASKA:"NE",NEVADA:"NV",
  "NEW HAMPSHIRE":"NH","NEW JERSEY":"NJ","NEW MEXICO":"NM","NEW YORK":"NY","NORTH CAROLINA":"NC",
  "NORTH DAKOTA":"ND",OHIO:"OH",OKLAHOMA:"OK",OREGON:"OR",PENNSYLVANIA:"PA","RHODE ISLAND":"RI",
  "SOUTH CAROLINA":"SC","SOUTH DAKOTA":"SD",TENNESSEE:"TN",TEXAS:"TX",UTAH:"UT",VERMONT:"VT",
  VIRGINIA:"VA",WASHINGTON:"WA","WEST VIRGINIA":"WV",WISCONSIN:"WI",WYOMING:"WY",
  "DISTRICT OF COLUMBIA":"DC","WASHINGTON DC":"DC","WASHINGTON D.C.":"DC",
  ALBERTA:"AB","BRITISH COLUMBIA":"BC",MANITOBA:"MB","NEW BRUNSWICK":"NB",
  "NEWFOUNDLAND":"NL","NEWFOUNDLAND AND LABRADOR":"NL","NOVA SCOTIA":"NS",
  "NORTHWEST TERRITORIES":"NT",NUNAVUT:"NU",ONTARIO:"ON",
  "PRINCE EDWARD ISLAND":"PE",QUEBEC:"QC","QUÉBEC":"QC",SASKATCHEWAN:"SK",YUKON:"YT",
};

function resolveStateAbbr(state: string | null | undefined): string {
  if (!state) return "";
  const upper = state.toUpperCase().trim();
  if (upper.length === 2 && (US_STATES.includes(upper) || CA_PROVINCES.includes(upper))) return upper;
  return STATE_NAME_TO_ABBR[upper] || "";
}

type FieldVisibility = "required" | "optional" | "hidden";
type CreateROSettings = {
  customerFields: Record<string, FieldVisibility>;
  vehicleFields: Record<string, FieldVisibility>;
  marketingSources: string[];
};

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
  engine: string;
  color: string;
  plate: string;
  odometer: number | null;
};

type Exchange = {
  question: string;
  response: string;
};

type Step = "concern" | "customer" | "vehicle" | "note" | "jobs" | "confirm";

type SelectedJob = {
  source: "canned" | "deferred" | "history";
  title: string;
  description?: string;
  chapter?: string;
  code?: string;
  originalWorkOrderId?: string;
  deferredId?: string;
  lines?: Array<{ description?: string; lineType?: string; quantity?: number; unitPrice?: number }>;
};

type JobTab = "canned" | "deferred" | "history";

interface NewWorkOrderModalProps {
  isOpen: boolean;
  onClose: () => void;
  onCreated?: (workOrderNumber: number) => void;
}

export default function NewWorkOrderModal({ isOpen, onClose, onCreated }: NewWorkOrderModalProps) {
  const [step, setStep] = useState<Step>("concern");

  const [contactSearch, setContactSearch] = useState("");
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [selectedContact, setSelectedContact] = useState<Contact | null>(null);
  const [searchingContacts, setSearchingContacts] = useState(false);
  const [contactError, setContactError] = useState("");

  const [vehicles, setVehicles] = useState<Vehicle[]>([]);
  const [selectedVehicle, setSelectedVehicle] = useState<Vehicle | null>(null);
  const [loadingVehicles, setLoadingVehicles] = useState(false);
  const [vehicleError, setVehicleError] = useState("");
  const [mileageInput, setMileageInput] = useState("");

  const [concern, setConcern] = useState("");
  const [concernStage, setConcernStage] = useState<"start" | "questions" | "result">("start");
  const [questions, setQuestions] = useState<string[]>([]);
  const [exchanges, setExchanges] = useState<Exchange[]>([]);
  const [answers, setAnswers] = useState<Record<number, string>>({});
  const [cleanedText, setCleanedText] = useState("");
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [concernLoading, setConcernLoading] = useState(false);
  const [concernError, setConcernError] = useState("");

  const [noteText, setNoteText] = useState("");

  const [jobTab, setJobTab] = useState<JobTab>("canned");
  const [selectedJobs, setSelectedJobs] = useState<SelectedJob[]>([]);
  const [cannedJobSearch, setCannedJobSearch] = useState("");
  const [cannedJobs, setCannedJobs] = useState<any[]>([]);
  const [searchingCanned, setSearchingCanned] = useState(false);
  const [deferredItems, setDeferredItems] = useState<any[]>([]);
  const [loadingDeferred, setLoadingDeferred] = useState(false);
  const [historySearch, setHistorySearch] = useState("");
  const [historyJobs, setHistoryJobs] = useState<any[]>([]);
  const [expandedHistoryIdx, setExpandedHistoryIdx] = useState<number | null>(null);
  const [searchingHistory, setSearchingHistory] = useState(false);
  const [jobsError, setJobsError] = useState("");

  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState("");
  const [createdWO, setCreatedWO] = useState<number | null>(null);

  const [createNewCustomer, setCreateNewCustomer] = useState(false);
  const [newCustomer, setNewCustomer] = useState<Record<string, string>>({ firstName: "", lastName: "" });
  const [creatingContact, setCreatingContact] = useState(false);

  const [createNewVehicle, setCreateNewVehicle] = useState(false);
  const [newVehicle, setNewVehicle] = useState<Record<string, string>>({});
  const [creatingVehicle, setCreatingVehicle] = useState(false);

  const [roSettings, setRoSettings] = useState<CreateROSettings | null>(null);
  const [ocrLoading, setOcrLoading] = useState(false);
  const [ocrResult, setOcrResult] = useState<string | null>(null);
  const [vinDecoding, setVinDecoding] = useState(false);
  const [vinDecoded, setVinDecoded] = useState(false);
  const [plateLooking, setPlateLooking] = useState(false);

  useEffect(() => {
    if (!isOpen) {
      setStep("concern");
      setContactSearch("");
      setContacts([]);
      setSelectedContact(null);
      setContactError("");
      setVehicles([]);
      setSelectedVehicle(null);
      setVehicleError("");
      setMileageInput("");
      setConcern("");
      setConcernStage("start");
      setQuestions([]);
      setExchanges([]);
      setAnswers({});
      setCleanedText("");
      setConversationId(null);
      setNoteText("");
      setConcernError("");
      setCreating(false);
      setCreateError("");
      setCreatedWO(null);
      setJobTab("canned");
      setSelectedJobs([]);
      setCannedJobSearch("");
      setCannedJobs([]);
      setDeferredItems([]);
      setHistorySearch("");
      setHistoryJobs([]);
      setJobsError("");
      setCreateNewCustomer(false);
      setNewCustomer({ firstName: "", lastName: "" });
      setCreatingContact(false);
      setCreateNewVehicle(false);
      setNewVehicle({});
      setCreatingVehicle(false);
      setOcrLoading(false);
      setOcrResult(null);
      setVinDecoding(false);
      setVinDecoded(false);
      setPlateLooking(false);
    }
  }, [isOpen]);

  useEffect(() => {
    if (isOpen && !roSettings) {
      fetch("/api/settings/create-ro").then(r => r.json()).then(data => {
        setRoSettings(data);
      }).catch(() => {});
    }
  }, [isOpen]);

  useEffect(() => {
    if (step === "jobs" && selectedVehicle) {
      if (deferredItems.length === 0) fetchDeferredWork();
      if (historyJobs.length === 0) searchJobHistory();
    }
  }, [step]);

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
    setMileageInput("");
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
    const conversationText = `Customer concern: ${concern.trim()}\n\n` +
      allExchanges.map(e => `Q: ${e.question}\nA: ${e.response}`).join("\n\n");
    try {
      const res = await fetch("/api/dashboard/concern-assistant", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "cleanup",
          conversationText,
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

  function isFieldVisible(section: "customer" | "vehicle", key: string): boolean {
    const fields = section === "customer" ? roSettings?.customerFields : roSettings?.vehicleFields;
    if (!fields) return true;
    return fields[key] !== "hidden";
  }

  function isFieldRequired(section: "customer" | "vehicle", key: string): boolean {
    const fields = section === "customer" ? roSettings?.customerFields : roSettings?.vehicleFields;
    if (!fields) return false;
    return fields[key] === "required";
  }

  function validateNewCustomer(): string | null {
    if (!newCustomer.firstName?.trim()) return "First name is required";
    if (!newCustomer.lastName?.trim()) return "Last name is required";
    const cf = roSettings?.customerFields || {};
    for (const [key, vis] of Object.entries(cf)) {
      if (vis === "required" && key !== "firstName" && key !== "lastName") {
        if (!newCustomer[key]?.trim()) {
          const label = key === "phone1" ? "Primary Phone" : key === "phone2" ? "Secondary Phone" : key === "postalCode" ? "Postal Code" : key.charAt(0).toUpperCase() + key.slice(1);
          return `${label} is required`;
        }
      }
    }
    return null;
  }

  function validateNewVehicle(): string | null {
    const vf = roSettings?.vehicleFields || {};
    for (const [key, vis] of Object.entries(vf)) {
      if (vis === "required" && !newVehicle[key]?.trim()) {
        const label = key === "vin" ? "VIN" : key === "licensePlate" ? "License Plate" : key.charAt(0).toUpperCase() + key.slice(1);
        return `${label} is required`;
      }
    }
    return null;
  }

  async function handleCreateContact() {
    const validationError = validateNewCustomer();
    if (validationError) {
      setContactError(validationError);
      return;
    }
    setCreatingContact(true);
    setContactError("");
    try {
      const res = await fetch("/api/dashboard/protractor/create-contact", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(newCustomer),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to create customer");
      const contact: Contact = {
        id: data.contactId,
        firstName: newCustomer.firstName || "",
        lastName: newCustomer.lastName || "",
        fileAs: `${newCustomer.lastName}, ${newCustomer.firstName}`,
        company: newCustomer.company || "",
        phone: newCustomer.phone1 || "",
        email: newCustomer.email || "",
      };
      setSelectedContact(contact);
      setCreateNewCustomer(false);
      setStep("vehicle");
      setVehicles([]);
      setVehicleError("");
      setCreateNewVehicle(false);
      setLoadingVehicles(true);
      try {
        const vRes = await fetch(`/api/dashboard/protractor/vehicles?ownerId=${data.contactId}`);
        const vData = await vRes.json();
        setVehicles(vData.vehicles || []);
        if (!vData.vehicles?.length) {
          setCreateNewVehicle(true);
        }
      } catch {
        setCreateNewVehicle(true);
      } finally {
        setLoadingVehicles(false);
      }
    } catch (err: any) {
      setContactError(err.message);
    } finally {
      setCreatingContact(false);
    }
  }

  async function handleCreateVehicle() {
    if (!selectedContact) return;
    const validationError = validateNewVehicle();
    if (validationError) {
      setVehicleError(validationError);
      return;
    }
    setCreatingVehicle(true);
    setVehicleError("");
    try {
      const res = await fetch("/api/dashboard/protractor/create-vehicle", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...newVehicle, ownerId: selectedContact.id }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to create vehicle");
      const vehicle: Vehicle = {
        id: data.vehicleId,
        vin: newVehicle.vin || "",
        year: newVehicle.year ? Number(newVehicle.year) : null,
        make: newVehicle.make || "",
        model: newVehicle.model || "",
        submodel: newVehicle.submodel || "",
        engine: newVehicle.engine || "",
        color: newVehicle.color || "",
        plate: newVehicle.licensePlate || "",
        odometer: newVehicle.odometer ? Number(newVehicle.odometer) : null,
      };
      setSelectedVehicle(vehicle);
      setCreateNewVehicle(false);
    } catch (err: any) {
      setVehicleError(err.message);
    } finally {
      setCreatingVehicle(false);
    }
  }

  async function handleVinDecode(vin: string) {
    if (!vin || vin.length !== 17) return;
    setVinDecoding(true);
    setVinDecoded(false);
    try {
      const res = await fetch(`/api/vin/decode?vin=${encodeURIComponent(vin)}`);
      const data = await res.json();
      if (data.decoded) {
        setNewVehicle(prev => ({
          ...prev,
          vin,
          year: data.year ? String(data.year) : prev.year || "",
          make: data.make || prev.make || "",
          model: data.model || prev.model || "",
          submodel: data.submodel || prev.submodel || "",
          engine: data.engine || prev.engine || "",
          transmission: data.transmission || prev.transmission || "",
        }));
        setVinDecoded(true);
      }
    } catch {
    } finally {
      setVinDecoding(false);
    }
  }

  async function handlePlateLookup() {
    const plate = (newVehicle.licensePlate || "").replace(/\s+/g, "");
    const state = newVehicle.plateState || "";
    if (!plate || !state) {
      setVehicleError("Enter both license plate and state to look up VIN");
      return;
    }
    if (UNSUPPORTED_PLATE_REGIONS[state]) {
      setVehicleError(
        `Plate lookup isn't available for ${UNSUPPORTED_PLATE_REGIONS[state]} yet — our plate-to-VIN provider only covers US states. Please enter the VIN manually.`,
      );
      return;
    }
    setPlateLooking(true);
    setVehicleError("");
    try {
      const res = await fetch("/api/vin/plate-lookup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ plate, state }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Plate lookup failed");
      if (!data.success) throw new Error(data.error || "No VIN found for this plate");
      setNewVehicle(prev => ({
        ...prev,
        vin: data.vin || prev.vin || "",
        year: data.year ? String(data.year) : prev.year || "",
        make: data.make || prev.make || "",
        model: data.model || prev.model || "",
        submodel: data.submodel || prev.submodel || "",
        engine: data.engine || prev.engine || "",
        transmission: data.transmission || prev.transmission || "",
        color: data.color || prev.color || "",
      }));
      setVinDecoded(true);
      setOcrResult(`VIN found: ${data.vin} — ${[data.year, data.make, data.model].filter(Boolean).join(" ")}`);
    } catch (err: any) {
      setVehicleError(err.message);
    } finally {
      setPlateLooking(false);
    }
  }

  async function handlePhotoUpload(file: File) {
    setOcrLoading(true);
    setOcrResult(null);
    setVehicleError("");
    try {
      const formData = new FormData();
      formData.append("image", file);
      formData.append("type", "auto");
      const res = await fetch("/api/dashboard/protractor/vin-plate-ocr", {
        method: "POST",
        body: formData,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to process image");
      const result = data.result;
      if (result.vin) {
        setNewVehicle(prev => ({ ...prev, vin: result.vin }));
        setOcrResult(`VIN detected: ${result.vin} (${result.confidence} confidence)`);
        handleVinDecode(result.vin);
      } else if (result.plate) {
        const stateAbbr = resolveStateAbbr(result.state);
        setNewVehicle(prev => ({
          ...prev,
          licensePlate: result.plate,
          ...(stateAbbr ? { plateState: stateAbbr } : {}),
        }));
        const stateMsg = stateAbbr ? ` (${stateAbbr})` : result.state ? ` (${result.state})` : "";
        setOcrResult(`Plate detected: ${result.plate}${stateMsg} (${result.confidence} confidence) — ${stateAbbr ? "Click \"Lookup VIN\" to decode" : "Select state and click \"Lookup VIN\" to decode"}`);
      } else {
        setOcrResult("Could not detect a VIN or license plate. Try a clearer photo.");
      }
    } catch (err: any) {
      setVehicleError(err.message);
    } finally {
      setOcrLoading(false);
    }
  }

  async function handleCreateWorkOrder() {
    if (!selectedContact || !selectedVehicle) return;
    setCreating(true);
    setCreateError("");
    try {
      const concernTextValue = cleanedText || concern || "";
      const res = await fetch("/api/dashboard/protractor/create-work-order", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contactId: selectedContact.id,
          vehicleId: selectedVehicle.id,
          vin: selectedVehicle.vin || undefined,
          concernText: concernTextValue || undefined,
          note: noteText.trim() || undefined,
          mileage: mileageInput ? Number(mileageInput) : undefined,
          servicePackages: selectedJobs.length > 0 ? selectedJobs : undefined,
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

  async function searchCannedJobs() {
    setSearchingCanned(true);
    setJobsError("");
    try {
      const q = cannedJobSearch.trim();
      const res = await fetch(`/api/dashboard/protractor/canned-jobs${q ? `?q=${encodeURIComponent(q)}` : ""}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to search canned jobs");
      setCannedJobs(data.jobs || []);
    } catch (err: any) {
      setJobsError(err.message);
    } finally {
      setSearchingCanned(false);
    }
  }

  async function fetchDeferredWork() {
    if (!selectedVehicle) return;
    setLoadingDeferred(true);
    setJobsError("");
    try {
      const res = await fetch(`/api/dashboard/protractor/deferred-work?vin=${selectedVehicle.vin}&serviceItemId=${selectedVehicle.id}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to load deferred work");
      setDeferredItems(data.items || []);
    } catch (err: any) {
      setJobsError(err.message);
    } finally {
      setLoadingDeferred(false);
    }
  }

  async function searchJobHistory() {
    if (!selectedVehicle) return;
    setSearchingHistory(true);
    setJobsError("");
    try {
      const params = new URLSearchParams();
      if (historySearch.trim()) params.set("q", historySearch.trim());
      if (selectedVehicle.year) params.set("year", String(selectedVehicle.year));
      if (selectedVehicle.make) params.set("make", selectedVehicle.make);
      if (selectedVehicle.model) params.set("model", selectedVehicle.model);
      if (selectedVehicle.engine) params.set("engine", selectedVehicle.engine);
      params.set("strictModel", "true");
      const res = await fetch(`/api/jobs/search?${params.toString()}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to search job history");
      setHistoryJobs(data.results || []);
    } catch (err: any) {
      setJobsError(err.message);
    } finally {
      setSearchingHistory(false);
    }
  }

  function addJob(job: SelectedJob) {
    setSelectedJobs(prev => {
      const exists = prev.some(j => j.title === job.title && j.source === job.source);
      if (exists) return prev;
      return [...prev, job];
    });
  }

  function removeJob(index: number) {
    setSelectedJobs(prev => prev.filter((_, i) => i !== index));
  }

  if (!isOpen) return null;

  const vehicleDisplay = selectedVehicle
    ? [selectedVehicle.year, selectedVehicle.make, selectedVehicle.model].filter(Boolean).join(" ")
    : "";
  const contactDisplay = selectedContact
    ? [selectedContact.firstName, selectedContact.lastName].filter(Boolean).join(" ") || selectedContact.fileAs
    : "";

  const steps: { key: Step; label: string; icon: any }[] = [
    { key: "concern", label: "Concern", icon: MessageSquareText },
    { key: "customer", label: "Customer", icon: User },
    { key: "vehicle", label: "Vehicle", icon: Car },
    { key: "note", label: "Note", icon: FileText },
    { key: "jobs", label: "Jobs", icon: Wrench },
    { key: "confirm", label: "Done", icon: CheckCircle },
  ];

  const currentStepIndex = steps.findIndex(s => s.key === step);

  const jobTabs: { key: JobTab; label: string; icon: any }[] = [
    { key: "canned", label: "Canned Jobs", icon: Package },
    { key: "deferred", label: "Deferred Work", icon: Clock },
    { key: "history", label: "History", icon: History },
  ];

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
              <div className="flex gap-2 mb-2">
                <button
                  onClick={() => { setCreateNewCustomer(false); setContactError(""); }}
                  className={`flex-1 flex items-center justify-center gap-2 px-3 py-2 rounded-lg border text-sm font-medium transition-colors ${
                    !createNewCustomer ? "border-blue-500 bg-blue-50 text-blue-700" : "border-gray-200 text-gray-600 hover:bg-gray-50"
                  }`}
                >
                  <Search className="w-4 h-4" /> Search Existing
                </button>
                <button
                  onClick={() => { setCreateNewCustomer(true); setContactError(""); }}
                  className={`flex-1 flex items-center justify-center gap-2 px-3 py-2 rounded-lg border text-sm font-medium transition-colors ${
                    createNewCustomer ? "border-green-500 bg-green-50 text-green-700" : "border-gray-200 text-gray-600 hover:bg-gray-50"
                  }`}
                >
                  <UserPlus className="w-4 h-4" /> Create New
                </button>
              </div>

              {!createNewCustomer ? (
                <>
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
                </>
              ) : (
                <div className="space-y-3">
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-xs font-medium text-gray-700 mb-1">
                        First Name <span className="text-red-500">*</span>
                      </label>
                      <input type="text" value={newCustomer.firstName || ""} onChange={e => setNewCustomer(p => ({ ...p, firstName: e.target.value }))} className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500" autoFocus />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-gray-700 mb-1">
                        Last Name <span className="text-red-500">*</span>
                      </label>
                      <input type="text" value={newCustomer.lastName || ""} onChange={e => setNewCustomer(p => ({ ...p, lastName: e.target.value }))} className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500" />
                    </div>
                  </div>
                  {isFieldVisible("customer", "phone1") && (
                    <div>
                      <label className="block text-xs font-medium text-gray-700 mb-1">
                        Primary Phone {isFieldRequired("customer", "phone1") && <span className="text-red-500">*</span>}
                      </label>
                      <input type="tel" value={newCustomer.phone1 || ""} onChange={e => setNewCustomer(p => ({ ...p, phone1: e.target.value }))} placeholder="(555) 123-4567" className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500" />
                    </div>
                  )}
                  {isFieldVisible("customer", "phone2") && (
                    <div>
                      <label className="block text-xs font-medium text-gray-700 mb-1">
                        Secondary Phone {isFieldRequired("customer", "phone2") && <span className="text-red-500">*</span>}
                      </label>
                      <input type="tel" value={newCustomer.phone2 || ""} onChange={e => setNewCustomer(p => ({ ...p, phone2: e.target.value }))} className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500" />
                    </div>
                  )}
                  {isFieldVisible("customer", "email") && (
                    <div>
                      <label className="block text-xs font-medium text-gray-700 mb-1">
                        Email {isFieldRequired("customer", "email") && <span className="text-red-500">*</span>}
                      </label>
                      <input type="email" value={newCustomer.email || ""} onChange={e => setNewCustomer(p => ({ ...p, email: e.target.value }))} className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500" />
                    </div>
                  )}
                  {isFieldVisible("customer", "company") && (
                    <div>
                      <label className="block text-xs font-medium text-gray-700 mb-1">
                        Company {isFieldRequired("customer", "company") && <span className="text-red-500">*</span>}
                      </label>
                      <input type="text" value={newCustomer.company || ""} onChange={e => setNewCustomer(p => ({ ...p, company: e.target.value }))} className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500" />
                    </div>
                  )}
                  {(isFieldVisible("customer", "street") || isFieldVisible("customer", "city") || isFieldVisible("customer", "province") || isFieldVisible("customer", "postalCode")) && (
                    <div className="space-y-3">
                      <label className="block text-xs font-medium text-gray-500 uppercase tracking-wide">Address</label>
                      {isFieldVisible("customer", "street") && (
                        <input type="text" value={newCustomer.street || ""} onChange={e => setNewCustomer(p => ({ ...p, street: e.target.value }))} placeholder="Street address" className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500" />
                      )}
                      <div className="grid grid-cols-3 gap-2">
                        {isFieldVisible("customer", "city") && (
                          <input type="text" value={newCustomer.city || ""} onChange={e => setNewCustomer(p => ({ ...p, city: e.target.value }))} placeholder="City" className="px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500" />
                        )}
                        {isFieldVisible("customer", "province") && (
                          <input type="text" value={newCustomer.province || ""} onChange={e => setNewCustomer(p => ({ ...p, province: e.target.value }))} placeholder="Province" className="px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500" />
                        )}
                        {isFieldVisible("customer", "postalCode") && (
                          <input type="text" value={newCustomer.postalCode || ""} onChange={e => setNewCustomer(p => ({ ...p, postalCode: e.target.value }))} placeholder="Postal Code" className="px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500" />
                        )}
                      </div>
                    </div>
                  )}
                  {isFieldVisible("customer", "marketingSource") && (
                    <div>
                      <label className="block text-xs font-medium text-gray-700 mb-1">
                        Marketing Source {isFieldRequired("customer", "marketingSource") && <span className="text-red-500">*</span>}
                      </label>
                      {roSettings?.marketingSources && roSettings.marketingSources.length > 0 ? (
                        <select value={newCustomer.marketingSource || ""} onChange={e => setNewCustomer(p => ({ ...p, marketingSource: e.target.value }))} className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500">
                          <option value="">Select source...</option>
                          {roSettings.marketingSources.map(s => <option key={s} value={s}>{s}</option>)}
                        </select>
                      ) : (
                        <input type="text" value={newCustomer.marketingSource || ""} onChange={e => setNewCustomer(p => ({ ...p, marketingSource: e.target.value }))} placeholder="How did customer find you?" className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500" />
                      )}
                    </div>
                  )}
                  {isFieldVisible("customer", "note") && (
                    <div>
                      <label className="block text-xs font-medium text-gray-700 mb-1">Contact Note</label>
                      <textarea value={newCustomer.note || ""} onChange={e => setNewCustomer(p => ({ ...p, note: e.target.value }))} rows={2} className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 resize-none" />
                    </div>
                  )}
                  <button
                    onClick={handleCreateContact}
                    disabled={!newCustomer.firstName?.trim() || !newCustomer.lastName?.trim() || creatingContact}
                    className="w-full flex items-center justify-center gap-2 px-4 py-2.5 bg-green-600 text-white text-sm font-medium rounded-lg hover:bg-green-700 disabled:opacity-50"
                  >
                    {creatingContact ? <Loader2 className="w-4 h-4 animate-spin" /> : <UserPlus className="w-4 h-4" />}
                    Create Customer & Continue
                  </button>
                </div>
              )}

              {contactError && (
                <p className="text-sm text-amber-600 flex items-center gap-1.5">
                  <AlertTriangle className="w-4 h-4" /> {contactError}
                </p>
              )}
            </div>
          )}

          {step === "vehicle" && (
            <div className="space-y-4">
              <div className="flex items-center gap-2 text-sm text-gray-600 bg-gray-50 px-3 py-2 rounded-lg">
                <User className="w-4 h-4 text-blue-500" />
                <span className="font-medium">{contactDisplay}</span>
                {(cleanedText || concern) && (
                  <>
                    <span className="text-gray-300 mx-1">|</span>
                    <MessageSquareText className="w-4 h-4 text-green-500" />
                    <span className="text-green-600 text-xs">Concern attached</span>
                  </>
                )}
              </div>

              {!createNewVehicle && !selectedVehicle && (
                <div className="flex gap-2 mb-2">
                  <button
                    onClick={() => { setCreateNewVehicle(false); setVehicleError(""); }}
                    className={`flex-1 flex items-center justify-center gap-2 px-3 py-2 rounded-lg border text-sm font-medium transition-colors ${
                      !createNewVehicle ? "border-blue-500 bg-blue-50 text-blue-700" : "border-gray-200 text-gray-600 hover:bg-gray-50"
                    }`}
                  >
                    <Search className="w-4 h-4" /> Select Existing
                  </button>
                  <button
                    onClick={() => { setCreateNewVehicle(true); setVehicleError(""); }}
                    className={`flex-1 flex items-center justify-center gap-2 px-3 py-2 rounded-lg border text-sm font-medium transition-colors ${
                      createNewVehicle ? "border-green-500 bg-green-50 text-green-700" : "border-gray-200 text-gray-600 hover:bg-gray-50"
                    }`}
                  >
                    <Plus className="w-4 h-4" /> Create New
                  </button>
                </div>
              )}

              {!createNewVehicle && !selectedVehicle && (
                <>
                  {loadingVehicles ? (
                    <div className="flex items-center justify-center py-12">
                      <Loader2 className="w-6 h-6 animate-spin text-blue-500" />
                      <span className="ml-2 text-sm text-gray-500">Loading vehicles...</span>
                    </div>
                  ) : vehicles.length > 0 ? (
                    <div className="space-y-1.5 max-h-60 overflow-y-auto">
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
                  ) : !loadingVehicles && vehicleError ? (
                    <div className="text-center py-6 space-y-3">
                      <p className="text-sm text-amber-600 flex items-center justify-center gap-1.5">
                        <AlertTriangle className="w-4 h-4" /> {vehicleError}
                      </p>
                      <button
                        onClick={() => { setCreateNewVehicle(true); setVehicleError(""); }}
                        className="inline-flex items-center gap-2 px-4 py-2 bg-green-600 text-white text-sm font-medium rounded-lg hover:bg-green-700"
                      >
                        <Plus className="w-4 h-4" /> Create New Vehicle
                      </button>
                    </div>
                  ) : null}
                </>
              )}

              {createNewVehicle && !selectedVehicle && (
                <div className="space-y-3">
                  <div className="flex items-center justify-between">
                    <label className="block text-sm font-medium text-gray-700">New Vehicle</label>
                    {vehicles.length > 0 && (
                      <button onClick={() => { setCreateNewVehicle(false); setVehicleError(""); }} className="text-xs text-blue-600 hover:text-blue-700">
                        Back to list
                      </button>
                    )}
                  </div>

                  <div className="flex gap-2">
                    <label className="flex-1 flex items-center justify-center gap-2 px-3 py-2.5 border-2 border-dashed border-gray-300 rounded-lg text-sm text-gray-600 hover:border-blue-400 hover:text-blue-600 hover:bg-blue-50 cursor-pointer transition-colors">
                      <Camera className="w-4 h-4" />
                      {ocrLoading ? "Processing..." : "Scan VIN / Plate Photo"}
                      <input
                        type="file"
                        accept="image/*"
                        capture="environment"
                        className="hidden"
                        onChange={e => {
                          const file = e.target.files?.[0];
                          if (file) handlePhotoUpload(file);
                          e.target.value = "";
                        }}
                        disabled={ocrLoading}
                      />
                    </label>
                  </div>
                  {ocrLoading && (
                    <div className="flex items-center gap-2 text-sm text-blue-600">
                      <Loader2 className="w-4 h-4 animate-spin" /> Analyzing photo with AI...
                    </div>
                  )}
                  {ocrResult && (
                    <p className="text-xs text-green-700 bg-green-50 border border-green-200 rounded-lg px-3 py-2">
                      {ocrResult}
                    </p>
                  )}

                  <div className="grid grid-cols-2 gap-3">
                    {isFieldVisible("vehicle", "vin") && (
                      <div className="col-span-2">
                        <label className="block text-xs font-medium text-gray-700 mb-1">
                          VIN {isFieldRequired("vehicle", "vin") && <span className="text-red-500">*</span>}
                        </label>
                        <div className="flex gap-2">
                          <input
                            type="text"
                            value={newVehicle.vin || ""}
                            onChange={e => {
                              const v = e.target.value.toUpperCase();
                              setNewVehicle(p => ({ ...p, vin: v }));
                              setVinDecoded(false);
                            }}
                            onBlur={e => {
                              const v = e.target.value.trim();
                              if (v.length === 17) handleVinDecode(v);
                            }}
                            maxLength={17}
                            placeholder="17-character VIN"
                            className={`flex-1 px-3 py-2 border rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 font-mono ${
                              vinDecoded ? "border-green-400 bg-green-50" : "border-gray-300"
                            }`}
                          />
                          {vinDecoding && <Loader2 className="w-5 h-5 animate-spin text-blue-500 mt-2" />}
                          {vinDecoded && <CheckCircle className="w-5 h-5 text-green-500 mt-2" />}
                        </div>
                        {vinDecoded && (
                          <p className="text-xs text-green-600 mt-1">VIN decoded — vehicle details auto-filled</p>
                        )}
                        {(newVehicle.vin || "").length === 17 && !vinDecoded && !vinDecoding && (
                          <button onClick={() => handleVinDecode(newVehicle.vin || "")} className="text-xs text-blue-600 hover:text-blue-700 mt-1">
                            Decode VIN
                          </button>
                        )}
                      </div>
                    )}
                    {isFieldVisible("vehicle", "year") && (
                      <div>
                        <label className="block text-xs font-medium text-gray-700 mb-1">
                          Year {isFieldRequired("vehicle", "year") && <span className="text-red-500">*</span>}
                        </label>
                        <input type="number" value={newVehicle.year || ""} onChange={e => setNewVehicle(p => ({ ...p, year: e.target.value }))} placeholder="2024" className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500" />
                      </div>
                    )}
                    {isFieldVisible("vehicle", "make") && (
                      <div>
                        <label className="block text-xs font-medium text-gray-700 mb-1">
                          Make {isFieldRequired("vehicle", "make") && <span className="text-red-500">*</span>}
                        </label>
                        <input type="text" value={newVehicle.make || ""} onChange={e => setNewVehicle(p => ({ ...p, make: e.target.value }))} placeholder="Toyota" className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500" />
                      </div>
                    )}
                    {isFieldVisible("vehicle", "model") && (
                      <div>
                        <label className="block text-xs font-medium text-gray-700 mb-1">
                          Model {isFieldRequired("vehicle", "model") && <span className="text-red-500">*</span>}
                        </label>
                        <input type="text" value={newVehicle.model || ""} onChange={e => setNewVehicle(p => ({ ...p, model: e.target.value }))} placeholder="Camry" className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500" />
                      </div>
                    )}
                    {isFieldVisible("vehicle", "submodel") && (
                      <div>
                        <label className="block text-xs font-medium text-gray-700 mb-1">
                          Submodel {isFieldRequired("vehicle", "submodel") && <span className="text-red-500">*</span>}
                        </label>
                        <input type="text" value={newVehicle.submodel || ""} onChange={e => setNewVehicle(p => ({ ...p, submodel: e.target.value }))} placeholder="SE, LE, XLE" className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500" />
                      </div>
                    )}
                    {isFieldVisible("vehicle", "color") && (
                      <div>
                        <label className="block text-xs font-medium text-gray-700 mb-1">
                          Color {isFieldRequired("vehicle", "color") && <span className="text-red-500">*</span>}
                        </label>
                        <input type="text" value={newVehicle.color || ""} onChange={e => setNewVehicle(p => ({ ...p, color: e.target.value }))} placeholder="Silver" className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500" />
                      </div>
                    )}
                    {isFieldVisible("vehicle", "engine") && (
                      <div>
                        <label className="block text-xs font-medium text-gray-700 mb-1">
                          Engine {isFieldRequired("vehicle", "engine") && <span className="text-red-500">*</span>}
                        </label>
                        <input type="text" value={newVehicle.engine || ""} onChange={e => setNewVehicle(p => ({ ...p, engine: e.target.value }))} placeholder="2.5L 4-Cyl" className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500" />
                      </div>
                    )}
                    {isFieldVisible("vehicle", "transmission") && (
                      <div>
                        <label className="block text-xs font-medium text-gray-700 mb-1">
                          Transmission {isFieldRequired("vehicle", "transmission") && <span className="text-red-500">*</span>}
                        </label>
                        <input type="text" value={newVehicle.transmission || ""} onChange={e => setNewVehicle(p => ({ ...p, transmission: e.target.value }))} placeholder="Automatic" className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500" />
                      </div>
                    )}
                    {isFieldVisible("vehicle", "odometer") && (
                      <div>
                        <label className="block text-xs font-medium text-gray-700 mb-1">
                          Odometer {isFieldRequired("vehicle", "odometer") && <span className="text-red-500">*</span>}
                        </label>
                        <input type="number" value={newVehicle.odometer || ""} onChange={e => setNewVehicle(p => ({ ...p, odometer: e.target.value }))} placeholder="45000" className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500" />
                      </div>
                    )}
                    {isFieldVisible("vehicle", "licensePlate") && (
                      <div className="col-span-2">
                        <label className="block text-xs font-medium text-gray-700 mb-1">
                          License Plate {isFieldRequired("vehicle", "licensePlate") && <span className="text-red-500">*</span>}
                        </label>
                        <div className="flex gap-2">
                          <input type="text" value={newVehicle.licensePlate || ""} onChange={e => setNewVehicle(p => ({ ...p, licensePlate: e.target.value.toUpperCase() }))} placeholder="ABC1234" className="flex-1 px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500" />
                          <select
                            value={newVehicle.plateState || ""}
                            onChange={e => setNewVehicle(p => ({ ...p, plateState: e.target.value }))}
                            className="w-20 px-2 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 bg-white"
                          >
                            <option value="">State</option>
                            <optgroup label="US States">
                              {US_STATES.map(s => (
                                <option key={s} value={s}>{s}</option>
                              ))}
                            </optgroup>
                            <optgroup label="Canadian Provinces (plate lookup not supported)">
                              {CA_PROVINCES.map(s => (
                                <option key={s} value={s}>{s}</option>
                              ))}
                            </optgroup>
                          </select>
                          <button
                            onClick={handlePlateLookup}
                            disabled={plateLooking || !newVehicle.licensePlate || !newVehicle.plateState}
                            className="px-3 py-2 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap flex items-center gap-1.5"
                          >
                            {plateLooking ? <Loader2 className="w-4 h-4 animate-spin" /> : <Search className="w-4 h-4" />}
                            Lookup VIN
                          </button>
                        </div>
                      </div>
                    )}
                  </div>

                  {vehicleError && (
                    <p className="text-sm text-amber-600 flex items-center gap-1.5">
                      <AlertTriangle className="w-4 h-4" /> {vehicleError}
                    </p>
                  )}

                  <button
                    onClick={handleCreateVehicle}
                    disabled={creatingVehicle}
                    className="w-full flex items-center justify-center gap-2 px-4 py-2.5 bg-green-600 text-white text-sm font-medium rounded-lg hover:bg-green-700 disabled:opacity-50"
                  >
                    {creatingVehicle ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
                    Create Vehicle & Continue
                  </button>
                </div>
              )}

              {selectedVehicle && (
                <div className="pt-2 space-y-3">
                  <div className="p-3 bg-blue-50 border border-blue-200 rounded-lg">
                    <div className="font-medium text-blue-900 text-sm flex items-center gap-2">
                      <CheckCircle className="w-4 h-4 text-blue-600" />
                      {[selectedVehicle.year, selectedVehicle.make, selectedVehicle.model].filter(Boolean).join(" ")}
                    </div>
                    <div className="text-xs text-blue-700 mt-0.5">
                      {selectedVehicle.vin && <span>VIN: {selectedVehicle.vin} </span>}
                      {selectedVehicle.plate && <span>Plate: {selectedVehicle.plate}</span>}
                    </div>
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Current Mileage <span className="text-gray-400 font-normal">(optional)</span>
                    </label>
                    <div className="flex items-center gap-2">
                      <input
                        type="number"
                        value={mileageInput}
                        onChange={e => setMileageInput(e.target.value)}
                        placeholder="Enter current mileage..."
                        className="flex-1 px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                      />
                      <span className="text-xs text-gray-400">miles</span>
                    </div>
                    {selectedVehicle.odometer && (
                      <p className="text-xs text-gray-400 mt-1">
                        Last known reading: {selectedVehicle.odometer.toLocaleString()} mi — enter actual mileage if available
                      </p>
                    )}
                  </div>
                  <button
                    onClick={() => setStep("note")}
                    className="w-full flex items-center justify-center gap-2 px-4 py-2.5 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700"
                  >
                    Next
                    <ChevronRight className="w-4 h-4" />
                  </button>
                </div>
              )}
            </div>
          )}

          {step === "concern" && (
            <div className="space-y-4">
              {concernStage === "start" && (
                <div className="space-y-3">
                  <label className="block text-sm font-medium text-gray-700">
                    Customer Concern <span className="text-gray-400 font-normal">(optional)</span>
                  </label>
                  <p className="text-xs text-gray-500">Describe the customer's issue to generate a structured write-up with AI-guided follow-up questions.</p>
                  <textarea
                    value={concern}
                    onChange={e => setConcern(e.target.value)}
                    placeholder="What did the customer say? e.g. 'Car is making a grinding noise when braking...'"
                    className="w-full px-3 py-2.5 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 resize-none"
                    rows={4}
                    autoFocus
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
                      onClick={() => setStep("customer")}
                      className="flex items-center gap-2 px-4 py-2 text-gray-700 border border-gray-300 text-sm font-medium rounded-lg hover:bg-gray-50"
                    >
                      Skip
                      <ChevronRight className="w-4 h-4" />
                    </button>
                  </div>
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
                      onClick={() => setStep("customer")}
                      className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700"
                    >
                      Next: Select Customer
                      <ChevronRight className="w-4 h-4" />
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}

          {step === "note" && (
            <div className="space-y-4">
              <div className="flex items-center gap-2 text-sm text-gray-600 bg-gray-50 px-3 py-2 rounded-lg flex-wrap">
                <User className="w-4 h-4 text-blue-500" />
                <span className="font-medium">{contactDisplay}</span>
                <span className="text-gray-300 mx-1">|</span>
                <Car className="w-4 h-4 text-blue-500" />
                <span className="font-medium">{vehicleDisplay}</span>
                {(cleanedText || concern) && (
                  <>
                    <span className="text-gray-300 mx-1">|</span>
                    <MessageSquareText className="w-4 h-4 text-green-500" />
                    <span className="text-green-600 text-xs">Concern attached</span>
                  </>
                )}
              </div>

              <div className="space-y-2">
                <label className="block text-sm font-medium text-gray-700">
                  Work Order Note <span className="text-gray-400 font-normal">(optional)</span>
                </label>
                <textarea
                  value={noteText}
                  onChange={e => setNoteText(e.target.value)}
                  placeholder="Add any additional notes for this work order..."
                  className="w-full px-3 py-2.5 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 resize-none"
                  rows={4}
                  autoFocus
                />
              </div>

              <button
                onClick={() => setStep("jobs")}
                className="w-full flex items-center justify-center gap-2 px-4 py-2.5 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700"
              >
                Next: Add Jobs
                <ChevronRight className="w-4 h-4" />
              </button>
              {createError && <p className="text-sm text-red-600">{createError}</p>}
            </div>
          )}

          {step === "jobs" && (
            <div className="space-y-4">
              <div className="flex items-center gap-2 text-sm text-gray-600 bg-gray-50 px-3 py-2 rounded-lg flex-wrap">
                <User className="w-4 h-4 text-blue-500" />
                <span className="font-medium">{contactDisplay}</span>
                <span className="text-gray-300 mx-1">|</span>
                <Car className="w-4 h-4 text-blue-500" />
                <span className="font-medium">{vehicleDisplay}</span>
                {(cleanedText || concern) && (
                  <>
                    <span className="text-gray-300 mx-1">|</span>
                    <MessageSquareText className="w-4 h-4 text-green-500" />
                    <span className="text-green-600 text-xs">Concern attached</span>
                  </>
                )}
              </div>

              <div className="flex border-b border-gray-200">
                {jobTabs.map(t => {
                  const Icon = t.icon;
                  const isActive = jobTab === t.key;
                  return (
                    <button
                      key={t.key}
                      onClick={() => setJobTab(t.key)}
                      className={`flex items-center gap-1.5 px-4 py-2.5 text-sm font-medium border-b-2 transition-colors ${
                        isActive
                          ? "border-blue-600 text-blue-600"
                          : "border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300"
                      }`}
                    >
                      <Icon className="w-4 h-4" />
                      {t.label}
                    </button>
                  );
                })}
              </div>

              {jobsError && (
                <p className="text-sm text-red-600 flex items-center gap-1.5">
                  <AlertTriangle className="w-4 h-4" /> {jobsError}
                </p>
              )}

              {jobTab === "canned" && (
                <div className="space-y-3">
                  <div className="flex gap-2">
                    <div className="relative flex-1">
                      <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
                      <input
                        type="text"
                        value={cannedJobSearch}
                        onChange={e => setCannedJobSearch(e.target.value)}
                        onKeyDown={e => e.key === "Enter" && searchCannedJobs()}
                        placeholder="Search canned jobs..."
                        className="w-full pl-9 pr-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                      />
                    </div>
                    <button
                      onClick={searchCannedJobs}
                      disabled={searchingCanned}
                      className="px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 disabled:opacity-50 flex items-center gap-2"
                    >
                      {searchingCanned ? <Loader2 className="w-4 h-4 animate-spin" /> : <Search className="w-4 h-4" />}
                      Search
                    </button>
                  </div>
                  {cannedJobs.length > 0 && (
                    <div className="space-y-1.5 max-h-48 overflow-y-auto">
                      {cannedJobs.map((job: any, idx: number) => (
                        <div key={idx} className="flex items-center justify-between p-2.5 border border-gray-200 rounded-lg hover:bg-gray-50">
                          <div className="min-w-0 flex-1">
                            <div className="text-sm font-medium text-gray-900 truncate">{job.title || job.name || "Untitled"}</div>
                            <div className="text-xs text-gray-500 flex items-center gap-2 mt-0.5">
                              {job.code && <span>Code: {job.code}</span>}
                              {job.chapter && <span>Chapter: {job.chapter}</span>}
                              {job.lines?.length > 0 && <span className="text-green-600">{job.lines.length} line{job.lines.length !== 1 ? "s" : ""}</span>}
                            </div>
                          </div>
                          <button
                            onClick={() => addJob({ source: "canned", title: job.title || job.name || "Untitled", code: job.code, chapter: job.chapter, deferredId: job.id, lines: job.lines })}
                            className="ml-2 px-3 py-1.5 bg-blue-50 text-blue-600 text-xs font-medium rounded-md hover:bg-blue-100 flex items-center gap-1 flex-shrink-0"
                          >
                            <Plus className="w-3.5 h-3.5" />
                            Add
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                  {!searchingCanned && cannedJobs.length === 0 && (
                    <p className="text-sm text-gray-500 text-center py-4">Search for canned jobs to add to the work order.</p>
                  )}
                </div>
              )}

              {jobTab === "deferred" && (
                <div className="space-y-3">
                  {loadingDeferred ? (
                    <div className="flex items-center justify-center py-8">
                      <Loader2 className="w-5 h-5 animate-spin text-blue-500" />
                      <span className="ml-2 text-sm text-gray-500">Loading deferred work...</span>
                    </div>
                  ) : deferredItems.length > 0 ? (
                    <div className="space-y-1.5 max-h-48 overflow-y-auto">
                      {deferredItems.map((item: any, idx: number) => (
                        <div key={idx} className="flex items-center justify-between p-2.5 border border-gray-200 rounded-lg hover:bg-gray-50">
                          <div className="min-w-0 flex-1">
                            <div className="text-sm font-medium text-gray-900 truncate">{item.title || item.name || "Untitled"}</div>
                            <div className="text-xs text-gray-500 mt-0.5">
                              {item.description && <span className="block truncate">{item.description}</span>}
                              <span className="flex items-center gap-2 mt-0.5">
                                {item.originalWorkOrderNumber && <span>WO #{item.originalWorkOrderNumber}</span>}
                                {item.date && <span>{new Date(item.date).toLocaleDateString()}</span>}
                                {item.lines?.length > 0 && <span className="text-green-600">{item.lines.length} line{item.lines.length !== 1 ? "s" : ""}</span>}
                              </span>
                            </div>
                          </div>
                          <button
                            onClick={() => addJob({ source: "deferred", title: item.title || item.name || "Untitled", description: item.description, code: item.code, chapter: item.chapter || "Service", originalWorkOrderId: item.originalWorkOrderId, deferredId: item.id, lines: item.lines })}
                            className="ml-2 px-3 py-1.5 bg-blue-50 text-blue-600 text-xs font-medium rounded-md hover:bg-blue-100 flex items-center gap-1 flex-shrink-0"
                          >
                            <Plus className="w-3.5 h-3.5" />
                            Add
                          </button>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="text-sm text-gray-500 text-center py-8">No deferred work found for this vehicle.</p>
                  )}
                </div>
              )}

              {jobTab === "history" && (
                <div className="space-y-3">
                  <div className="flex gap-2">
                    <div className="relative flex-1">
                      <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
                      <input
                        type="text"
                        value={historySearch}
                        onChange={e => setHistorySearch(e.target.value)}
                        onKeyDown={e => e.key === "Enter" && searchJobHistory()}
                        placeholder="Search job history..."
                        className="w-full pl-9 pr-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                      />
                    </div>
                    <button
                      onClick={searchJobHistory}
                      disabled={searchingHistory}
                      className="px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 disabled:opacity-50 flex items-center gap-2"
                    >
                      {searchingHistory ? <Loader2 className="w-4 h-4 animate-spin" /> : <Search className="w-4 h-4" />}
                      Search
                    </button>
                  </div>
                  {searchingHistory ? (
                    <div className="flex items-center justify-center py-8">
                      <Loader2 className="w-5 h-5 animate-spin text-blue-500" />
                      <span className="ml-2 text-sm text-gray-500">Searching history...</span>
                    </div>
                  ) : historyJobs.length > 0 ? (
                    <div className="space-y-1.5 max-h-64 overflow-y-auto">
                      {historyJobs.map((job: any, idx: number) => {
                        const title = job.job?.title || job.job?.name || job.title || "Untitled";
                        const vehicleInfo = job.vehicle;
                        const vehicleLabel = vehicleInfo ? `${vehicleInfo.year || ""} ${vehicleInfo.make || ""} ${vehicleInfo.model || ""}`.trim() : "";
                        const isExactVehicle = selectedVehicle && vehicleInfo?.make?.toLowerCase() === selectedVehicle.make?.toLowerCase() && vehicleInfo?.model?.toLowerCase() === selectedVehicle.model?.toLowerCase();
                        const bandColors: Record<string, string> = {
                          exact: "bg-green-100 text-green-700",
                          likely: "bg-blue-100 text-blue-700",
                          possible: "bg-yellow-100 text-yellow-700",
                          poor: "bg-gray-100 text-gray-500",
                        };
                        const isExpanded = expandedHistoryIdx === idx;
                        const lines = job.lines || [];
                        return (
                        <div key={idx} className={`border rounded-lg ${
                          !isExactVehicle ? "border-purple-200 bg-purple-50/30" : "border-gray-200"
                        }`}>
                          <div className="flex items-center justify-between p-2.5 hover:bg-gray-50 cursor-pointer" onClick={() => setExpandedHistoryIdx(isExpanded ? null : idx)}>
                            <div className="min-w-0 flex-1">
                              <div className="flex items-center gap-1.5">
                                <ChevronDown className={`w-3.5 h-3.5 text-gray-400 flex-shrink-0 transition-transform ${isExpanded ? "rotate-180" : ""}`} />
                                <span className="text-sm font-medium text-gray-900 truncate">{title}</span>
                                {job.matchBandLabel && (
                                  <span className={`text-[9px] font-semibold uppercase px-1 py-0.5 rounded flex-shrink-0 ${bandColors[job.matchBand] || "bg-gray-100 text-gray-500"}`}>{job.matchBandLabel}</span>
                                )}
                              </div>
                              <div className="text-xs text-gray-500 flex items-center gap-2 mt-0.5 flex-wrap pl-5">
                                {job.performedAt && <span>{new Date(job.performedAt).toLocaleDateString()}</span>}
                                {lines.length > 0 && <span className="text-green-600">{lines.length} line{lines.length !== 1 ? "s" : ""}</span>}
                                {vehicleLabel && !isExactVehicle && (
                                  <span className="text-purple-500">{vehicleLabel}</span>
                                )}
                                {job.locationName && !job.isCurrentLocation && (
                                  <span className="text-indigo-500">{job.locationName}</span>
                                )}
                              </div>
                            </div>
                            <button
                              onClick={(e) => { e.stopPropagation(); addJob({ source: "history", title, description: job.job?.description || "", code: job.job?.code || "", chapter: "Service", lines }); }}
                              className="ml-2 px-3 py-1.5 bg-blue-50 text-blue-600 text-xs font-medium rounded-md hover:bg-blue-100 flex items-center gap-1 flex-shrink-0"
                            >
                              <Plus className="w-3.5 h-3.5" />
                              Add
                            </button>
                          </div>
                          {isExpanded && lines.length > 0 && (
                            <div className="px-3 pb-2.5 pt-0 border-t border-gray-100">
                              <table className="w-full text-xs mt-1.5">
                                <thead>
                                  <tr className="text-gray-400 text-left">
                                    <th className="font-medium pb-1 pr-2">Type</th>
                                    <th className="font-medium pb-1 pr-2">Description</th>
                                    <th className="font-medium pb-1 text-right">Qty</th>
                                    <th className="font-medium pb-1 text-right">Price</th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {lines.map((line: any, li: number) => (
                                    <tr key={li} className="text-gray-600">
                                      <td className="pr-2 py-0.5 whitespace-nowrap">{line.lineType || line.type || "—"}</td>
                                      <td className="pr-2 py-0.5 truncate max-w-[180px]">{line.description || "—"}</td>
                                      <td className="py-0.5 text-right whitespace-nowrap">{line.quantity ?? line.qty ?? "—"}</td>
                                      <td className="py-0.5 text-right whitespace-nowrap">{line.price != null ? `$${Number(line.price).toFixed(2)}` : (line.total != null ? `$${Number(line.total).toFixed(2)}` : "—")}</td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            </div>
                          )}
                          {isExpanded && lines.length === 0 && (
                            <div className="px-3 pb-2.5 pt-1 border-t border-gray-100">
                              <p className="text-xs text-gray-400 italic">No line details available</p>
                            </div>
                          )}
                        </div>
                        );
                      })}
                    </div>
                  ) : (
                    <p className="text-sm text-gray-500 text-center py-4">No job history found. Try searching or check back later.</p>
                  )}
                </div>
              )}

              {selectedJobs.length > 0 && (
                <div className="border border-gray-200 rounded-lg p-3 space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-medium text-gray-700">Selected Jobs ({selectedJobs.length})</span>
                  </div>
                  <div className="space-y-1.5 max-h-32 overflow-y-auto">
                    {selectedJobs.map((job, idx) => (
                      <div key={idx} className="flex items-center justify-between py-1.5 px-2 bg-gray-50 rounded-md">
                        <div className="flex items-center gap-2 min-w-0 flex-1">
                          <span className={`text-[10px] font-semibold uppercase px-1.5 py-0.5 rounded ${
                            job.source === "canned" ? "bg-blue-100 text-blue-700" :
                            job.source === "deferred" ? "bg-amber-100 text-amber-700" :
                            "bg-purple-100 text-purple-700"
                          }`}>
                            {job.source}
                          </span>
                          <span className="text-sm text-gray-800 truncate">{job.title}</span>
                          {job.lines && job.lines.length > 0 && (
                            <span className="text-[10px] text-green-600 flex-shrink-0">{job.lines.length} line{job.lines.length !== 1 ? "s" : ""}</span>
                          )}
                        </div>
                        <button
                          onClick={() => removeJob(idx)}
                          className="ml-2 p-1 text-gray-400 hover:text-red-500 rounded flex-shrink-0"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              <div className="flex gap-2 pt-1">
                <button
                  onClick={handleCreateWorkOrder}
                  disabled={creating}
                  className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 bg-green-600 text-white text-sm font-medium rounded-lg hover:bg-green-700 disabled:opacity-50"
                >
                  {creating ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
                  {selectedJobs.length > 0
                    ? `Create Work Order with ${selectedJobs.length} Job${selectedJobs.length > 1 ? "s" : ""}`
                    : "Skip & Create Work Order"}
                </button>
              </div>
              {createError && <p className="text-sm text-red-600">{createError}</p>}
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
                if (step === "customer") setStep("concern");
                if (step === "vehicle") setStep("customer");
                if (step === "note") setStep("vehicle");
                if (step === "jobs") setStep("note");
              }}
              disabled={step === "concern"}
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
