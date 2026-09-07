import { type CSSProperties, type FormEvent, type ReactNode, useEffect, useState } from 'react';
import type { RepositoryEntry, RepositoryFile, RepositoryRef } from '@workspace/api-client-react';
import {
  Aperture,
  ArrowLeft,
  Braces,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  CircleOff,
  Code2,
  File,
  FileCode2,
  FileJson,
  FilePlus,
  FileText,
  FileType2,
  FolderOpen,
  FolderPlus,
  Github,
  HardDrive,
  LoaderCircle,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Save,
  ShieldCheck,
  Trash2,
  X,
} from 'lucide-react';
import FileCodeEditor from '../components/file-code-editor';
import { Link } from 'wouter';

type Source = 'workspace' | 'github';
type WorkspaceEntry = { path: string; type: 'file' | 'directory'; size?: number; modifiedAt?: string };
type ExplorerEntry = WorkspaceEntry & { name: string; language?: string };
type WorkspaceFile = { path: string; content: string; size: number };
type GitHubStatus = { connected: boolean; status: 'connected' | 'invalid' | 'rate_limited' | 'unavailable' | 'not_connected' };
type DialogKind = 'new-file' | 'new-folder' | 'rename' | 'delete';

function displayError(error: unknown, fallback: string) {
  return error instanceof Error && error.message ? error.message : fallback;
}

async function explorerRequest<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, { credentials: 'include', ...options });
  const raw = await response.text();
  let body: unknown;
  try { body = raw ? JSON.parse(raw) : undefined; } catch { body = undefined; }
  if (!response.ok) {
    const message = typeof body === 'object' && body !== null && 'error' in body && typeof body.error === 'string'
      ? body.error
      : 'The file explorer request could not be completed.';
    throw new Error(message);
  }
  return body as T;
}

function readRepository(): RepositoryRef | null {
  try { return JSON.parse(localStorage.getItem('cosmic-repository') ?? 'null') as RepositoryRef | null; } catch { return null; }
}

function joinPath(parent: string, child: string) {
  return parent ? `${parent}/${child}` : child;
}

function parentPath(path: string) {
  return path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
}

function fileName(path: string) {
  return path.split('/').pop() ?? path;
}

function toGitHubEntry(entry: RepositoryEntry): ExplorerEntry {
  return { path: entry.path, name: entry.name || fileName(entry.path), type: entry.type, size: entry.size, language: entry.language };
}

function fileKind(path: string) {
  const extension = path.toLowerCase().split('.').pop() ?? '';
  if (extension === 'ts' || extension === 'tsx') return 'typescript';
  if (extension === 'js' || extension === 'jsx' || extension === 'mjs' || extension === 'cjs') return 'javascript';
  if (extension === 'json') return 'json';
  if (extension === 'md' || extension === 'markdown' || extension === 'mdx') return 'markdown';
  if (extension === 'yaml' || extension === 'yml') return 'yaml';
  if (extension === 'css' || extension === 'scss' || extension === 'less') return 'css';
  if (extension === 'html' || extension === 'htm' || extension === 'svg') return 'html';
  return 'generic';
}

function entryIcon(entry: ExplorerEntry, open = false) {
  if (entry.type === 'directory') return <FolderOpen size={15} />;
  const kind = fileKind(entry.path);
  return <FileIconForKind kind={kind} />;
}

function FileIconForKind({ kind }: { kind: string }) {
  if (kind === 'json') return <FileJson size={15} />;
  if (kind === 'typescript' || kind === 'javascript') return <FileCode2 size={15} />;
  if (kind === 'markdown' || kind === 'yaml') return <FileType2 size={15} />;
  if (kind === 'css' || kind === 'html') return <Braces size={15} />;
  return <File size={15} />;
}

export default function FileExplorerPage() {
  const [source, setSource] = useState<Source>('workspace');
  const [workspaceEntries, setWorkspaceEntries] = useState<Record<string, ExplorerEntry[]>>({});
  const [githubEntries, setGithubEntries] = useState<Record<string, ExplorerEntry[]>>({});
  const [expanded, setExpanded] = useState<string[]>([]);
  const [currentPath, setCurrentPath] = useState('');
  const [selectedPath, setSelectedPath] = useState('');
  const [selectedFile, setSelectedFile] = useState<WorkspaceFile | RepositoryFile | null>(null);
  const [draft, setDraft] = useState('');
  const [loading, setLoading] = useState(true);
  const [fileLoading, setFileLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [githubStatus, setGithubStatus] = useState<GitHubStatus | null>(null);
  const [repository] = useState<RepositoryRef | null>(readRepository);
  const [dialog, setDialog] = useState<DialogKind | null>(null);
  const [dialogValue, setDialogValue] = useState('');
  const [dialogBusy, setDialogBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [filterQuery, setFilterQuery] = useState('');
  const [cursorPosition, setCursorPosition] = useState({ line: 1, column: 1 });

  const entries = source === 'workspace' ? workspaceEntries : githubEntries;
  const githubAvailable = githubStatus?.connected === true;
  const isGithubReadOnly = source === 'github';
  const isDirty = Boolean(selectedFile && !isGithubReadOnly && draft !== selectedFile.content);
  const loadDirectory = async (path: string, nextSource = source, force = false) => {
    if (nextSource === 'github' && !repository) {
      setLoading(false);
      return;
    }
    const cached = nextSource === 'workspace' ? workspaceEntries[path] : githubEntries[path];
    if (!force && cached) return;
    setLoading(true);
    setError('');
    try {
      if (nextSource === 'workspace') {
        const result = await explorerRequest<WorkspaceEntry[]>(`/api/workspace/default/files${path ? `?path=${encodeURIComponent(path)}` : ''}`);
        const mapped = result.map((entry) => ({ ...entry, name: fileName(entry.path) }));
        setWorkspaceEntries((current) => ({ ...current, [path]: mapped }));
      } else {
        const result = await explorerRequest<RepositoryEntry[]>('/api/repository/tree', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ repository, path: path || undefined }),
        });
        setGithubEntries((current) => ({ ...current, [path]: result.map(toGitHubEntry) }));
      }
    } catch (cause) {
      setError(displayError(cause, `Could not load ${nextSource === 'workspace' ? 'workspace' : 'GitHub'} files.`));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void explorerRequest<GitHubStatus>('/api/settings/github')
      .then(setGithubStatus)
      .catch(() => setGithubStatus({ connected: false, status: 'not_connected' }));
  }, []);

  useEffect(() => {
    setCurrentPath('');
    setSelectedPath('');
    setSelectedFile(null);
    setDraft('');
    setExpanded([]);
    void loadDirectory('', source, true);
  }, [source]);

  const switchSource = (next: Source) => {
    if (next === 'github' && !githubAvailable) return;
    setSource(next);
  };

  const openEntry = async (entry: ExplorerEntry) => {
    setError('');
    if (entry.type === 'directory') {
      const nextExpanded = expanded.includes(entry.path)
        ? expanded.filter((path) => path !== entry.path)
        : [...expanded, entry.path];
      setExpanded(nextExpanded);
      setCurrentPath(entry.path);
      setSelectedPath('');
      setSelectedFile(null);
      setDraft('');
      await loadDirectory(entry.path);
      return;
    }
    setFileLoading(true);
    try {
      const file = source === 'workspace'
        ? await explorerRequest<WorkspaceFile>(`/api/workspace/default/file?path=${encodeURIComponent(entry.path)}`)
        : await explorerRequest<RepositoryFile>('/api/repository/file', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ repository, path: entry.path }),
        });
      setSelectedPath(file.path);
      setSelectedFile(file);
      setDraft(file.content);
      setCurrentPath(parentPath(file.path));
    } catch (cause) {
      setError(displayError(cause, 'The file could not be opened.'));
    } finally {
      setFileLoading(false);
    }
  };

  const refresh = () => {
    void loadDirectory(currentPath, source, true);
  };

  const saveFile = async (event: FormEvent) => {
    event.preventDefault();
    if (!selectedPath || !isDirty) return;
    setSaving(true);
    setError('');
    try {
      const file = await explorerRequest<WorkspaceEntry>('/api/workspace/default/file', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: selectedPath, content: draft }),
      });
      setSelectedFile({ path: file.path, content: draft, size: new TextEncoder().encode(draft).length });
      setNotice(`Saved ${file.path}`);
      await loadDirectory(currentPath, 'workspace', true);
    } catch (cause) {
      setError(displayError(cause, 'The file could not be saved.'));
    } finally {
      setSaving(false);
    }
  };

  const submitDialog = async (event: FormEvent) => {
    event.preventDefault();
    if (!dialog || dialogBusy) return;
    setDialogBusy(true);
    setError('');
    try {
      if (dialog === 'delete') {
        if (!selectedPath) return;
        await explorerRequest(`/api/workspace/default/file?path=${encodeURIComponent(selectedPath)}`, { method: 'DELETE' });
        setNotice(`Deleted ${selectedPath}`);
        setSelectedPath('');
        setSelectedFile(null);
        setDraft('');
        await loadDirectory(currentPath, 'workspace', true);
      } else {
        const value = dialogValue.trim();
        if (!value) return;
        if (dialog === 'new-file') {
          const path = joinPath(currentPath, value);
          await explorerRequest('/api/workspace/default/file', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ path, content: '' }),
          });
          setNotice(`Created ${path}`);
        } else if (dialog === 'new-folder') {
          const path = joinPath(currentPath, value);
          await explorerRequest('/api/workspace/default/directory', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ path }),
          });
          setNotice(`Created ${path}`);
        } else if (dialog === 'rename' && selectedPath) {
          const path = joinPath(parentPath(selectedPath), value);
          await explorerRequest('/api/workspace/default/rename', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ from: selectedPath, to: path }),
          });
          setNotice(`Renamed to ${path}`);
          setSelectedPath(path);
          if (selectedFile) setSelectedFile({ ...selectedFile, path });
        }
        await loadDirectory(currentPath, 'workspace', true);
      }
      setDialog(null);
      setDialogValue('');
    } catch (cause) {
      setError(displayError(cause, 'The workspace change could not be completed.'));
    } finally {
      setDialogBusy(false);
    }
  };

  const openDialog = (kind: DialogKind) => {
    setError('');
    setDialogValue(kind === 'rename' ? fileName(selectedPath) : '');
    setDialog(kind);
  };

  const normalizedFilter = filterQuery.trim().toLowerCase();
  const hasTreeMatch = (entry: ExplorerEntry): boolean => {
    if (!normalizedFilter) return true;
    if (entry.name.toLowerCase().includes(normalizedFilter)) return true;
    return entry.type === 'directory' && (entries[entry.path] ?? []).some(hasTreeMatch);
  };

  const renderTree = (path: string, depth = 0, rootGroup?: ExplorerEntry['type']): ReactNode[] => {
    const branch = (entries[path] ?? []).filter((entry) => (!rootGroup || path !== '' || entry.type === rootGroup) && hasTreeMatch(entry));
    return branch.flatMap((entry) => {
      const open = expanded.includes(entry.path) || Boolean(normalizedFilter && entry.type === 'directory' && hasTreeMatch(entry));
      const row = (
        <button
          type="button"
          className={`file-explorer-tree-row ${selectedPath === entry.path ? 'selected' : ''} ${entry.type === 'directory' ? 'directory' : 'file'}`}
          style={{ '--tree-depth': depth } as CSSProperties}
          key={entry.path}
          onClick={() => void openEntry(entry)}
          aria-current={selectedPath === entry.path ? 'true' : undefined}
          data-testid={`file-explorer-entry-${entry.path || 'root'}`}
        >
          {entry.type === 'directory' ? (open ? <ChevronDown size={13} /> : <ChevronRight size={13} />) : <span className="file-tree-spacer" />}
          <span className={`file-tree-icon ${entry.type} ${fileKind(entry.path)}`}>{entryIcon(entry, open)}</span>
          <span className="file-tree-name">{entry.name}</span>
          {entry.type === 'file' && entry.size !== undefined && <small>{formatBytes(entry.size)}</small>}
        </button>
      );
      return entry.type === 'directory' && open ? [row, ...renderTree(entry.path, depth + 1)] : [row];
    });
  };

  const breadcrumbs = currentPath ? currentPath.split('/') : [];
  const rootEntries = entries[''] ?? [];
  const folderCount = rootEntries.filter((entry) => entry.type === 'directory').length;
  const fileCount = rootEntries.filter((entry) => entry.type === 'file').length;
  const hasFilteredEntries = rootEntries.some(hasTreeMatch);
  const editorFileKind = selectedFile ? fileKind(selectedFile.path) : 'generic';

  return (
    <main className="file-explorer-page" data-testid="page-file-explorer">
      <header className="file-explorer-header">
        <div className="file-explorer-brand">
          <Link href="/" className="file-explorer-back" aria-label="Back to workspace"><ArrowLeft size={15} /> Workspace</Link>
          <span className="file-explorer-divider" />
          <div className="file-explorer-title">
            <div className="file-explorer-mark"><Aperture size={17} /></div>
            <div><span className="repo-kicker"><Code2 size={11} /> FULL FILE CONTROL</span><h1>File Explorer</h1></div>
          </div>
        </div>
        <div className="file-explorer-header-meta">
          <span className="file-explorer-scope"><ShieldCheck size={13} /> Server-authorized workspace access</span>
          <Link href="/" className="file-explorer-close" aria-label="Close file explorer"><X size={17} /></Link>
        </div>
      </header>

      <section className="file-explorer-layout">
        <aside className="file-explorer-sidebar" aria-label="File sources and tree">
          <div className="file-explorer-sidebar-head">
            <div><span className="file-explorer-eyebrow">SOURCES</span><strong>Choose a workspace</strong></div>
            <button type="button" className="file-explorer-icon-button" onClick={refresh} disabled={loading} aria-label="Refresh file tree">{loading ? <LoaderCircle className="spin" size={15} /> : <RefreshCw size={15} />}</button>
          </div>
          <div className="file-source-tabs" role="tablist" aria-label="File source">
            <button type="button" role="tab" aria-selected={source === 'workspace'} className={source === 'workspace' ? 'active' : ''} onClick={() => switchSource('workspace')} data-testid="tab-file-source-workspace"><HardDrive size={14} /><span>Workspace</span><small>editable</small></button>
            <button type="button" role="tab" aria-selected={source === 'github'} className={source === 'github' ? 'active' : ''} onClick={() => switchSource('github')} disabled={!githubAvailable} data-testid="tab-file-source-github"><Github size={14} /><span>GitHub</span><small>{githubAvailable ? 'read-only' : 'not connected'}</small></button>
          </div>
           <label className="file-explorer-search">
             <Search size={14} />
             <input value={filterQuery} onChange={(event) => setFilterQuery(event.target.value)} placeholder="Search files and code" aria-label="Search files and code" />
             {filterQuery && <button type="button" onClick={() => setFilterQuery('')} aria-label="Clear file search"><X size={13} /></button>}
           </label>
           <div className="file-tree-context">
            <div className="file-tree-context-head"><span className={`source-dot ${source}`} /> <strong>{source === 'workspace' ? 'Local workspace' : repository ? `${repository.owner}/${repository.name}` : 'GitHub repository'}</strong>{source === 'github' && <span className="read-only-badge">READ ONLY</span>}</div>
            {source === 'github' && !repository && <div className="file-explorer-callout"><CircleOff size={15} /><span>Connect a repository in the workspace Repository panel before browsing GitHub files.</span></div>}
            {source === 'github' && repository && <div className="file-explorer-readonly-note"><ShieldCheck size={13} /> Read-only — GitHub write is not supported here.</div>}
          </div>
           <nav className="file-tree" aria-label={`${source === 'workspace' ? 'Workspace' : 'GitHub'} file tree`}>
             {loading && !entries[''] ? <div className="file-tree-loading"><span /><span /><span /><span /></div> : entries['']?.length && hasFilteredEntries ? <>
               {folderCount > 0 && <div className="file-tree-section-label"><span>FOLDERS</span><small>{folderCount}</small></div>}
               {folderCount > 0 && renderTree('', 0, 'directory')}
               {fileCount > 0 && <div className="file-tree-section-label"><span>FILES</span><small>{fileCount}</small></div>}
               {fileCount > 0 && renderTree('', 0, 'file')}
             </> : <div className="file-tree-empty"><FileText size={20} />{filterQuery ? <><strong>No matching files</strong><span>Try another name or clear the search filter.</span></> : <><strong>{source === 'workspace' ? 'Workspace is empty' : 'No readable files'}</strong><span>{source === 'workspace' ? 'Create a file or folder to start shaping this workspace.' : 'The connected repository returned no readable files.'}</span></>}</div>}
          </nav>
          {source === 'workspace' && <div className="file-tree-actions">
            <button type="button" onClick={() => openDialog('new-file')} data-testid="button-new-workspace-file"><FilePlus size={14} /> New file</button>
            <button type="button" onClick={() => openDialog('new-folder')} data-testid="button-new-workspace-folder"><FolderPlus size={14} /> Folder</button>
          </div>}
        </aside>

        <section className={`file-explorer-editor ${selectedFile ? 'has-selection' : 'is-empty'}`} aria-label="File editor">
          <div className="file-editor-toolbar">
            <div className="file-editor-breadcrumbs">
              <span className={`source-pill ${source}`}><span className="source-dot" />{source === 'workspace' ? 'Workspace' : 'GitHub'}</span>
              <ChevronRight size={13} />
              <button type="button" onClick={() => { setCurrentPath(''); setSelectedPath(''); setSelectedFile(null); setDraft(''); }} className="breadcrumb-button">root</button>
              {breadcrumbs.map((crumb, index) => <span className="breadcrumb-segment" key={`${crumb}-${index}`}><ChevronRight size={13} /><button type="button" className="breadcrumb-button" onClick={() => { const path = breadcrumbs.slice(0, index + 1).join('/'); setCurrentPath(path); setSelectedPath(''); setSelectedFile(null); setDraft(''); void loadDirectory(path); }}>{crumb}</button></span>)}
            </div>
            <div className="file-editor-actions">
              {selectedFile && source === 'workspace' && <><button type="button" className="file-action-button" onClick={() => openDialog('rename')} aria-label="Rename selected file"><Pencil size={14} /> Rename</button><button type="button" className="file-action-button danger" onClick={() => openDialog('delete')} aria-label="Delete selected file"><Trash2 size={14} /> Delete</button></>}
              {selectedFile && source === 'github' && <span className="editor-readonly-label"><ShieldCheck size={13} /> Read-only</span>}
            </div>
          </div>
          {error && <div className="file-explorer-error" role="alert"><CircleAlert size={15} /><span>{error}</span><button type="button" onClick={() => setError('')} aria-label="Dismiss error"><X size={14} /></button></div>}
          {notice && <div className="file-explorer-notice" role="status"><CheckCircle2 size={15} /><span>{notice}</span><button type="button" onClick={() => setNotice('')} aria-label="Dismiss success message"><X size={14} /></button></div>}
           {fileLoading ? <div className="file-editor-loading"><LoaderCircle className="spin" size={20} /><strong>Opening file</strong><span>Reading through the authorized file boundary…</span></div> : selectedFile ? <form className="file-editor-card" onSubmit={saveFile}>
             <div className="file-editor-tabbar">
               <div className="file-editor-tab active"><span className={`file-editor-file-icon ${editorFileKind}`}><FileIconForKind kind={editorFileKind} /></span><strong>{fileName(selectedFile.path)}</strong><span className={isDirty ? 'editor-dirty-dot' : 'editor-clean-dot'} /></div>
               <button type="button" className="file-editor-tab-close" onClick={() => { setSelectedPath(''); setSelectedFile(null); setDraft(''); }} aria-label="Close selected file"><X size={14} /></button>
            </div>
            {'truncated' in selectedFile && selectedFile.truncated && <div className="file-editor-warning"><CircleAlert size={14} /> This GitHub file is safely truncated for viewing.</div>}
            <div className="file-editor-input-wrap">
               <FileCodeEditor key={`${source}:${selectedFile.path}`} filePath={selectedFile.path} value={draft} readOnly={isGithubReadOnly} onChange={setDraft} onCursorChange={setCursorPosition} />
            </div>
             <div className="file-editor-card-foot"><span><strong>Ln {cursorPosition.line}, Col {cursorPosition.column}</strong><span className="file-editor-status-separator" />{draft.length.toLocaleString()} characters<span className="file-editor-status-separator" />{source === 'github' ? 'Read-only' : isDirty ? 'Unsaved' : 'Saved'}<span className="file-editor-language">{editorFileKind}</span></span>{!isGithubReadOnly && <button type="submit" className="file-save-button" disabled={saving || !isDirty} data-testid="button-save-file-explorer">{saving ? <LoaderCircle className="spin" size={14} /> : <Save size={14} />}{saving ? 'Saving' : 'Save changes'}</button>}</div>
          </form> : <div className="file-editor-empty"><div className="file-editor-empty-orb"><Code2 size={24} /></div><span className="file-explorer-eyebrow">{source === 'workspace' ? 'WORKSPACE EDITOR' : 'GITHUB VIEWER'}</span><h2>Select a file to begin</h2><p>{source === 'workspace' ? 'Open any text file from the tree to edit it safely. Every change passes through the existing authenticated workspace API.' : 'Browse repository source without leaving the workspace. GitHub files are intentionally read-only on this surface.'}</p><div className="file-editor-empty-hint"><span className="keyboard-hint">⌘</span><span>Choose a file from the tree</span></div></div>}
        </section>
      </section>

      <footer className="file-explorer-footer"><span><ShieldCheck size={13} /> Normal Agent and Ruflo Agent use the same existing server authorization boundary.</span><span>GitHub writes remain disabled by design.</span></footer>

      {dialog && <div className="file-explorer-dialog-backdrop" role="presentation">
        <form className="file-explorer-dialog" role="dialog" aria-modal="true" aria-labelledby="file-dialog-title" onSubmit={submitDialog}>
          <div className={`file-dialog-icon ${dialog === 'delete' ? 'danger' : ''}`}>{dialog === 'delete' ? <Trash2 size={18} /> : dialog === 'rename' ? <Pencil size={18} /> : dialog === 'new-folder' ? <FolderPlus size={18} /> : <FilePlus size={18} />}</div>
          <span className="file-explorer-eyebrow">{dialog === 'delete' ? 'CONFIRM DELETION' : 'WORKSPACE ACTION'}</span>
          <h2 id="file-dialog-title">{dialog === 'delete' ? `Delete ${fileName(selectedPath)}?` : dialog === 'rename' ? 'Rename workspace path' : dialog === 'new-folder' ? 'Create a new folder' : 'Create a new file'}</h2>
          <p>{dialog === 'delete' ? 'This removes the selected local workspace path permanently. GitHub files cannot be deleted from this page.' : 'This action is sent through the existing authenticated workspace file API and remains subject to its safety checks.'}</p>
          {dialog !== 'delete' && <label className="file-dialog-field"><span>{dialog === 'rename' ? 'New name' : 'Name or relative path'}</span><input autoFocus value={dialogValue} onChange={(event) => setDialogValue(event.target.value)} placeholder={dialog === 'new-folder' ? 'src' : 'notes.md'} disabled={dialogBusy} data-testid="input-file-explorer-dialog" /></label>}
          <div className="file-dialog-actions"><button type="button" className="file-dialog-cancel" onClick={() => setDialog(null)} disabled={dialogBusy}>Cancel</button><button type="submit" className={`file-dialog-confirm ${dialog === 'delete' ? 'danger' : ''}`} disabled={dialogBusy || (dialog !== 'delete' && !dialogValue.trim())}>{dialogBusy ? <LoaderCircle className="spin" size={14} /> : dialog === 'delete' ? <Trash2 size={14} /> : <CheckCircle2 size={14} />}{dialogBusy ? 'Working…' : dialog === 'delete' ? 'Delete permanently' : 'Continue'}</button></div>
        </form>
      </div>}
    </main>
  );
}

function formatBytes(size: number) {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(size > 10 * 1024 ? 0 : 1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}