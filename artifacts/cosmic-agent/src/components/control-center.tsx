import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  getGetControlCenterQueryKey,
  getListSecretsQueryKey,
  useCreateSecret,
  useDeleteSecret,
  useGetControlCenter,
  useListSecrets,
  useRotateSecret,
  type ControlCenterCategory,
  type ControlCenterModule,
  type ControlCenterSnapshot,
  type SecretMetadata,
} from '@workspace/api-client-react';
import {
  Activity,
  AlertTriangle,
  ArrowLeft,
  BadgeCheck,
  BarChart3,
  Check,
  CheckCircle2,
  ChevronUp,
  ChevronRight,
  CircleOff,
  Clock3,
  Code2,
  Database,
  FileCode2,
  FilePlus,
  FileText,
  FolderOpen,
  GitBranch,
  Github,
  HardDrive,
  History,
  KeyRound,
  LayoutDashboard,
  LockKeyhole,
  LoaderCircle,
  Network,
  Plus,
  PlugZap,
  RefreshCw,
  RotateCcw,
  Save,
  ScrollText,
  ServerCog,
  Settings2,
  ShieldCheck,
  Terminal,
  Trash2,
  Users,
  Workflow,
  X,
  type LucideIcon,
} from 'lucide-react';

const DISABLED_CLASSIFICATION = 'DISABLED — INTENTIONALLY RESTRICTED';

const CATEGORY_ORDER = [
  { id: 'development', label: 'DEVELOPMENT', modules: ['skills', 'files', 'console', 'workflows'] },
  { id: 'source-control', label: 'SOURCE CONTROL', modules: ['git', 'changes', 'history'] },
  { id: 'data-integrations', label: 'DATA & INTEGRATIONS', modules: ['database', 'storage', 'integrations'] },
  { id: 'security', label: 'SECURITY', modules: ['secrets', 'permissions', 'audit', 'security-center'] },
  { id: 'account', label: 'ACCOUNT', modules: ['users-auth'] },
] as const;

const MODULE_ICONS: Record<string, LucideIcon> = {
  skills: Code2,
  files: FolderOpen,
  console: Terminal,
  workflows: Workflow,
  git: GitBranch,
  changes: FileCode2,
  history: History,
  database: Database,
  storage: HardDrive,
  integrations: PlugZap,
  secrets: KeyRound,
  permissions: LockKeyhole,
  audit: ScrollText,
  'security-center': ShieldCheck,
  'users-auth': Users,
};

type PanelView = 'overview' | string;

export function ControlCenter({
  onClose,
  notify,
  integrationDetail,
}: {
  onClose: () => void;
  notify: (message: string) => void;
  integrationDetail?: (onBack: () => void) => ReactNode;
}) {
  const [view, setView] = useState<PanelView>('overview');
  const { data, isLoading, isError, refetch, isFetching } = useGetControlCenter({
    query: { queryKey: getGetControlCenterQueryKey(), refetchInterval: 15_000 },
  });
  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, []);

  const moduleIndex = useMemo(() => {
    const index = new Map<string, ControlCenterModule>();
    data?.categories.forEach((category) => category.modules.forEach((module) => index.set(module.id, module)));
    return index;
  }, [data]);
  const activeModule = view === 'overview' ? undefined : moduleIndex.get(view);
  const orderedCategories = CATEGORY_ORDER.map((definition) => ({
    ...definition,
    category: data?.categories.find((category) => category.id === definition.id),
  }));
  const modules = orderedCategories.flatMap((group) => orderedModules(group.category, group.modules));
  const restrictedCount = modules.filter((module) => isDisabled(module)).length;
  const verifiedCount = modules.filter((module) => module.status === 'verified').length;

  const selectView = (next: string) => {
    if (next === 'overview') {
      setView('overview');
      return;
    }
    const target = moduleIndex.get(next);
    if (target && !isDisabled(target)) setView(next);
  };

  return <aside className="control-center" role="dialog" aria-modal="true" aria-label="Cosmic Agent Control Center">
    <div className="control-center-head">
      <div className="control-center-title">
        <div className="control-center-mark"><ServerCog size={18} /></div>
        <div>
          <span className="control-center-kicker">COSMIC AGENT / PHASE 12.6</span>
          <strong>Control Center</strong>
          <small>Server-reported capability posture</small>
        </div>
      </div>
      <button className="icon-button" onClick={onClose} aria-label="Close Control Center" data-testid="button-close-control-center"><X size={18} /></button>
    </div>

    <div className="control-center-body">
      <nav className="control-center-nav" aria-label="Control Center modules">
        <button className={`control-home ${view === 'overview' ? 'active' : ''}`} onClick={() => selectView('overview')} data-testid="button-control-center-overview">
          <LayoutDashboard size={15} /><span>Overview</span><ChevronRight size={13} />
        </button>
        {orderedCategories.map((group) => <section className="control-nav-group" key={group.id}>
          <h2>{group.label}</h2>
          <div className="control-nav-items">
            {orderedModules(group.category, group.modules).map((module) => {
              const Icon = MODULE_ICONS[module.id] ?? Settings2;
              const disabled = isDisabled(module);
              return disabled
                ? <div className="control-nav-item disabled" aria-disabled="true" key={module.id} data-testid={`status-control-module-${module.id}`}>
                    <Icon size={14} /><span>{module.label}</span><CircleOff size={12} />
                  </div>
                : <button className={`control-nav-item ${view === module.id ? 'active' : ''}`} onClick={() => selectView(module.id)} key={module.id} data-testid={`button-control-module-${module.id}`}>
                    <Icon size={14} /><span>{module.label}</span><ChevronRight size={12} />
                  </button>;
            })}
          </div>
        </section>)}
        <div className="control-nav-foot"><LockKeyhole size={12} /> No authority is granted from this panel.</div>
      </nav>

      <main className="control-center-main">
        {isLoading && <ControlCenterSkeleton />}
        {isError && <div className="control-center-error" role="alert" data-testid="status-control-center-error">
          <AlertTriangle size={17} />
          <div><strong>Control Center unavailable</strong><p>The server did not return a capability snapshot.</p><button onClick={() => void refetch()} data-testid="button-retry-control-center"><RefreshCw size={13} /> Retry</button></div>
        </div>}
        {!isLoading && !isError && data && (activeModule ? <ModuleDetail module={activeModule} integrationDetail={activeModule.id === 'integrations' ? integrationDetail?.(() => setView('integrations')) : undefined} onBack={() => setView('overview')} notify={notify} /> : <Overview data={data} modules={modules} restrictedCount={restrictedCount} verifiedCount={verifiedCount} isFetching={isFetching} onRefresh={() => void refetch()} onSelect={selectView} notify={notify} />)}
      </main>
    </div>
  </aside>;
}

function orderedModules(category: ControlCenterCategory | undefined, order: readonly string[]): ControlCenterModule[] {
  if (!category) return [];
  return order.map((id) => category.modules.find((module) => module.id === id)).filter((module): module is ControlCenterModule => Boolean(module));
}

function isDisabled(module: ControlCenterModule) {
  return module.classification === DISABLED_CLASSIFICATION || module.classification.startsWith('DISABLED');
}

function Overview({
  data,
  modules,
  restrictedCount,
  verifiedCount,
  isFetching,
  onRefresh,
  onSelect,
  notify,
}: {
  data: ControlCenterSnapshot;
  modules: ControlCenterModule[];
  restrictedCount: number;
  verifiedCount: number;
  isFetching: boolean;
  onRefresh: () => void;
  onSelect: (id: string) => void;
  notify: (message: string) => void;
}) {
  const statusLabel = data.overallStatus === 'operational' ? 'Operational' : data.overallStatus === 'attention' ? 'Attention' : 'Restricted';
  return <div className="control-overview" data-testid="panel-control-center-overview">
    <header className="control-overview-hero">
      <div>
        <span className="control-section-kicker"><BarChart3 size={12} /> HOME / OVERVIEW</span>
        <h1>Capability posture</h1>
        <p>A read-only map of what Cosmic Agent can see, use, and deliberately withhold right now.</p>
      </div>
      <button className="control-refresh" onClick={() => { onRefresh(); notify('Control Center refresh requested.'); }} disabled={isFetching} aria-label="Refresh Control Center" data-testid="button-refresh-control-center">
        <RefreshCw size={14} className={isFetching ? 'spin' : ''} /> {isFetching ? 'Refreshing' : 'Refresh'}
      </button>
    </header>

    <section className="control-posture-card">
      <div className="posture-status">
        <span className={`posture-orb ${data.overallStatus}`}><CheckCircle2 size={18} /></span>
        <div><span>SERVER POSTURE</span><strong>{statusLabel}</strong><small>Snapshot generated {formatTimestamp(data.generatedAt)}</small></div>
      </div>
      <div className="posture-line"><span /><i /></div>
      <div className="posture-note"><ShieldCheck size={15} /><span>Permissions remain server-owned and approval-gated.</span></div>
    </section>

    <div className="control-metric-grid">
      <Metric value={modules.length} label="Declared modules" />
      <Metric value={verifiedCount} label="Verified surfaces" tone="positive" />
      <Metric value={restrictedCount} label="Intentionally restricted" tone="restricted" />
      <Metric value={data.activity.length} label="Recent audit signals" />
    </div>

    <section className="control-section-block">
      <div className="control-block-heading"><div><span className="control-section-kicker"><Network size={12} /> MODULE INVENTORY</span><h2>Bounded surfaces</h2></div><span className="control-count">{modules.length} modules</span></div>
      <div className="control-module-grid">
        {modules.map((module) => <ModuleSummary module={module} onSelect={onSelect} key={module.id} />)}
      </div>
    </section>

    <section className="control-section-block">
      <div className="control-block-heading"><div><span className="control-section-kicker"><Activity size={12} /> ACTIVITY / AUDIT</span><h2>Recent server signals</h2></div><span className="control-count">current user</span></div>
      {data.activity.length ? <div className="control-activity-list">{data.activity.map((item, index) => <ActivityRow item={item} key={`${item.timestamp}-${item.label}-${index}`} />)}</div> : <EmptyValue text="No activity or audit records are available." />}
    </section>
  </div>;
}

function ModuleSummary({ module, onSelect }: { module: ControlCenterModule; onSelect: (id: string) => void }) {
  const Icon = MODULE_ICONS[module.id] ?? Settings2;
  const disabled = isDisabled(module);
  return <article className={`control-module-card ${disabled ? 'restricted' : ''}`} data-testid={`card-control-module-${module.id}`}>
    <div className="control-module-card-head"><span className="control-module-icon"><Icon size={15} /></span><div><strong>{module.label}</strong><span>{module.classification}</span></div>{disabled ? <CircleOff size={14} /> : <button onClick={() => onSelect(module.id)} aria-label={`Open ${module.label}`} data-testid={`button-open-control-module-${module.id}`}><ChevronRight size={14} /></button>}</div>
    <div className="module-quick-fields">
      <QuickField label="Status" value={module.status} />
      <QuickField label="Permissions" value={module.permissions.length ? module.permissions.join(', ') : 'None declared'} />
      <QuickField label="Activity / Audit" value={module.activity.length ? module.activity[0] : 'No records'} />
      <QuickField label="Configuration" value={module.configuration[0] ?? 'No configuration exposed'} />
      <QuickField label="Diagnostics" value={module.diagnostics[0] ?? 'No diagnostics reported'} />
    </div>
    {disabled && <div className="disabled-reason"><strong>{DISABLED_CLASSIFICATION}</strong><span>{module.reason}</span></div>}
  </article>;
}

function ModuleDetail({ module, onBack, integrationDetail, notify }: { module: ControlCenterModule; onBack: () => void; integrationDetail?: ReactNode; notify: (message: string) => void }) {
  const Icon = MODULE_ICONS[module.id] ?? Settings2;
  const disabled = isDisabled(module);
  return <div className="control-module-detail" data-testid={`panel-control-module-${module.id}`}>
    <button className="control-back" onClick={onBack} data-testid="button-control-center-back"><ArrowLeft size={14} /> Overview</button>
    <header className="module-detail-heading">
      <div className="module-detail-icon"><Icon size={19} /></div>
      <div><span className="control-section-kicker">MODULE / {module.id}</span><h1>{module.label}</h1><p>{module.reason}</p></div>
      <StatusBadge module={module} />
    </header>
    {disabled && <div className="disabled-banner"><CircleOff size={16} /><div><strong>{DISABLED_CLASSIFICATION}</strong><span>{module.reason}</span></div></div>}
    {module.id === 'git' && <div className="readonly-banner"><GitBranch size={15} /><div><strong>READ-ONLY SURFACE</strong><span>Repository inspection only. This panel provides no repository write controls.</span></div></div>}
    <div className="module-detail-grid">
      <DetailSection title="Status" icon={<BadgeCheck size={14} />}><div className="status-detail"><StatusBadge module={module} /><span>Server status: {module.status}</span><span>Classification: {module.classification}</span></div></DetailSection>
      <DetailSection title="Permissions" icon={<LockKeyhole size={14} />}><ValueList items={module.permissions} empty="No permissions granted." /></DetailSection>
      <DetailSection title="Activity / Audit" icon={<Activity size={14} />}><ValueList items={module.activity} empty="No activity or audit records are available." /></DetailSection>
      <DetailSection title="Configuration" icon={<Settings2 size={14} />}><ValueList items={module.configuration} empty="No configuration is exposed." /></DetailSection>
      <DetailSection title="Diagnostics" icon={<ServerCog size={14} />}><ValueList items={module.diagnostics} empty="No diagnostics are reported." /></DetailSection>
    </div>
    {!disabled && module.id === 'integrations' && integrationDetail && <section className="control-integration-detail" data-testid="panel-control-center-integrations-detail">
      <div className="control-block-heading"><div><span className="control-section-kicker"><Github size={12} /> CONNECTED DETAIL</span><h2>GitHub credentials</h2></div><span className="control-count">sanitized status</span></div>
      {integrationDetail}
    </section>}
    {!disabled && module.id === 'files' && <WorkspaceFilesModule notify={notify} />}
    {!disabled && module.id === 'secrets' && <SecretsModule notify={notify} />}
  </div>;
}

type WorkspaceEntry = { path: string; type: 'file' | 'directory'; size?: number; modifiedAt?: string };
type WorkspaceFileContent = { path: string; content: string; size: number };

async function workspaceRequest<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { credentials: 'include', ...init });
  const raw = await response.text();
  let body: unknown;
  try { body = raw ? JSON.parse(raw) : undefined; } catch { body = undefined; }
  if (!response.ok) {
    const message = typeof body === 'object' && body !== null && 'error' in body && typeof body.error === 'string' ? body.error : 'Workspace request failed.';
    throw new Error(message);
  }
  return body as T;
}

function WorkspaceFilesModule({ notify }: { notify: (message: string) => void }) {
  const [entries, setEntries] = useState<WorkspaceEntry[]>([]);
  const [currentPath, setCurrentPath] = useState('');
  const [selectedPath, setSelectedPath] = useState('');
  const [content, setContent] = useState('');
  const [draft, setDraft] = useState('');
  const [newFilePath, setNewFilePath] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const loadDirectory = async (path: string) => {
    setLoading(true);
    setError('');
    try {
      const next = await workspaceRequest<WorkspaceEntry[]>(`/api/workspace/default/files${path ? `?path=${encodeURIComponent(path)}` : ''}`);
      setEntries(next);
      setCurrentPath(path);
      setSelectedPath('');
      setContent('');
      setDraft('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Workspace files could not be loaded.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void loadDirectory(''); }, []);

  const openFile = async (path: string) => {
    setError('');
    try {
      const file = await workspaceRequest<WorkspaceFileContent>(`/api/workspace/default/file?path=${encodeURIComponent(path)}`);
      setSelectedPath(file.path);
      setContent(file.content);
      setDraft(file.content);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Workspace file could not be opened.');
    }
  };

  const saveFile = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!selectedPath) return;
    setSaving(true);
    setError('');
    try {
      const file = await workspaceRequest<WorkspaceEntry>('/api/workspace/default/file', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: selectedPath, content: draft }),
      });
      setContent(draft);
      notify(`Saved ${file.path}.`);
      await loadDirectory(currentPath);
      setSelectedPath(file.path);
      setContent(draft);
      setDraft(draft);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Workspace file could not be saved.');
    } finally {
      setSaving(false);
    }
  };

  const createFile = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const name = newFilePath.trim();
    if (!name) return;
    const path = currentPath ? `${currentPath}/${name}` : name;
    setSaving(true);
    setError('');
    try {
      const file = await workspaceRequest<WorkspaceEntry>('/api/workspace/default/file', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path, content: '' }),
      });
      setNewFilePath('');
      await loadDirectory(currentPath);
      await openFile(file.path);
      notify(`Created ${file.path}.`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Workspace file could not be created.');
    } finally {
      setSaving(false);
    }
  };

  const parentPath = currentPath.includes('/') ? currentPath.slice(0, currentPath.lastIndexOf('/')) : '';
  const isDirty = selectedPath !== '' && draft !== content;

  return <section className="workspace-files-module" data-testid="panel-control-center-files">
    <div className="workspace-files-heading">
      <div><span className="control-section-kicker"><FolderOpen size={12} /> LOCAL WORKSPACE</span><h2>Workspace files</h2><p>Browse and edit text files through the authenticated, path-bounded workspace API.</p></div>
      <span className="workspace-files-count">{loading ? 'syncing' : `${entries.length} entries`}</span>
    </div>
    <div className="workspace-files-trust"><ShieldCheck size={14} /><span>Traversal, symlink, protected-path, and file-size checks remain server-owned.</span></div>
    <div className="workspace-files-toolbar">
      <div className="workspace-breadcrumb"><button type="button" onClick={() => void loadDirectory('')} className={!currentPath ? 'active' : ''}>workspace</button>{currentPath.split('/').filter(Boolean).map((part, index, parts) => { const path = parts.slice(0, index + 1).join('/'); return <span key={path}><ChevronRight size={11} /><button type="button" onClick={() => void loadDirectory(path)} className={path === currentPath ? 'active' : ''}>{part}</button></span>; })}</div>
      <button type="button" className="workspace-refresh" onClick={() => void loadDirectory(currentPath)} disabled={loading} aria-label="Refresh workspace files" data-testid="button-refresh-workspace-files"><RefreshCw className={loading ? 'spin' : ''} size={13} /></button>
    </div>
    {currentPath && <button type="button" className="workspace-up" onClick={() => void loadDirectory(parentPath)}><ChevronUp size={13} /> Up one level</button>}
    {error && <div className="workspace-files-error" role="alert" data-testid="status-workspace-files-error"><AlertTriangle size={14} /><span>{error}</span></div>}
    {loading ? <div className="workspace-files-list" aria-label="Loading workspace files"><span /><span /><span /></div> : entries.length ? <div className="workspace-files-list" data-testid="list-workspace-files">{entries.map((entry) => <button type="button" className={`workspace-file-row ${selectedPath === entry.path ? 'selected' : ''}`} key={entry.path} onClick={() => entry.type === 'directory' ? void loadDirectory(entry.path) : void openFile(entry.path)}><span className="workspace-file-icon">{entry.type === 'directory' ? <FolderOpen size={14} /> : <FileText size={14} />}</span><span className="workspace-file-name">{entry.path.split('/').pop() ?? entry.path}</span><span className="workspace-file-meta">{entry.type === 'directory' ? 'folder' : `${Math.max(0, entry.size ?? 0)} bytes`}</span><ChevronRight size={12} /></button>)}</div> : <div className="workspace-files-empty"><FileCode2 size={17} /><div><strong>No editable files in this workspace</strong><span>Create a text file below, or open a coding session to populate the local workspace.</span></div></div>}
    <form className="workspace-new-file" onSubmit={createFile}><label><span>New text file</span><input value={newFilePath} onChange={(event) => setNewFilePath(event.target.value)} placeholder="notes.md" autoComplete="off" disabled={saving} data-testid="input-new-workspace-file" /></label><button type="submit" disabled={saving || !newFilePath.trim()}><FilePlus size={13} /> Create</button></form>
    {selectedPath && <form className="workspace-editor" onSubmit={saveFile}><div className="workspace-editor-head"><div><span className="control-section-kicker"><FileCode2 size={12} /> EDITOR</span><strong>{selectedPath}</strong></div><span className={isDirty ? 'workspace-dirty' : 'workspace-saved'}>{isDirty ? 'Unsaved changes' : 'Saved'}</span></div><textarea value={draft} onChange={(event) => setDraft(event.target.value)} spellCheck={false} aria-label={`Edit ${selectedPath}`} data-testid="textarea-workspace-file" /><div className="workspace-editor-actions"><span>{Math.max(0, draft.length)} characters</span><button type="submit" disabled={saving || !isDirty} data-testid="button-save-workspace-file">{saving ? <LoaderCircle className="spin" size={13} /> : <Save size={13} />} {saving ? 'Saving' : 'Save file'}</button></div></form>}
  </section>;
}

function SecretsModule({ notify }: { notify: (message: string) => void }) {
  const queryClient = useQueryClient();
  const { data: secrets, isLoading, isError, isFetching, refetch } = useListSecrets({
    query: { queryKey: getListSecretsQueryKey() },
  });
  const [editor, setEditor] = useState<'add' | string>('add');
  const [name, setName] = useState('');
  const [value, setValue] = useState('');
  const [formError, setFormError] = useState('');
  const [pendingDelete, setPendingDelete] = useState<SecretMetadata | null>(null);

  const syncAfterMutation = () => {
    void Promise.all([
      refetch(),
      queryClient.invalidateQueries({ queryKey: getListSecretsQueryKey() }),
      queryClient.invalidateQueries({ queryKey: getGetControlCenterQueryKey() }),
    ]);
  };
  const clearEditor = () => {
    setName('');
    setValue('');
    setEditor('add');
  };
  const reportError = (error: unknown, fallback: string) => {
    setFormError(error instanceof Error ? error.message : fallback);
  };
  const createSecret = useCreateSecret({
    mutation: {
      onSuccess: () => {
        clearEditor();
        setFormError('');
        notify('Secret added. The value was encrypted and cleared from this form.');
        syncAfterMutation();
      },
      onError: (error) => reportError(error, 'The secret could not be added.'),
    },
  });
  const rotateSecret = useRotateSecret({
    mutation: {
      onSuccess: () => {
        clearEditor();
        setFormError('');
        notify('Secret rotated. The previous value is no longer active.');
        syncAfterMutation();
      },
      onError: (error) => reportError(error, 'The secret could not be rotated.'),
    },
  });
  const deleteSecret = useDeleteSecret({
    mutation: {
      onSuccess: () => {
        const deletedName = pendingDelete?.name ?? 'Secret';
        setPendingDelete(null);
        setFormError('');
        notify(`${deletedName} deleted from the workspace.`);
        syncAfterMutation();
      },
      onError: (error) => {
        setPendingDelete(null);
        reportError(error, 'The secret could not be deleted.');
      },
    },
  });
  const busy = createSecret.isPending || rotateSecret.isPending || deleteSecret.isPending;
  const editingSecret = editor !== 'add' ? secrets?.find((secret) => secret.id === editor) : undefined;

  const openAdd = () => {
    setEditor('add');
    setName('');
    setValue('');
    setFormError('');
  };
  const openRotate = (secret: SecretMetadata) => {
    setEditor(secret.id);
    setName(secret.name);
    setValue('');
    setFormError('');
  };
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setFormError('');
    const trimmedValue = value.trim();
    if (!trimmedValue) {
      setFormError('Enter a new value before saving.');
      return;
    }
    if (editor === 'add') {
      const trimmedName = name.trim();
      if (!trimmedName) {
        setFormError('Enter a stable name for this secret.');
        return;
      }
      createSecret.mutate({ data: { name: trimmedName, value: trimmedValue } });
    } else {
      rotateSecret.mutate({ secretId: editor, data: { value: trimmedValue } });
    }
  };

  return <section className="secrets-console" data-testid="panel-control-center-secrets">
    <div className="secrets-console-heading">
      <div>
        <span className="control-section-kicker"><KeyRound size={12} /> ENCRYPTED STORAGE</span>
        <h2>Workspace secrets</h2>
        <p>Credentials are write-only here. Cosmic Agent receives metadata, never the secret value.</p>
      </div>
      <span className="secrets-count">{isFetching ? 'syncing' : `${secrets?.length ?? 0} stored`}</span>
    </div>

    <div className="secret-trust-band">
      <span className="secret-trust-icon"><ShieldCheck size={15} /></span>
      <div><strong>Protected at the boundary</strong><span>Values are encrypted server-side and cleared from this surface after each save.</span></div>
      <span className="secret-trust-state"><Check size={12} /> metadata only</span>
    </div>

    <form className="secret-editor" onSubmit={submit} data-testid="form-secret-editor">
      <div className="secret-editor-head">
        <div><span className="control-section-kicker">{editor === 'add' ? 'NEW CREDENTIAL' : 'ROTATE CREDENTIAL'}</span><strong>{editor === 'add' ? 'Add a workspace secret' : `Replace ${editingSecret?.name ?? 'secret'} value`}</strong></div>
        {editor !== 'add' && <button type="button" className="secret-text-button" onClick={openAdd} disabled={busy}>Cancel rotation</button>}
      </div>
      {editor === 'add' && <label className="secret-field"><span>Reference name</span><input data-testid="input-secret-name" value={name} onChange={(event) => setName(event.target.value)} placeholder="for example, deploy-token" maxLength={120} autoComplete="off" disabled={busy} /></label>}
      <label className="secret-field"><span>{editor === 'add' ? 'Secret value' : 'New secret value'}</span><input data-testid="input-secret-value" type="password" value={value} onChange={(event) => setValue(event.target.value)} placeholder="Enter value — it will not be shown again" maxLength={10000} autoComplete="new-password" disabled={busy} /></label>
      {formError && <div className="secret-form-error" role="alert" data-testid="status-secret-error"><AlertTriangle size={14} />{formError}</div>}
      <div className="secret-editor-actions">
        <span><LockKeyhole size={12} /> Never returned in API responses</span>
        <button className="secret-primary-button" type="submit" disabled={busy || !value.trim()} data-testid={editor === 'add' ? 'button-add-secret' : 'button-rotate-secret'}>
          {busy && editor !== 'add' ? <LoaderCircle className="spin" size={14} /> : editor === 'add' ? <Plus size={14} /> : <RotateCcw size={14} />}
          {busy ? 'Saving securely' : editor === 'add' ? 'Add secret' : 'Rotate secret'}
        </button>
      </div>
    </form>

    <div className="secret-list-heading">
      <div><span className="control-section-kicker">STORED METADATA</span><h3>Active credentials</h3></div>
      <button className="secret-refresh-button" type="button" onClick={() => void refetch()} disabled={isFetching} aria-label="Refresh secret metadata" data-testid="button-refresh-secrets"><RefreshCw className={isFetching ? 'spin' : ''} size={13} /></button>
    </div>
    {isLoading && <div className="secret-list" aria-label="Loading secret metadata"><span className="secret-skeleton" /><span className="secret-skeleton" /><span className="secret-skeleton" /></div>}
    {isError && <div className="secret-state-card error" role="alert" data-testid="status-secrets-load-error"><AlertTriangle size={16} /><div><strong>Secret metadata unavailable</strong><span>Nothing was changed. Try the secure metadata request again.</span><button type="button" onClick={() => void refetch()} data-testid="button-retry-secrets"><RefreshCw size={12} /> Retry request</button></div></div>}
    {!isLoading && !isError && !secrets?.length && <div className="secret-state-card empty" data-testid="status-secrets-empty"><span className="secret-empty-mark"><KeyRound size={17} /></span><div><strong>No workspace secrets yet</strong><span>Add the first credential when a private integration needs it. Only its masked metadata will remain visible here.</span></div></div>}
    {!isLoading && !isError && Boolean(secrets?.length) && <div className="secret-list" data-testid="list-secrets">
      {secrets?.map((secret) => <article className={`secret-row ${editor === secret.id ? 'is-editing' : ''}`} key={secret.id} data-testid={`row-secret-${secret.id}`}>
        <div className="secret-row-mark"><KeyRound size={15} /></div>
        <div className="secret-row-main"><strong>{secret.name}</strong><span>{secret.maskedValue}</span><small>Added {formatTimestamp(secret.createdAt)}{secret.lastUsedAt ? ` · Last used ${formatTimestamp(secret.lastUsedAt)}` : ' · Not used yet'}</small></div>
        <div className="secret-row-actions">
          <button type="button" className="secret-icon-action" onClick={() => openRotate(secret)} disabled={busy} aria-label={`Rotate ${secret.name}`} data-testid={`button-rotate-secret-${secret.id}`}><RotateCcw size={14} /></button>
          <button type="button" className="secret-icon-action danger" onClick={() => { setPendingDelete(secret); setFormError(''); }} disabled={busy} aria-label={`Delete ${secret.name}`} data-testid={`button-delete-secret-${secret.id}`}><Trash2 size={14} /></button>
        </div>
      </article>)}
    </div>}

    {pendingDelete && <div className="secret-confirm-backdrop" role="presentation">
      <div className="secret-confirm" role="dialog" aria-modal="true" aria-labelledby="secret-confirm-title" data-testid="dialog-delete-secret">
        <span className="secret-confirm-icon"><Trash2 size={17} /></span>
        <span className="control-section-kicker">IRREVERSIBLE ACTION</span>
        <h3 id="secret-confirm-title">Delete {pendingDelete.name}?</h3>
        <p>This removes the encrypted credential from the workspace. Any integration depending on it may stop working.</p>
        <div className="secret-confirm-actions"><button type="button" className="secret-secondary-button" onClick={() => setPendingDelete(null)} disabled={deleteSecret.isPending} data-testid="button-cancel-delete-secret">Keep secret</button><button type="button" className="secret-danger-button" onClick={() => deleteSecret.mutate({ secretId: pendingDelete.id })} disabled={deleteSecret.isPending} data-testid="button-confirm-delete-secret">{deleteSecret.isPending ? <LoaderCircle className="spin" size={14} /> : <Trash2 size={14} />} {deleteSecret.isPending ? 'Deleting' : 'Delete permanently'}</button></div>
      </div>
    </div>}
  </section>;
}

function DetailSection({ title, icon, children }: { title: string; icon: ReactNode; children: ReactNode }) {
  return <section className="module-detail-section"><h2>{icon}{title}</h2><div>{children}</div></section>;
}

function ValueList({ items, empty }: { items: string[]; empty: string }) {
  return items.length ? <ul className="control-value-list">{items.map((item, index) => <li key={`${item}-${index}`}><span className="value-mark" />{item}</li>)}</ul> : <EmptyValue text={empty} />;
}

function EmptyValue({ text }: { text: string }) {
  return <p className="control-empty-value"><CircleOff size={13} />{text}</p>;
}

function QuickField({ label, value }: { label: string; value: string }) {
  return <div className="module-quick-field"><span>{label}</span><strong title={value}>{value}</strong></div>;
}

function Metric({ value, label, tone }: { value: number; label: string; tone?: 'positive' | 'restricted' }) {
  return <div className={`control-metric ${tone ?? ''}`}><strong>{value}</strong><span>{label}</span></div>;
}

function StatusBadge({ module }: { module: ControlCenterModule }) {
  const disabled = isDisabled(module);
  return <span className={`control-status-badge ${disabled ? 'restricted' : module.status}`}><span />{module.classification}</span>;
}

function ActivityRow({ item }: { item: { label: string; detail: string; timestamp: string; tone: string } }) {
  return <div className={`control-activity-row ${item.tone}`}><span className="activity-row-mark">{item.tone === 'positive' ? <CheckCircle2 size={14} /> : item.tone === 'danger' ? <AlertTriangle size={14} /> : <Clock3 size={14} />}</span><div><strong>{item.label}</strong><small>{item.detail}</small></div><time>{formatTimestamp(item.timestamp)}</time></div>;
}

function formatTimestamp(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function ControlCenterSkeleton() {
  return <div className="control-center-skeleton" aria-label="Loading Control Center"><span /><span /><span /><span /><span /><span /></div>;
}