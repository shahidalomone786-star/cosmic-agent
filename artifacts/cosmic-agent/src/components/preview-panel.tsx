import { useEffect, useState } from "react";
import { ExternalLink, Eye, LoaderCircle, Pause, Play, RefreshCw, RotateCw, Square } from "lucide-react";

type PreviewState = "starting" | "running" | "reloading" | "stopped" | "build_error" | "runtime_error";
type PreviewStatus = { proposalId: string; state: PreviewState; url: string; command: string; output: string; updatedAt: string };

const labels: Record<PreviewState, string> = {
  starting: "Starting", running: "Running", reloading: "Reloading", stopped: "Stopped", build_error: "Build Error", runtime_error: "Runtime Error",
};

async function request<T>(url: string, method = "GET"): Promise<T> {
  const response = await fetch(url, { method, credentials: "include" });
  const body = await response.json().catch(() => ({})) as T & { error?: string };
  if (!response.ok) throw new Error(body.error ?? "Preview request failed.");
  return body;
}

export function PreviewPanel({ proposalId, onClose }: { proposalId: string; onClose: () => void }) {
  const [status, setStatus] = useState<PreviewStatus | null>(null);
  const [error, setError] = useState("");
  const [frameKey, setFrameKey] = useState(0);
  const [busy, setBusy] = useState(false);
  const refreshStatus = async () => {
    try { setStatus(await request<PreviewStatus>(`/api/preview/${encodeURIComponent(proposalId)}/status`)); setError(""); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Could not read preview status."); }
  };
  const run = async (action: "start" | "restart" | "stop") => {
    setBusy(true); setError("");
    if (action !== "stop") setStatus((current) => current ? { ...current, state: "reloading" } : current);
    try { setStatus(await request<PreviewStatus>(`/api/preview/${encodeURIComponent(proposalId)}/${action}`, "POST")); if (action !== "stop") setFrameKey((key) => key + 1); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Preview action failed."); await refreshStatus(); }
    finally { setBusy(false); }
  };
  useEffect(() => {
    void refreshStatus().then(() => void run("start"));
    return () => { /* Preview persists until the user stops it, so a closed panel can be reopened safely. */ };
  }, [proposalId]);
  useEffect(() => {
    if (!status || status.state === "running" || status.state === "stopped" || status.state === "build_error" || status.state === "runtime_error") return;
    const timer = window.setInterval(() => void refreshStatus(), 900);
    return () => window.clearInterval(timer);
  }, [status?.state]);
  const running = status?.state === "running";
  const canOpen = running && status?.url;
  return <section className="preview-panel" aria-label="Live application preview">
    <div className="preview-header">
      <div className="preview-title"><div className="preview-icon"><Eye size={15} /></div><div><strong>Preview</strong><span>Approved application runtime</span></div></div>
      <div className="preview-header-actions"><span className={`preview-state ${status?.state ?? "starting"}`}><span className="preview-state-dot" /> {labels[status?.state ?? "starting"]}</span><button className="icon-button" onClick={onClose} aria-label="Close preview"><Square size={14} /></button></div>
    </div>
    <div className="preview-toolbar">
      <button onClick={() => setFrameKey((key) => key + 1)} disabled={!running || busy}><RefreshCw size={13} /> Refresh</button>
      <button onClick={() => canOpen && window.open(status.url, "_blank", "noopener,noreferrer")} disabled={!canOpen}><ExternalLink size={13} /> Open in new tab</button>
      <button onClick={() => setFrameKey((key) => key + 1)} disabled={!running || busy}><RotateCw size={13} /> Reload</button>
      {running ? <button onClick={() => void run("stop")} disabled={busy}><Pause size={13} /> Stop</button> : <button onClick={() => void run("start")} disabled={busy}><Play size={13} /> Start</button>}
      <button onClick={() => void run("restart")} disabled={busy}><LoaderCircle size={13} className={busy ? "spin" : ""} /> Restart</button>
    </div>
    {(status?.state === "build_error" || status?.state === "runtime_error" || error) && <div className="preview-error" role="alert"><strong>{error || labels[status?.state ?? "runtime_error"]}</strong><pre>{status?.output || "No runtime output was returned."}</pre></div>}
    {running && status && <iframe key={frameKey} className="preview-frame" title="Live application preview" src={status.url} />}
    {!running && !error && status?.state === "stopped" && <div className="preview-empty"><Eye size={22} /><strong>Preview stopped</strong><span>Start the approved runtime to view the application.</span></div>}
    {!status && <div className="preview-empty"><LoaderCircle size={20} className="spin" /><span>Connecting to the approved runtime…</span></div>}
  </section>;
}