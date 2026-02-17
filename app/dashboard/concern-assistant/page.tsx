"use client";

import { useState, useEffect } from "react";
import {
  MessageSquareText,
  Send,
  RotateCcw,
  Copy,
  Upload,
  ChevronDown,
  Loader2,
  CheckCircle,
  Plus,
  HelpCircle
} from "lucide-react";

interface WorkOrder {
  id: string;
  number: number;
  status: string;
  contactId: string;
  contactName: string | null;
  serviceItemId: string;
  vehicle: string | null;
  vin: string | null;
}

interface Exchange {
  question: string;
  response: string;
}

type Stage = "start" | "questions" | "result";

export default function ConcernAssistantPage() {
  const [stage, setStage] = useState<Stage>("start");
  const [concern, setConcern] = useState("");
  const [questions, setQuestions] = useState<string[]>([]);
  const [exchanges, setExchanges] = useState<Exchange[]>([]);
  const [answers, setAnswers] = useState<Record<number, string>>({});
  const [cleanedText, setCleanedText] = useState("");
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const [injected, setInjected] = useState(false);
  const [injecting, setInjecting] = useState(false);

  const [workOrders, setWorkOrders] = useState<WorkOrder[]>([]);
  const [selectedWO, setSelectedWO] = useState<string>("");
  const [loadingWOs, setLoadingWOs] = useState(false);
  const [woDropdownOpen, setWoDropdownOpen] = useState(false);

  useEffect(() => {
    loadWorkOrders();
  }, []);

  async function loadWorkOrders() {
    setLoadingWOs(true);
    try {
      const res = await fetch("/api/dashboard/concern-assistant", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "get-work-orders" }),
      });
      const data = await res.json();
      if (data.ok && data.workOrders) {
        setWorkOrders(data.workOrders);
        if (data.workOrders.length === 1) {
          setSelectedWO(data.workOrders[0].id);
        }
      }
    } catch {
    } finally {
      setLoadingWOs(false);
    }
  }

  async function handleSubmitConcern() {
    if (!concern.trim()) return;
    setLoading(true);
    setError("");
    try {
      const res = await fetch("/api/dashboard/concern-assistant", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "followup", concern: concern.trim() }),
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || "Failed to generate questions");
      setQuestions(data.questions);
      setConversationId(data.conversationId);
      setStage("questions");
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  async function handleReview() {
    const answered = gatherAnswered();
    if (answered.length === 0) {
      setError("Please answer at least one question before requesting more.");
      return;
    }
    setLoading(true);
    setError("");
    const allExchanges = [...exchanges, ...answered.filter(a => !exchanges.some(e => e.question === a.question))];
    setExchanges(allExchanges);
    try {
      const res = await fetch("/api/dashboard/concern-assistant", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "review",
          concern,
          answeredQuestions: allExchanges,
          conversationId,
        }),
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || "Failed to get more questions");
      setQuestions(data.questions);
      setAnswers({});
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  async function handleFinish() {
    const answered = gatherAnswered();
    const allExchanges = [...exchanges, ...answered.filter(a => !exchanges.some(e => e.question === a.question))];
    if (allExchanges.length === 0) {
      setError("Please answer at least one question before finishing.");
      return;
    }
    setExchanges(allExchanges);
    setLoading(true);
    setError("");

    const conversationLines = [`Customer Concern: ${concern}`];
    allExchanges.forEach(e => {
      conversationLines.push(`Service Advisor asks: ${e.question}`);
      conversationLines.push(`Customer responds: ${e.response}`);
    });

    try {
      const res = await fetch("/api/dashboard/concern-assistant", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "cleanup",
          conversationText: conversationLines.join("\n"),
          conversationId,
          concern,
          exchanges: allExchanges,
        }),
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || "Failed to clean up conversation");
      setCleanedText(data.cleanedText);
      setStage("result");
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  async function handleInject() {
    if (!selectedWO || !cleanedText) return;
    const wo = workOrders.find(w => w.id === selectedWO);
    if (!wo) return;

    setInjecting(true);
    setError("");
    try {
      const res = await fetch("/api/dashboard/concern-assistant", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "inject",
          workOrderId: wo.id,
          contactId: wo.contactId,
          serviceItemId: wo.serviceItemId,
          concernText: cleanedText,
        }),
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || "Failed to send to work order");
      setInjected(true);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setInjecting(false);
    }
  }

  function handleCopy() {
    navigator.clipboard.writeText(cleanedText).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  function handleNew() {
    setConcern("");
    setQuestions([]);
    setExchanges([]);
    setAnswers({});
    setCleanedText("");
    setConversationId(null);
    setError("");
    setCopied(false);
    setInjected(false);
    setStage("start");
  }

  function gatherAnswered(): Exchange[] {
    return questions
      .map((q, i) => ({
        question: q,
        response: (answers[i] || "").trim(),
      }))
      .filter(e => e.response.length > 0);
  }

  const selectedWOData = workOrders.find(w => w.id === selectedWO);

  return (
    <div className="p-4 sm:p-6 max-w-3xl mx-auto">
      <div className="flex items-center gap-3 mb-6">
        <div className="p-2 bg-blue-100 rounded-lg">
          <MessageSquareText className="w-6 h-6 text-blue-600" />
        </div>
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Customer Concern Assistant</h1>
          <p className="text-sm text-gray-500">
            AI-powered tool to help gather and document customer concerns
          </p>
        </div>
      </div>

      {error && (
        <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">
          {error}
        </div>
      )}

      {stage === "start" && (
        <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-6">
          <div className="flex items-center gap-2 mb-4">
            <HelpCircle className="w-5 h-5 text-gray-400" />
            <h2 className="text-lg font-semibold text-gray-900">
              What is the customer&apos;s concern?
            </h2>
          </div>
          <textarea
            value={concern}
            onChange={(e) => setConcern(e.target.value)}
            placeholder="e.g., My car makes a squealing noise when I brake, especially in the morning..."
            className="w-full h-32 px-4 py-3 border border-gray-300 rounded-lg resize-none focus:ring-2 focus:ring-blue-500 focus:border-transparent text-gray-900 placeholder-gray-400"
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                handleSubmitConcern();
              }
            }}
          />
          <div className="flex justify-end mt-4">
            <button
              onClick={handleSubmitConcern}
              disabled={!concern.trim() || loading}
              className="flex items-center gap-2 px-5 py-2.5 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors font-medium"
            >
              {loading ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <Send className="w-4 h-4" />
              )}
              Generate Follow-Up Questions
            </button>
          </div>
        </div>
      )}

      {stage === "questions" && (
        <div className="space-y-4">
          <div className="bg-blue-50 border border-blue-200 rounded-xl p-4">
            <p className="text-sm font-medium text-blue-800">Customer&apos;s Concern:</p>
            <p className="text-blue-900 mt-1">{concern}</p>
          </div>

          <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-6">
            <h2 className="text-lg font-semibold text-gray-900 mb-4">
              Follow-Up Questions
            </h2>
            <p className="text-sm text-gray-500 mb-4">
              Ask the customer these questions and type their responses below.
            </p>

            <div className="space-y-4">
              {questions.map((q, i) => (
                <div key={i} className="border border-gray-100 rounded-lg p-4 bg-gray-50">
                  <p className="text-sm font-medium text-gray-700 mb-2">
                    {i + 1}. {q}
                  </p>
                  <textarea
                    value={answers[i] || ""}
                    onChange={(e) => setAnswers({ ...answers, [i]: e.target.value })}
                    placeholder="Customer's response..."
                    className="w-full h-20 px-3 py-2 border border-gray-300 rounded-lg resize-none focus:ring-2 focus:ring-blue-500 focus:border-transparent text-sm text-gray-900 placeholder-gray-400"
                  />
                </div>
              ))}
            </div>

            {exchanges.length > 0 && (
              <div className="mt-4 pt-4 border-t border-gray-200">
                <p className="text-xs text-gray-500 mb-2">Previous answers recorded: {exchanges.length}</p>
              </div>
            )}

            <div className="flex items-center justify-between mt-6 gap-3">
              <button
                onClick={handleReview}
                disabled={loading}
                className="flex items-center gap-2 px-4 py-2 border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50 disabled:opacity-50 transition-colors text-sm font-medium"
              >
                {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <RotateCcw className="w-4 h-4" />}
                More Questions
              </button>
              <button
                onClick={handleFinish}
                disabled={loading}
                className="flex items-center gap-2 px-5 py-2.5 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 transition-colors font-medium"
              >
                {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle className="w-4 h-4" />}
                Finish &amp; Generate Write-Up
              </button>
            </div>
          </div>
        </div>
      )}

      {stage === "result" && (
        <div className="space-y-4">
          <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-6">
            <h2 className="text-lg font-semibold text-gray-900 mb-4">
              Cleaned Concern Write-Up
            </h2>
            <div className="bg-gray-50 border border-gray-200 rounded-lg p-4 text-gray-800 leading-relaxed whitespace-pre-wrap">
              {cleanedText}
            </div>

            <div className="flex flex-wrap items-center gap-3 mt-5">
              <button
                onClick={handleCopy}
                className="flex items-center gap-2 px-4 py-2 border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50 transition-colors text-sm font-medium"
              >
                {copied ? <CheckCircle className="w-4 h-4 text-green-600" /> : <Copy className="w-4 h-4" />}
                {copied ? "Copied!" : "Copy"}
              </button>
              <button
                onClick={handleNew}
                className="flex items-center gap-2 px-4 py-2 border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50 transition-colors text-sm font-medium"
              >
                <Plus className="w-4 h-4" />
                New Concern
              </button>
            </div>
          </div>

          <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-6">
            <h3 className="text-base font-semibold text-gray-900 mb-3">
              Send to Work Order
            </h3>

            {loadingWOs ? (
              <div className="flex items-center gap-2 text-gray-500 text-sm">
                <Loader2 className="w-4 h-4 animate-spin" />
                Loading work orders...
              </div>
            ) : workOrders.length === 0 ? (
              <p className="text-sm text-gray-500">
                No open work orders found. The write-up has been saved and can be copied above.
              </p>
            ) : (
              <>
                <div className="relative mb-4">
                  <button
                    onClick={() => setWoDropdownOpen(!woDropdownOpen)}
                    className="w-full flex items-center justify-between px-4 py-3 border border-gray-300 rounded-lg bg-white hover:bg-gray-50 text-left transition-colors"
                  >
                    {selectedWOData ? (
                      <div>
                        <span className="font-medium text-gray-900">
                          WO #{selectedWOData.number}
                        </span>
                        {selectedWOData.contactName && (
                          <span className="text-gray-500 ml-2">
                            {selectedWOData.contactName}
                          </span>
                        )}
                        {selectedWOData.vehicle && (
                          <span className="text-gray-400 ml-2 text-sm">
                            ({selectedWOData.vehicle})
                          </span>
                        )}
                      </div>
                    ) : (
                      <span className="text-gray-400">Select a work order...</span>
                    )}
                    <ChevronDown className="w-4 h-4 text-gray-400" />
                  </button>

                  {woDropdownOpen && (
                    <div className="absolute z-10 mt-1 w-full bg-white border border-gray-200 rounded-lg shadow-lg max-h-60 overflow-y-auto">
                      {workOrders.map((wo) => (
                        <button
                          key={wo.id}
                          onClick={() => {
                            setSelectedWO(wo.id);
                            setWoDropdownOpen(false);
                          }}
                          className={`w-full text-left px-4 py-3 hover:bg-blue-50 border-b border-gray-100 last:border-0 transition-colors ${
                            selectedWO === wo.id ? "bg-blue-50" : ""
                          }`}
                        >
                          <div className="font-medium text-gray-900">
                            WO #{wo.number}
                            <span className="ml-2 text-xs px-2 py-0.5 rounded-full bg-gray-100 text-gray-600">
                              {wo.status}
                            </span>
                          </div>
                          <div className="text-sm text-gray-500 mt-0.5">
                            {wo.contactName || "No contact"} 
                            {wo.vehicle ? ` — ${wo.vehicle}` : ""}
                          </div>
                        </button>
                      ))}
                    </div>
                  )}
                </div>

                {injected ? (
                  <div className="flex items-center gap-2 p-3 bg-green-50 border border-green-200 rounded-lg text-green-700 text-sm">
                    <CheckCircle className="w-4 h-4" />
                    Concern successfully sent to WO #{selectedWOData?.number}
                  </div>
                ) : (
                  <button
                    onClick={handleInject}
                    disabled={!selectedWO || injecting}
                    className="flex items-center gap-2 px-5 py-2.5 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors font-medium"
                  >
                    {injecting ? (
                      <Loader2 className="w-4 h-4 animate-spin" />
                    ) : (
                      <Upload className="w-4 h-4" />
                    )}
                    Send to Work Order
                  </button>
                )}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
