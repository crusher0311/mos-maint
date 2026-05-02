"use client";

import { useState } from "react";
import {
  MessageSquareText,
  Send,
  RotateCcw,
  Copy,
  Upload,
  Loader2,
  CheckCircle,
  Plus,
  HelpCircle,
  X
} from "lucide-react";

interface Exchange {
  question: string;
  response: string;
}

interface ConcernAssistantModalProps {
  isOpen: boolean;
  onClose: () => void;
  vehicleDisplay?: string;
  vin?: string;
  workOrderId?: string;
  workOrderNumber?: string;
  contactId?: string;
  serviceItemId?: string;
  customerName?: string;
  smsType?: string;
}

type Stage = "start" | "questions" | "result";

export default function ConcernAssistantModal({
  isOpen,
  onClose,
  vehicleDisplay,
  vin,
  workOrderId,
  workOrderNumber,
  contactId,
  serviceItemId,
  customerName,
  smsType,
}: ConcernAssistantModalProps) {
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

  if (!isOpen) return null;

  const woLabel = smsType === "protractor" ? "WO" : "RO";
  const canInject = smsType === "protractor" && workOrderId;

  function reset() {
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

  function handleClose() {
    reset();
    onClose();
  }

  function gatherAnswered(): Exchange[] {
    return questions
      .map((q, i) => ({
        question: q,
        response: (answers[i] || "").trim(),
      }))
      .filter(e => e.response.length > 0);
  }

  function gatherRoundResults(): { question: string; answered: boolean }[] {
    return questions.map((q, i) => ({
      question: q,
      answered: (answers[i] || "").trim().length > 0,
    }));
  }

  async function handleSubmitConcern() {
    if (!concern.trim()) return;
    setLoading(true);
    setError("");
    try {
      const res = await fetch("/api/dashboard/concern-assistant", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "followup",
          concern: concern.trim(),
          vin,
          vehicleDisplay,
        }),
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
    const roundResults = gatherRoundResults();
    try {
      const res = await fetch("/api/dashboard/concern-assistant", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "review",
          concern,
          answeredQuestions: allExchanges,
          conversationId,
          roundResults,
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
    const roundResults = gatherRoundResults();

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
          roundResults,
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
    if (!workOrderId || !cleanedText) return;
    setInjecting(true);
    setError("");
    try {
      const res = await fetch("/api/dashboard/concern-assistant", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "inject",
          workOrderId,
          contactId,
          serviceItemId,
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

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={handleClose}>
      <div
        className="bg-white rounded-xl shadow-2xl w-full max-w-2xl max-h-[85vh] overflow-hidden flex flex-col mx-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200 bg-gray-50">
          <div className="flex items-center gap-3">
            <div className="p-1.5 bg-blue-100 rounded-lg">
              <MessageSquareText className="w-5 h-5 text-blue-600" />
            </div>
            <div>
              <h2 className="text-lg font-semibold text-gray-900">Concern Assistant</h2>
              <p className="text-xs text-gray-500">
                {vehicleDisplay && <span>{vehicleDisplay}</span>}
                {workOrderNumber && <span> &middot; {woLabel} #{workOrderNumber}</span>}
                {customerName && <span> &middot; {customerName}</span>}
              </p>
            </div>
          </div>
          <button
            onClick={handleClose}
            className="p-1.5 text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded-lg transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-6">
          {error && (
            <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">
              {error}
            </div>
          )}

          {stage === "start" && (
            <div>
              <div className="flex items-center gap-2 mb-3">
                <HelpCircle className="w-4 h-4 text-gray-400" />
                <h3 className="text-sm font-medium text-gray-700">
                  What is the customer&apos;s concern?
                </h3>
              </div>
              <textarea
                value={concern}
                onChange={(e) => setConcern(e.target.value)}
                placeholder="e.g., My car makes a squealing noise when I brake, especially in the morning..."
                className="w-full h-28 px-4 py-3 border border-gray-300 rounded-lg resize-none focus:ring-2 focus:ring-blue-500 focus:border-transparent text-gray-900 placeholder-gray-400 text-sm"
                autoFocus
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    handleSubmitConcern();
                  }
                }}
              />
              <div className="flex justify-end mt-3">
                <button
                  onClick={handleSubmitConcern}
                  disabled={!concern.trim() || loading}
                  className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors text-sm font-medium"
                >
                  {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
                  Generate Follow-Up Questions
                </button>
              </div>
            </div>
          )}

          {stage === "questions" && (
            <div className="space-y-4">
              <div className="bg-blue-50 border border-blue-200 rounded-lg p-3">
                <p className="text-xs font-medium text-blue-800">Customer&apos;s Concern:</p>
                <p className="text-sm text-blue-900 mt-1">{concern}</p>
              </div>

              <div>
                <h3 className="text-sm font-medium text-gray-700 mb-3">
                  Follow-Up Questions
                </h3>
                <p className="text-xs text-gray-500 mb-3">
                  Ask the customer these questions and type their responses below.
                </p>

                <div className="space-y-3">
                  {questions.map((q, i) => (
                    <div key={i} className="border border-gray-100 rounded-lg p-3 bg-gray-50">
                      <p className="text-xs font-medium text-gray-700 mb-1.5">
                        {i + 1}. {q}
                      </p>
                      <textarea
                        value={answers[i] || ""}
                        onChange={(e) => setAnswers({ ...answers, [i]: e.target.value })}
                        placeholder="Customer's response..."
                        className="w-full h-16 px-3 py-2 border border-gray-300 rounded-lg resize-none focus:ring-2 focus:ring-blue-500 focus:border-transparent text-sm text-gray-900 placeholder-gray-400"
                      />
                    </div>
                  ))}
                </div>

                {exchanges.length > 0 && (
                  <p className="text-xs text-gray-400 mt-2">Previous answers recorded: {exchanges.length}</p>
                )}
              </div>
            </div>
          )}

          {stage === "result" && (
            <div className="space-y-4">
              <div>
                <h3 className="text-sm font-medium text-gray-700 mb-2">Cleaned Concern Write-Up</h3>
                <div className="bg-gray-50 border border-gray-200 rounded-lg p-4 text-sm text-gray-800 leading-relaxed whitespace-pre-wrap">
                  {cleanedText}
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <button
                  onClick={handleCopy}
                  className="flex items-center gap-1.5 px-3 py-1.5 border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50 transition-colors text-sm"
                >
                  {copied ? <CheckCircle className="w-3.5 h-3.5 text-green-600" /> : <Copy className="w-3.5 h-3.5" />}
                  {copied ? "Copied!" : "Copy"}
                </button>
                <button
                  onClick={reset}
                  className="flex items-center gap-1.5 px-3 py-1.5 border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50 transition-colors text-sm"
                >
                  <Plus className="w-3.5 h-3.5" />
                  New Concern
                </button>
              </div>

              {canInject && (
                <div className="pt-3 border-t border-gray-200">
                  <h4 className="text-sm font-medium text-gray-700 mb-2">
                    Send to {woLabel} #{workOrderNumber}
                  </h4>
                  {injected ? (
                    <div className="flex items-center gap-2 p-3 bg-green-50 border border-green-200 rounded-lg text-green-700 text-sm">
                      <CheckCircle className="w-4 h-4" />
                      Concern sent to {woLabel} #{workOrderNumber}
                    </div>
                  ) : (
                    <button
                      onClick={handleInject}
                      disabled={injecting}
                      className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 transition-colors text-sm font-medium"
                    >
                      {injecting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Upload className="w-4 h-4" />}
                      Send to Work Order
                    </button>
                  )}
                </div>
              )}
            </div>
          )}
        </div>

        {stage === "questions" && (
          <div className="flex items-center justify-between px-6 py-3 border-t border-gray-200 bg-gray-50">
            <button
              onClick={handleReview}
              disabled={loading}
              className="flex items-center gap-1.5 px-3 py-2 border border-gray-300 text-gray-700 rounded-lg hover:bg-white disabled:opacity-50 transition-colors text-sm font-medium"
            >
              {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <RotateCcw className="w-4 h-4" />}
              More Questions
            </button>
            <button
              onClick={handleFinish}
              disabled={loading}
              className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 transition-colors text-sm font-medium"
            >
              {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle className="w-4 h-4" />}
              Finish &amp; Generate Write-Up
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
