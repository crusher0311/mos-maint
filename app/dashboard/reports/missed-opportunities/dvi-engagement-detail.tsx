import { useId } from "react";
import { normalizeDviEngagement, type DviEvidence } from "@/lib/dvi-engagement";

/** Customer engagement is independent of recommendation provenance and evaluation. */
export function DviEngagementDetail({ engagement }: { engagement?: unknown }) {
  const descriptionId = useId();
  const evidence = normalizeDviEngagement(engagement);
  return (
    <section aria-label="DVI customer engagement" aria-describedby={descriptionId} className="mb-4 rounded-lg border border-slate-200 bg-white px-4 py-3">
      <h3 className="text-xs font-semibold uppercase tracking-[0.12em] text-slate-600">DVI customer engagement</h3>
      <div className="mt-2 grid gap-3 sm:grid-cols-2">
        <EvidenceIndicator label="DVI sent" positive="Sent" negative="Not sent" evidence={evidence.sent} />
        <EvidenceIndicator label="Customer viewed" positive="Viewed" negative="Not viewed" evidence={evidence.viewed} />
      </div>
      <p id={descriptionId} className="mt-3 text-xs leading-relaxed text-slate-500">
        Recommendation source does not confirm customer engagement. A view does not establish that the DVI was sent, and a recorded send does not confirm delivery. Missing tracking is not evidence of a missed advisor action.
      </p>
    </section>
  );
}

function EvidenceIndicator({ label, positive, negative, evidence }: {
  label: string; positive: string; negative: string; evidence: DviEvidence;
}) {
  const statusLabel = evidence.status === "positive" ? positive
    : evidence.status === "negative" ? negative
    : evidence.status === "unsupported" ? "Not tracked" : "Unknown";
  const tone = evidence.status === "positive"
    ? "border-emerald-200 bg-emerald-50 text-emerald-800"
    : evidence.status === "negative"
      ? "border-amber-200 bg-amber-50 text-amber-900"
      : "border-slate-200 bg-slate-50 text-slate-600";
  const explanation = evidence.status === "unknown"
    ? "No conclusive evidence is available in this report."
    : evidence.status === "unsupported"
      ? "This source does not track this activity."
      : evidence.status === "negative"
        ? "The source explicitly recorded that this activity did not occur."
        : "The source recorded evidence of this activity.";
  return (
    <div className="min-w-0">
      <div className="flex flex-wrap items-center gap-2">
        <h4 className="text-sm font-medium text-slate-800">{label}</h4>
        <span className={`inline-flex rounded border px-1.5 py-0.5 text-xs font-semibold ${tone}`}>{statusLabel}</span>
      </div>
      <p className="mt-1 text-xs leading-relaxed text-slate-500">{explanation}</p>
      <dl className="mt-1 space-y-1 text-xs leading-relaxed text-slate-500">
        <div><dt className="inline font-medium">Source: </dt><dd className="inline break-words">{evidence.source || "Not recorded"}</dd></div>
        <div>
          <dt className="inline font-medium">{evidence.timestampKind === "received" ? "Event received: " : evidence.timestampKind === "event" ? "Recorded event time: " : "Recorded time: "}</dt>
          <dd className="inline">
            {evidence.timestamp ? <time dateTime={evidence.timestamp}>{new Date(evidence.timestamp).toLocaleString("en-US", { year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", second: "2-digit", timeZone: "UTC", timeZoneName: "short" })}</time> : "Not available"}
            {evidence.timestampKind === "received" && " (when MOS received the event, not the exact customer activity time)"}
          </dd>
        </div>
      </dl>
      {evidence.context && <p className="mt-1 break-words text-xs leading-relaxed text-slate-500">{evidence.context}</p>}
    </div>
  );
}
