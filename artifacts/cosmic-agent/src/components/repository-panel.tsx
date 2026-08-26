import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { type RepositoryEntry, type RepositoryFile, type RepositoryRef, type RepositorySearchResult, useConnectRepository, useListRepositoryTree, useReadRepositoryFile, useSearchRepository } from "@workspace/api-client-react";
import { ChevronDown, ChevronRight, Clipboard, Code2, ExternalLink, File, GitBranch, LayoutDashboard, Link2, LoaderCircle, Search, ShieldCheck, X } from "lucide-react";
import { RepositoryOverview } from "@/components/repository-overview";

export type { RepositoryRef };

type Entry = RepositoryEntry;
type FileResult = RepositoryFile;
type SearchResult = RepositorySearchResult;
type ViewMode = "files" | "overview";

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error && error.message ? error.message : fallback;
}

export function RepositoryPanel({ open, repository, onRepositoryChange, contextPaths, onAddContext, onRemoveContext, onClose }: { open?: boolean; repository: RepositoryRef | null; onRepositoryChange: (repository: RepositoryRef | null) => void; contextPaths: string[]; onAddContext: (path: string) => void; onRemoveContext: (path: string) => void; onClose?: () => void }) {
  const [url, setUrl] = useState("");
  const [branch, setBranch] = useState("");
  const [entries, setEntries] = useState<Record<string, Entry[]>>({});
  const [expanded, setExpanded] = useState<string[]>([]);
  const [file, setFile] = useState<FileResult | null>(null);
  const [search, setSearch] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [error, setError] = useState("");
  const [view, setView] = useState<ViewMode>("files");
  const connectMutation = useConnectRepository();
  const treeMutation = useListRepositoryTree();
  const fileMutation = useReadRepositoryFile();
  const searchMutation = useSearchRepository();
  const busy = connectMutation.isPending || treeMutation.isPending || fileMutation.isPending || searchMutation.isPending;

  useEffect(() => {
    if (repository && !entries[""]) void loadDirectory("");
  }, [repository]);

  const loadDirectory = async (path: string) => {
    if (!repository || entries[path]) return;
    setError("");
    treeMutation.mutate({ data: { repository, path } }, {
      onSuccess: (data) => setEntries((current) => ({ ...current, [path]: data })),
      onError: (cause) => setError(errorMessage(cause, "Could not load repository tree.")),
    });
  };

  const connect = (event: FormEvent) => {
    event.preventDefault();
    setError("");
    connectMutation.mutate({ data: { repositoryUrl: url, branch: branch || undefined } }, {
      onSuccess: (data) => {
        onRepositoryChange(data);
        setEntries({});
        setExpanded([]);
        setFile(null);
        setResults([]);
        setUrl("");
        setBranch("");
        setView("files");
      },
      onError: (cause) => setError(errorMessage(cause, "Could not connect repository.")),
    });
  };

  const openEntry = (entry: Entry) => {
    if (!repository) return;
    if (entry.type === "directory") {
      setExpanded((current) => current.includes(entry.path) ? current.filter((path) => path !== entry.path) : [...current, entry.path]);
      void loadDirectory(entry.path);
      return;
    }
    setError("");
    fileMutation.mutate({ data: { repository, path: entry.path } }, {
      onSuccess: (data) => setFile(data),
      onError: (cause) => setError(errorMessage(cause, "Could not open file.")),
    });
  };

  const runSearch = (event: FormEvent) => {
    event.preventDefault();
    if (!repository || !search.trim()) return;
    setError("");
    searchMutation.mutate({ data: { repository, query: search.trim() } }, {
      onSuccess: (data) => setResults(data),
      onError: (cause) => setError(errorMessage(cause, "Search failed.")),
    });
  };

  const addContext = (path: string) => onAddContext(path);
  const tree = (path: string, depth = 0): ReactNode[] => (entries[path] ?? []).flatMap((entry) => [
    <div className="repo-entry" style={{ paddingLeft: `${depth * 14}px` }} key={entry.path}>
      <div className="repo-entry-row">
        <button className="repo-entry-open" onClick={() => openEntry(entry)} aria-label={entry.type === "directory" ? `Open folder ${entry.name}` : `Open file ${entry.name}`} data-testid={`button-open-entry-${entry.path}`}>
          <span className="repo-icon">{entry.type === "directory" ? (expanded.includes(entry.path) ? <ChevronDown size={14} /> : <ChevronRight size={14} />) : <File size={14} />}</span>
          <span>{entry.name}</span>{entry.type === "file" && entry.language && <small>{entry.language}</small>}
        </button>
        {entry.type === "file" && <button className={`repo-entry-context ${contextPaths.includes(entry.path) ? "selected" : ""}`} onClick={() => contextPaths.includes(entry.path) ? onRemoveContext(entry.path) : addContext(entry.path)} aria-label={`${contextPaths.includes(entry.path) ? "Remove" : "Add"} @file context for ${entry.name}`} data-testid={`button-context-entry-${entry.path}`}>@</button>}
      </div>
      {entry.type === "directory" && expanded.includes(entry.path) ? tree(entry.path, depth + 1) : null}
    </div>,
  ]);

  return <aside className={`repository-panel ${open ? "is-open" : ""}`} data-testid="repository-panel">
    <div className="repo-panel-head"><div><span className="repo-kicker"><GitBranch size={12} /> Repository intelligence</span><strong>{repository ? `${repository.owner}/${repository.name}` : "Connect a repository"}</strong></div>{onClose && <button className="icon-button repo-close" onClick={onClose} aria-label="Close repository panel" data-testid="button-close-repository-panel"><X size={17} /></button>}</div>
    {!repository ? <div className="repo-connect"><div className="read-only-badge"><ShieldCheck size={14} /> READ-ONLY MODE</div><p>Connect a public GitHub repository to browse structure, inspect files, search source, and ask architecture questions.</p><form onSubmit={connect}><label>Repository URL<input value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://github.com/owner/repository" required data-testid="input-repository-url" /></label><label>Branch <span>optional</span><input value={branch} onChange={(event) => setBranch(event.target.value)} placeholder="main" data-testid="input-repository-branch" /></label><button className="repo-connect-button" disabled={busy} data-testid="button-connect-repository">{connectMutation.isPending ? <LoaderCircle className="spin" size={15} /> : <Link2 size={15} />} Connect repository</button></form><small className="repo-security"><ShieldCheck size={13} /> Credentials never enter the browser. Private repository access is a future server-side provider capability.</small></div> : <>
      <div className="repo-meta"><span><span className="status-dot" /> Connected</span><span>{repository.branch} branch</span><button onClick={() => onRepositoryChange(null)} data-testid="button-disconnect-repository">Disconnect</button></div>
      <div className="repo-view-switcher" role="tablist" aria-label="Repository views"><button className={view === "files" ? "active" : ""} onClick={() => { setView("files"); setFile(null); }} role="tab" aria-selected={view === "files"} data-testid="tab-repository-files"><File size={13} /> Files</button><button className={view === "overview" ? "active" : ""} onClick={() => { setView("overview"); setFile(null); }} role="tab" aria-selected={view === "overview"} data-testid="tab-repository-overview"><LayoutDashboard size={13} /> Overview</button></div>
       {view === "overview" ? <RepositoryOverview repository={repository} contextPaths={contextPaths} onAddContext={onAddContext} onRemoveContext={onRemoveContext} /> : <><form className="repo-search" onSubmit={runSearch}><Search size={14} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search repository" aria-label="Search repository" data-testid="input-search-repository" /><button type="submit" aria-label="Run repository search" data-testid="button-search-repository"><Search size={13} /></button></form><div className="repo-search-hint">Search source, then use @ to keep a file in chat context.</div>{results.length > 0 && <div className="repo-results"><div className="repo-section-title">Search results <button onClick={() => setResults([])} aria-label="Clear search results" data-testid="button-clear-search-results"><X size={12} /></button></div>{results.map((result) => <div className="repo-result-row" key={`${result.path}:${result.line}`}><button className="repo-result" onClick={() => openEntry({ path: result.path, name: result.path.split("/").pop() ?? result.path, type: "file" })} data-testid={`button-open-search-result-${result.path}-${result.line}`}><strong>{result.path}<small>:{result.line}</small></strong><span>{result.context}</span></button><button className="repo-result-context" onClick={() => contextPaths.includes(result.path) ? onRemoveContext(result.path) : addContext(result.path)} aria-label={`${contextPaths.includes(result.path) ? "Remove" : "Add"} @file context for ${result.path}`} data-testid={`button-context-search-result-${result.path}-${result.line}`}>@</button></div>)}</div>}{file ? <div className="file-viewer"><div className="file-viewer-head"><div><strong><Code2 size={14} /> {file.path}</strong><small>{file.language} · {Math.round(file.size / 1024)} KB{file.truncated ? " · truncated safely" : ""}</small></div><button onClick={() => navigator.clipboard?.writeText(file.content)} aria-label="Copy file" data-testid="button-copy-file"><Clipboard size={14} /></button><button onClick={() => setFile(null)} aria-label="Close file viewer" data-testid="button-close-file-viewer"><X size={15} /></button></div><pre data-testid="repository-file-content">{file.content.split("\n").map((line, index) => <span key={index}><i>{index + 1}</i><code>{line || " "}</code></span>)}</pre><button className={contextPaths.includes(file.path) ? "context-button selected" : "context-button"} onClick={() => contextPaths.includes(file.path) ? onRemoveContext(file.path) : addContext(file.path)} data-testid="button-file-context">{contextPaths.includes(file.path) ? "Remove @file context" : "Add @file context"}</button></div> : <div className="repo-tree"><div className="repo-section-title">Files <a href={repository.webUrl} target="_blank" rel="noreferrer" aria-label="Open repository on GitHub" data-testid="link-open-repository"><ExternalLink size={12} /></a></div>{busy && !Object.keys(entries).length ? <div className="repo-loading" data-testid="loading-repository-tree"><LoaderCircle className="spin" size={15} /> Loading tree</div> : entries[""]?.length ? tree("") : <div className="repo-empty" data-testid="empty-repository-tree">No readable files were returned for this repository.</div>}</div>}</>}
    </>}
    {error && <div className="repo-error" role="alert" data-testid="error-repository-panel">{error}</div>}
  </aside>;
}