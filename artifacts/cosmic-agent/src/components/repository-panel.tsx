import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { ChevronDown, ChevronRight, Clipboard, Code2, ExternalLink, File, Folder, GitBranch, Link2, LoaderCircle, Search, ShieldCheck, X } from "lucide-react";

export type RepositoryRef = { id: string; owner: string; name: string; branch: string; defaultBranch: string; webUrl: string };
type Entry = { path: string; name: string; type: "file" | "directory"; size?: number; language?: string };
type FileResult = { path: string; language: string; size: number; content: string; truncated: boolean };
type SearchResult = { path: string; line: number; context: string };

export function RepositoryPanel({ open, repository, onRepositoryChange, contextPaths, onAddContext, onRemoveContext, onClose }: { open?: boolean; repository: RepositoryRef | null; onRepositoryChange: (repository: RepositoryRef | null) => void; contextPaths: string[]; onAddContext: (path: string) => void; onRemoveContext: (path: string) => void; onClose?: () => void }) {
  const [url, setUrl] = useState("");
  const [branch, setBranch] = useState("");
  const [entries, setEntries] = useState<Record<string, Entry[]>>({});
  const [expanded, setExpanded] = useState<string[]>([]);
  const [file, setFile] = useState<FileResult | null>(null);
  const [search, setSearch] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => { if (repository && !entries[""]) void loadDirectory(""); }, [repository]);
  const loadDirectory = async (path: string) => {
    if (!repository || entries[path]) return;
    setBusy(true); setError("");
    try { const response = await fetch("/api/repository/tree", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ repository, path }) }); const data = await response.json() as Entry[] & { error?: string }; if (!response.ok) throw new Error(data.error ?? "Could not load repository tree."); setEntries((current) => ({ ...current, [path]: data })); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Could not load repository tree."); } finally { setBusy(false); }
  };
  const connect = async (event: FormEvent) => {
    event.preventDefault(); setBusy(true); setError("");
    try { const response = await fetch("/api/repository/connect", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ repositoryUrl: url, branch: branch || undefined }) }); const data = await response.json() as RepositoryRef & { error?: string }; if (!response.ok) throw new Error(data.error ?? "Could not connect repository."); onRepositoryChange(data); setEntries({}); setExpanded([]); setFile(null); setUrl(""); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Could not connect repository."); } finally { setBusy(false); }
  };
  const openEntry = async (entry: Entry) => {
    if (entry.type === "directory") { setExpanded((current) => current.includes(entry.path) ? current.filter((path) => path !== entry.path) : [...current, entry.path]); await loadDirectory(entry.path); return; }
    setBusy(true); setError("");
    try { const response = await fetch("/api/repository/file", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ repository, path: entry.path }) }); const data = await response.json() as FileResult & { error?: string }; if (!response.ok) throw new Error(data.error ?? "Could not open file."); setFile(data); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Could not open file."); } finally { setBusy(false); }
  };
  const runSearch = async (event: FormEvent) => {
    event.preventDefault(); if (!repository || !search.trim()) return; setBusy(true); setError("");
    try { const response = await fetch("/api/repository/search", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ repository, query: search }) }); const data = await response.json() as SearchResult[] & { error?: string }; if (!response.ok) throw new Error(data.error ?? "Search failed."); setResults(data); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Search failed."); } finally { setBusy(false); }
  };
  const tree = (path: string, depth = 0): ReactNode[] => (entries[path] ?? []).flatMap((entry) => [<div className="repo-entry" style={{ paddingLeft: `${12 + depth * 14}px` }} key={entry.path}><button onClick={() => void openEntry(entry)} aria-label={entry.type === "directory" ? `Open folder ${entry.name}` : `Open file ${entry.name}`}><span className="repo-icon">{entry.type === "directory" ? (expanded.includes(entry.path) ? <ChevronDown size={14} /> : <ChevronRight size={14} />) : <File size={14} />}</span><span>{entry.name}</span>{entry.type === "file" && entry.language && <small>{entry.language}</small>}</button>{entry.type === "directory" && expanded.includes(entry.path) ? tree(entry.path, depth + 1) : null}</div>]);
  return <aside className={`repository-panel ${open ? "is-open" : ""}`}>
    <div className="repo-panel-head"><div><span className="repo-kicker"><GitBranch size={12} /> Repository intelligence</span><strong>{repository ? `${repository.owner}/${repository.name}` : "Connect a repository"}</strong></div>{onClose && <button className="icon-button repo-close" onClick={onClose} aria-label="Close repository panel"><X size={17} /></button>}</div>
    {!repository ? <div className="repo-connect"><div className="read-only-badge"><ShieldCheck size={14} /> READ-ONLY MODE</div><p>Connect a public GitHub repository to browse structure, inspect files, search source, and ask architecture questions.</p><form onSubmit={connect}><label>Repository URL<input value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://github.com/owner/repository" required /></label><label>Branch <span>optional</span><input value={branch} onChange={(event) => setBranch(event.target.value)} placeholder="main" /></label><button className="repo-connect-button" disabled={busy}>{busy ? <LoaderCircle className="spin" size={15} /> : <Link2 size={15} />} Connect repository</button></form><small className="repo-security"><ShieldCheck size={13} /> Credentials never enter the browser. Private repositories require the managed GitHub connection.</small></div> : <><div className="repo-meta"><span><span className="status-dot" /> Connected</span><span>{repository.branch} branch</span><button onClick={() => onRepositoryChange(null)}>Disconnect</button></div><form className="repo-search" onSubmit={runSearch}><Search size={14} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search repository" aria-label="Search repository" /><button type="submit" aria-label="Run repository search"><Search size={13} /></button></form>{results.length > 0 && <div className="repo-results"><div className="repo-section-title">Search results <button onClick={() => setResults([])}><X size={12} /></button></div>{results.map((result) => <button className="repo-result" key={`${result.path}:${result.line}`} onClick={() => { const entry = { path: result.path, name: result.path.split("/").pop() ?? result.path, type: "file" as const }; void openEntry(entry); }}><strong>{result.path}<small>:{result.line}</small></strong><span>{result.context}</span></button>)}</div>}{file ? <div className="file-viewer"><div className="file-viewer-head"><div><strong><Code2 size={14} /> {file.path}</strong><small>{file.language} · {Math.round(file.size / 1024)} KB{file.truncated ? " · truncated safely" : ""}</small></div><button onClick={() => { navigator.clipboard?.writeText(file.content); }} aria-label="Copy file"><Clipboard size={14} /></button><button onClick={() => setFile(null)} aria-label="Close file viewer"><X size={15} /></button></div><pre>{file.content.split("\n").map((line, index) => <span key={index}><i>{index + 1}</i><code>{line || " "}</code></span>)}</pre><button className={contextPaths.includes(file.path) ? "context-button selected" : "context-button"} onClick={() => contextPaths.includes(file.path) ? onRemoveContext(file.path) : onAddContext(file.path)}>{contextPaths.includes(file.path) ? "Remove from AI context" : "Add file to AI context"}</button></div> : <div className="repo-tree"><div className="repo-section-title">Files <a href={repository.webUrl} target="_blank" rel="noreferrer" aria-label="Open repository on GitHub"><ExternalLink size={12} /></a></div>{busy && !Object.keys(entries).length ? <div className="repo-loading"><LoaderCircle className="spin" size={15} /> Loading tree…</div> : tree("")}</div>}</>}{error && <div className="repo-error" role="alert">{error}</div>}</aside>;
}