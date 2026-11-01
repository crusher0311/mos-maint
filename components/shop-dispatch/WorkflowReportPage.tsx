"use client";
import { useEffect, useState } from "react";
import type { CustomerReport } from "@/lib/auto-dvi/release/model";
import { CustomerInspectionReport } from "./CustomerInspectionReport";
import { customerReport } from "./release-contract";
import ui from "./ReleasePanel.module.css";

type Loaded = { version: number; report: CustomerReport; mediaUrls: Record<string, string> };
/** Route adapter: app/workflow-report/page.tsx should re-export this default. */
export default function WorkflowReportPage() {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [loading, setLoading] = useState(true);
  const [unavailable, setUnavailable] = useState(false);
  const [newVersion, setNewVersion] = useState<number | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    let generation = 0;
    let polling = false;
    let interval: ReturnType<typeof setInterval> | undefined;
    let controller = new AbortController();
    let urls: string[] = [];
    let currentVersion: number | null = null;
    let token = "";
    function clearMedia() { urls.forEach(url => URL.revokeObjectURL(url)); urls = []; }
    function fail() {
      if (!active) return;
      generation++; controller.abort();
      if (interval) clearInterval(interval);
      clearMedia(); currentVersion = null;
      setLoaded(null); setNewVersion(null); setLoading(false); setUnavailable(true);
    }
    async function post(body: { token: string; version?: number; mediaId?: string; check?: boolean }, signal: AbortSignal) {
      const response = await fetch("/api/workflow-report", { method: "POST", credentials: "omit", cache: "no-store", referrerPolicy: "no-referrer", signal, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      if (!response.ok || response.status === 202) throw new Error("Unavailable");
      return response;
    }
    async function load() {
      const run = ++generation;
      controller.abort(); controller = new AbortController();
      const signal = controller.signal;
      if (interval) clearInterval(interval);
      clearMedia(); currentVersion = null;
      setLoaded(null); setNewVersion(null); setLoading(true); setUnavailable(false);
      // Native delivery may pin a version in the URL. Never turn an invalid pin
      // into an implicit request for the latest report.
      let pinnedVersion: number | undefined;
      try {
        const query = new URLSearchParams(window.location.search);
        if (query.getAll("version").length > 1 || query.getAll("token").length > 1) throw Error("Ambiguous link");
        if (query.has("version")) {
          const raw = query.get("version")!;
          if (!/^[1-9][0-9]*$/.test(raw) || !Number.isSafeInteger(Number(raw))) throw Error("Invalid version");
          pinnedVersion = Number(raw);
        }
        // Tokens are passed only in POST bodies, never media request URLs or storage.
        token = query.has("token") ? query.get("token")! : decodeURIComponent(window.location.hash.slice(1));
      } catch { fail(); return; }
      if (!token || token.length > 4096) { fail(); return; }
      try {
        const value = await (await post({ token, ...(pinnedVersion !== undefined ? {version: pinnedVersion} : {}) }, signal)).json() as { version: number; report: CustomerReport };
        if (!Number.isSafeInteger(value.version) || value.version <= 0 || (pinnedVersion !== undefined && value.version !== pinnedVersion) ||
          !customerReport.safeParse(value.report).success) throw new Error("Unavailable");
        const mediaUrls: Record<string, string> = {};
        const photos = new Set(value.report.findings.flatMap(finding => finding.photoIds));
        const clips = new Set(value.report.findings.flatMap(finding => (finding.clips ?? []).map(clip => clip.id)));
        if ([...clips].some(id => photos.has(id))) throw new Error("Ambiguous media type");
        const ids = [...new Set([...photos, ...clips])];
        // Keep blob URLs owned by this effect and revoke on reload, failure or unmount.
        for (const mediaId of ids) {
          const response = await post({ token, version: value.version, mediaId }, signal);
          const blob = await response.blob();
          if (clips.has(mediaId) ? blob.type !== "video/mp4" : !["image/jpeg", "image/png", "image/webp"].includes(blob.type)) throw new Error("Unavailable");
          if (!active || run !== generation) return;
          const url = URL.createObjectURL(blob); urls.push(url); mediaUrls[mediaId] = url;
        }
        if (!active || run !== generation) return;
        currentVersion = value.version;
        setLoaded({ ...value, mediaUrls }); setLoading(false);
        interval = setInterval(() => {
          if (polling || currentVersion === null) return;
          polling = true;
          void post({ token, check: true }, signal).then(response => response.json()).then(value => {
            if (!Number.isSafeInteger(value.version) || value.version <= 0) throw new Error("Unavailable");
            if (active && run === generation && value.version > currentVersion!) setNewVersion(value.version);
          }).catch(() => { if (active && run === generation) fail(); }).finally(() => { polling = false; });
        }, 30_000);
      } catch { if (active && run === generation) fail(); }
    }
    void load();
    window.addEventListener("hashchange", load);
    return () => { active = false; generation++; controller.abort(); if (interval) clearInterval(interval); clearMedia(); token = ""; window.removeEventListener("hashchange", load); };
  }, [attempt]);
  return <main className={ui.customer}><div>
    {loading && <><p className={ui.eyebrow}>Private inspection report</p><div className={ui.skeleton} role="status" aria-label="Loading inspection report" /></>}
    {unavailable && <section className={ui.panel} role="alert"><div className={ui.eyebrow}>Inspection report</div><h1>This report is unavailable.</h1><p>The report could not be opened. Contact the shop for help or try again.</p><button onClick={() => setAttempt(value => value + 1)}>Try again</button></section>}
    {newVersion !== null && <aside className={ui.notice} role="status"><strong>A newer report is available.</strong><p>You are viewing version {loaded?.version}. Choose to load the latest published findings.</p><button onClick={() => {
      const url = new URL(window.location.href); url.searchParams.delete("version");
      window.history.replaceState(null, "", url);
      setAttempt(value => value + 1);
    }}>Load latest report</button></aside>}
    {loaded && !unavailable && <CustomerInspectionReport report={loaded.report} version={loaded.version} mediaUrls={loaded.mediaUrls} />}
  </div></main>;
}
