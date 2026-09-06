import { type FormEvent, type KeyboardEvent, useEffect, useMemo, useRef, useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createChangeProposal, createAgentSession, type AiModel, type AgentSession, type ChangeExecutionResult, type ChangeProposal, type CommitResult, type PushResult, useListAiModels } from '@workspace/api-client-react';
import { ErrorBoundary } from '@/components/error-boundary';
import { reportBrowserError } from '@/components/browser-error-overlay';
import { RepositoryPanel, type RepositoryRef } from '@/components/repository-panel';
import { ResourceStatusPanel } from '@/components/resource-status-panel';
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';
import NotFound from '@/pages/not-found';
import { ChangeProposalReview } from '@/components/change-proposal-review';
import { PreviewPanel } from '@/components/preview-panel';
import { ControlCenter } from '@/components/control-center';
import FileExplorerPage from '@/pages/file-explorer';
import { acceptRufloLiveEvent, parseRufloSseBlock } from './ruflo-live-client';
import {
  Aperture, Bot, Check, ChevronDown, CircleAlert, CircleCheck, Code2, Copy, Gauge, LockKeyhole, Menu, MoreHorizontal,
  FileCode2,
  Activity, Eye, GitBranch, Pencil, Plus, RefreshCw, Search, Send, ShieldCheck, Sparkles, Terminal, Trash2, Wrench, X, Square,
  ArrowLeft, Github, KeyRound, LoaderCircle, LogIn, LogOut, Settings as SettingsIcon,
} from 'lucide-react';
import { Link, Route, Switch, useLocation, useParams, Router as WouterRouter } from 'wouter';

const queryClient = new QueryClient();
type Role = 'user' | 'assistant';
type UsedSource = { path: string; startLine?: number; endLine?: number };
type ContextUsage = { paths: string[]; sources: UsedSource[]; warnings?: string[]; approximateChars?: number; chunked?: boolean };
type ChatMessage = { id: string; role: Role; content: string; createdAt: number; error?: boolean; streaming?: boolean; repositoryContext?: ContextUsage };
type Conversation = { id: string; title: string; modelId: string; messages: ChatMessage[]; updatedAt: number };
type RuntimeRole = 'frontend' | 'backend' | 'reviewer' | 'validator' | 'manager';
type RuntimeSession = AgentSession & {
  proposalData?: ChangeProposal;
  orchestration: {
    selectedWorkers: RuntimeRole[];
    completedSubtasks: string[];
    reviewStatus: 'pending' | 'completed' | 'blocked' | 'failed';
  };
  workerState: { completedToolIds: Record<string, string[]> };
};
type ComposerMode = 'chat' | 'agent' | 'ruflo';
type RufloActivity = {
  id: string;
  label: 'Planning' | 'Inspecting Project' | 'Searching Files' | 'Reading Files' | 'Delegating' | 'Coding' | 'Reviewing' | 'Validating' | 'Fixing' | 'Waiting for Approval' | 'Applying' | 'GitHub' | 'Completed';
  status: 'active' | 'complete' | 'failed';
  timestamp: string;
};
type RufloClientSession = {
  id: string;
  mode: 'ruflo';
  task: string;
  status: 'running' | 'waiting' | 'completed' | 'failed';
  phase: 'inspecting' | 'reviewing' | 'validating' | 'fixing' | 'waiting_approval' | 'completed' | 'failed';
  currentLabel: RufloActivity['label'];
  currentAgent: 'Ruflo Manager' | 'Planner' | 'Coder' | 'Reviewer' | 'Validator' | 'Fixer' | 'Human approval';
  activity: RufloActivity[];
  plan: string[];
  affectedFiles: string[];
  proposalStatus: 'not-created' | 'ready' | 'applied' | 'completed';
  validationStatus: 'not-run' | 'pass' | 'fail' | 'not-verified';
  git: { status: 'not-available' | 'not-requested' | 'ready' | 'committed' | 'pushed' | 'unavailable'; branch?: string };
  memoryFactCount: number;
  proposal?: ChangeProposal;
  error?: { code: string; message: string };
  recoveryAttempts: number;
  maxRecoveryAttempts: number;
  validation?: { status: 'pass' | 'fail' | 'not-verified'; summary: string };
  workflowMessage?: string;
  createdAt: string;
  updatedAt: string;
  capability: string;
  routing: {
    primary: { provider: string; model: string };
    fallbacks: { provider: string; model: string }[];
    reason: string;
  };
  usage: {
    requests: number;
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    costStatus: string;
    estimatedCostUsd?: number;
    providerModels: { provider: string; model: string; requests: number; inputTokens: number; outputTokens: number; totalTokens: number; estimatedCostUsd?: number; costStatus: string }[];
  };
  tasks: {
    id: string;
    title: string;
    status: 'pending' | 'active' | 'complete' | 'failed' | 'blocked';
    dependencies: string[];
    wave: number;
    retryCount: number;
  }[];
  agents: {
    id: string;
    role: string;
    status: 'idle' | 'active' | 'complete' | 'failed';
    executionId?: string;
    attempts?: number;
  }[];
  executionWaves: {
    id: string;
    label: string;
    taskIds: string[];
    status: string;
  }[];
  memory: { factCount: number; bounded: boolean; status: string };
};
type RufloConnectionState = 'connecting' | 'live' | 'reconnecting' | 'closed' | 'unauthorized';
type SessionUser = { id: string; email: string };
type GitHubStatus = { connected: boolean; status: 'connected' | 'invalid' | 'rate_limited' | 'unavailable' | 'not_connected'; lastValidatedAt?: string | null };

const fallbackModels: AiModel[] = [
  { id: 'openai/gpt-oss-120b', displayName: 'GPT OSS 120B', provider: 'groq', capabilities: ['coding', 'reasoning'], contextWindow: 131072, enabled: true, recommended: true },
  { id: 'openai/gpt-oss-20b', displayName: 'GPT OSS 20B', provider: 'groq', capabilities: ['coding', 'reasoning', 'fast'], contextWindow: 131072, enabled: true, recommended: false },
  { id: 'gemini-3.5-flash', displayName: 'Gemini 3.5 Flash', provider: 'gemini', capabilities: ['coding', 'reasoning', 'fast'], contextWindow: 1048576, enabled: true, recommended: true },
];
const promptSuggestions = [
  ['Explain this code', 'Walk me through a piece of code and highlight the most important decisions.'],
  ['Help me build a React component', 'Help me build a polished, accessible React component from scratch.'],
  ['Debug this error', 'Help me understand this error and create a focused fix.'],
  ['Design an architecture', 'Help me compare architecture options for a new software project.'],
];
const starterConversation = (): Conversation => ({ id: `conversation-${Date.now()}`, title: 'New conversation', modelId: fallbackModels[0].id, messages: [], updatedAt: Date.now() });

function titleFromMessage(text: string) {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length > 42 ? `${clean.slice(0, 42)}…` : clean || 'New conversation';
}
function readConversations(): Conversation[] {
  try { return JSON.parse(localStorage.getItem('cosmic-conversations') ?? '[]') as Conversation[]; } catch { return []; }
}
function copyText(text: string) {
  void navigator.clipboard?.writeText(text);
}

function Markdown({ content }: { content: string }) {
  const blocks = content.split(/(```[\s\S]*?```)/g).filter(Boolean);
  return <div className="markdown-content">{blocks.map((block, index) => {
    if (block.startsWith('```')) {
      const lines = block.replace(/^```/, '').replace(/```$/, '').replace(/^\n/, '').split('\n');
      const language = lines[0] && !lines[0].includes(' ') ? lines.shift() : '';
      const code = lines.join('\n');
      return <div className="code-block" key={index}><div className="code-head"><span><Code2 size={13} />{language || 'code'}</span><button onClick={() => copyText(code)} aria-label="Copy code"><Copy size={13} /> Copy</button></div><pre><code>{code}</code></pre></div>;
    }
    return <MarkdownText key={index} text={block} />;
  })}</div>;
}
function MarkdownText({ text }: { text: string }) {
  return <>{text.split('\n').map((line, i) => {
    const trimmed = line.trim();
    if (!trimmed) return <div className="md-space" key={i} />;
    if (trimmed.startsWith('### ')) return <h4 key={i}>{inlineMarkdown(trimmed.slice(4))}</h4>;
    if (trimmed.startsWith('## ')) return <h3 key={i}>{inlineMarkdown(trimmed.slice(3))}</h3>;
    if (trimmed.startsWith('# ')) return <h2 key={i}>{inlineMarkdown(trimmed.slice(2))}</h2>;
    if (/^[-*] /.test(trimmed)) return <li key={i}>{inlineMarkdown(trimmed.slice(2))}</li>;
    if (/^\d+\. /.test(trimmed)) return <li key={i}>{inlineMarkdown(trimmed.replace(/^\d+\. /, ''))}</li>;
    return <p key={i}>{inlineMarkdown(line)}</p>;
  })}</>;
}
function inlineMarkdown(text: string) {
  const pieces = text.split(/(`[^`]+`|\*\*[^*]+\*\*)/g);
  return pieces.map((part, i) => part.startsWith('`') ? <code key={i}>{part.slice(1, -1)}</code> : part.startsWith('**') ? <strong key={i}>{part.slice(2, -2)}</strong> : part);
}

class ApiHttpError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = 'HttpError';
  }
}

async function apiJson<T>(url: string, options?: RequestInit): Promise<T> {
  const method = options?.method ?? 'GET';
  const requestBody = typeof options?.body === 'string' ? options.body : options?.body === undefined ? undefined : String(options.body);
  let response: Response;
  try {
    response = await fetch(url, { credentials: 'include', ...options });
  } catch (error) {
    reportBrowserError(error, { source: 'apiJson fetch', http: { method, url, requestBody } });
    throw error;
  }
  const responseBody = await response.text();
  let body: { error?: string } | T | null = null;
  try {
    body = responseBody ? JSON.parse(responseBody) as { error?: string } | T : null;
  } catch {
    body = null;
  }
  if (!response.ok) {
    const error = new ApiHttpError(body && typeof body === 'object' && 'error' in body && typeof body.error === 'string' ? body.error : responseBody || 'Request failed.', response.status);
    if (!(url === '/api/auth/me' && response.status === 401)) {
      reportBrowserError(error, {
        source: 'apiJson HTTP response',
        http: {
          method,
          url,
          requestBody,
          status: response.status,
          statusText: response.statusText,
          responseHeaders: [...response.headers.entries()].map(([key, value]) => `${key}: ${value}`).join('\n'),
          responseBody,
        },
      });
    }
    throw error;
  }
  return body as T;
}

function AuthScreen({ onAuthenticated }: { onAuthenticated: (user: SessionUser) => void }) {
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (event: FormEvent) => {
    event.preventDefault(); setError(''); setBusy(true);
    try {
      const result = await apiJson<{ user: SessionUser }>(`/api/auth/${mode}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) });
      onAuthenticated(result.user);
      } catch (cause) { setError(friendlyAuthError(cause)); }
    finally { setBusy(false); }
  };
  return <main className="auth-shell"><section className="auth-card">
    <div className="auth-brand"><div className="brand-mark"><Aperture size={17} /></div><span>Cosmic Agent</span></div>
    <div className="auth-heading"><span className="repo-kicker"><LogIn size={12} /> Private workspace</span><h1>{mode === 'login' ? 'Welcome back' : 'Create your workspace'}</h1><p>{mode === 'login' ? 'Sign in to continue your private, reviewable coding sessions.' : 'Create an account to keep your sessions and integrations private.'}</p></div>
     <form className="auth-form" onSubmit={submit}><label>Email<input type="email" value={email} onChange={(event) => setEmail(event.target.value)} autoComplete="email" required /></label><label>Password<input type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete={mode === 'login' ? 'current-password' : 'new-password'} minLength={8} required /></label>{error && <div className="auth-error" role="alert" aria-live="polite">{error}</div>}<button className="auth-submit" disabled={busy} aria-busy={busy}>{busy ? <LoaderCircle className="spin" size={15} /> : <LogIn size={15} />}{mode === 'login' ? 'Sign in' : 'Register'}</button></form>
    <button className="auth-switch" onClick={() => { setMode(mode === 'login' ? 'register' : 'login'); setError(''); }}>{mode === 'login' ? 'Need an account? Register' : 'Already have an account? Sign in'}</button>
  </section></main>;
}

function ComposerModePicker({ mode, open, onToggle, onChange }: { mode: ComposerMode; open: boolean; onToggle: () => void; onChange: (mode: ComposerMode) => void }) {
  const label = mode === 'ruflo' ? 'Ruflo Mode' : mode === 'agent' ? 'Normal Agent' : 'Chat';
  const options: Array<{ value: ComposerMode; label: string; description: string }> = [
    { value: 'chat', label: 'Chat', description: 'Conversation and technical reasoning' },
    { value: 'agent', label: 'Normal Agent', description: 'Approval-gated repository changes' },
    { value: 'ruflo', label: 'Ruflo Mode', description: 'Bounded inspection, approval-gated changes' },
  ];
  return <div className="composer-mode-picker">
    <button type="button" className="composer-plus" onClick={onToggle} aria-label="Choose agent mode" aria-haspopup="listbox" aria-expanded={open}><Plus size={15} /></button>
    <button type="button" className={`mode-trigger ${mode}`} onClick={onToggle} aria-haspopup="listbox" aria-expanded={open}><span>{label}</span><ChevronDown size={13} /></button>
    {open && <div className="composer-mode-menu" role="listbox" aria-label="Agent mode">{options.map((option) => <button type="button" role="option" aria-selected={mode === option.value} className={mode === option.value ? 'selected' : ''} key={option.value} onClick={() => onChange(option.value)}><span><strong>{option.label}</strong><small>{option.description}</small></span>{mode === option.value && <Check size={14} />}</button>)}</div>}
  </div>;
}

function GitHubSettings({ onClose, onBack, notify, embedded = false }: { onClose: () => void; onBack?: () => void; notify: (message: string) => void; embedded?: boolean }) {
  const [status, setStatus] = useState<GitHubStatus | null>(null);
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const refresh = async () => { try { setStatus(await apiJson<GitHubStatus>('/api/settings/github')); } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not load GitHub status.'); } };
  useEffect(() => { void refresh(); }, []);
  const save = async (event: FormEvent) => {
    event.preventDefault(); setBusy(true); setError('');
    try { const next = await apiJson<GitHubStatus>('/api/settings/github', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }) }); setStatus(next); setToken(''); notify('GitHub connected securely.'); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not save GitHub token.'); }
    finally { setBusy(false); }
  };
  const validate = async () => { setBusy(true); setError(''); try { const next = await apiJson<GitHubStatus>('/api/settings/github/validate', { method: 'POST' }); setStatus(next); notify(next.status === 'connected' ? 'GitHub token is valid.' : `GitHub status: ${next.status.replace('_', ' ')}`); } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not validate GitHub token.'); } finally { setBusy(false); } };
  const remove = async () => { setBusy(true); setError(''); try { setStatus(await apiJson<GitHubStatus>('/api/settings/github', { method: 'DELETE' })); notify('GitHub disconnected.'); } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not remove GitHub token.'); } finally { setBusy(false); } };
  const label = status?.status === 'not_connected' || !status ? 'Not Connected' : status.status === 'rate_limited' ? 'Rate Limited' : status.status === 'invalid' ? 'Invalid' : status.status === 'unavailable' ? 'Unavailable' : 'Connected';
  return <aside className={`settings-panel ${embedded ? 'control-center-embedded-settings' : ''}`}><div className="settings-head"><div><span className="repo-kicker"><SettingsIcon size={12} /> {embedded ? 'Control Center / Integrations' : 'Settings'}</span><strong>Integrations</strong></div><div className="settings-head-actions">{onBack && <button className="icon-button" onClick={onBack} aria-label="Back to integrations overview"><ArrowLeft size={16} /></button>}<button className="icon-button" onClick={onClose} aria-label="Close settings"><X size={17} /></button></div></div><div className="settings-content"><div className="integration-title"><Github size={22} /><div><strong>GitHub</strong><small>Repository access for private projects</small></div><span className={`integration-status ${status?.status ?? 'not_connected'}`}>{label}</span></div><form className="github-form" onSubmit={save}><label>GitHub Personal Access Token<input type="password" value={token} onChange={(event) => setToken(event.target.value)} placeholder="ghp_••••••••••••" autoComplete="off" required /></label><small className="settings-note"><KeyRound size={13} /> Encrypted on the server. It never appears in responses, logs, or agent context.</small><div className="settings-actions"><button className="settings-primary" disabled={busy || !token.trim()}>{busy ? <LoaderCircle className="spin" size={14} /> : null}Save</button>{status?.status !== 'not_connected' && <><button type="button" className="settings-button" onClick={() => void validate()} disabled={busy}>Validate</button><button type="button" className="settings-danger" onClick={() => void remove()} disabled={busy}>Remove</button></>}</div></form>{error && <div className="auth-error" role="alert">{error}</div>}</div></aside>;
}

function Home({ user, onLogout }: { user: SessionUser; onLogout: () => void }) {
  const [, setLocation] = useLocation();
  const { data: providerModels } = useListAiModels();
  const models = providerModels?.filter((model) => model.enabled) ?? fallbackModels;
  const [conversations, setConversations] = useState<Conversation[]>(readConversations);
  const [activeId, setActiveId] = useState(() => readConversations()[0]?.id ?? '');
  const [selectedModelId, setSelectedModelId] = useState(fallbackModels[0].id);
  const [draft, setDraft] = useState('');
  const [isStreaming, setIsStreaming] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [toast, setToast] = useState('');
  const [modelOpen, setModelOpen] = useState(false);
  const [composerMode, setComposerMode] = useState<ComposerMode>('chat');
  const [composerMenuOpen, setComposerMenuOpen] = useState(false);
  const [proposal, setProposal] = useState<ChangeProposal | null>(null);
  const [proposalRequest, setProposalRequest] = useState('');
  const [isProposing, setIsProposing] = useState(false);
  const [agentSession, setAgentSession] = useState<RuntimeSession | null>(null);
  const [rufloSession, setRufloSession] = useState<RufloClientSession | null>(null);
  const [rufloProposal, setRufloProposal] = useState<ChangeProposal | null>(null);
  const [isStartingRuflo, setIsStartingRuflo] = useState(false);
  const [editingId, setEditingId] = useState('');
  const [repository, setRepository] = useState<RepositoryRef | null>(() => {
    try { return JSON.parse(localStorage.getItem('cosmic-repository') ?? 'null') as RepositoryRef | null; } catch { return null; }
  });
  const [contextPaths, setContextPaths] = useState<string[]>([]);
  const [repositoryOpen, setRepositoryOpen] = useState(false);
  const [resourceOpen, setResourceOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [previewProposalId, setPreviewProposalId] = useState(() => localStorage.getItem('cosmic-preview-proposal-id') ?? '');
  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  const active = conversations.find((conversation) => conversation.id === activeId) ?? null;
  const selectedModel = models.find((model) => model.id === selectedModelId) ?? models[0] ?? fallbackModels[0];

   useEffect(() => {
     if (!agentSession?.id) return;
     let activePoll = true;
     const poll = async () => {
       try {
          const local = agentSession.id.startsWith('local-');
          const proposalId = local ? agentSession.id.slice('local-'.length) : '';
          const endpoint = local
            ? `/api/workspace/default/activity/${encodeURIComponent(proposalId)}`
            : `/api/ai/agent/sessions/${encodeURIComponent(agentSession.id)}`;
          const latest = await apiJson<RuntimeSession>(endpoint);
         if (activePoll) setAgentSession(latest);
       } catch {
         // The existing session remains visible if a transient poll fails.
       }
     };
     const timer = window.setInterval(() => void poll(), 700);
     return () => { activePoll = false; window.clearInterval(timer); };
   }, [agentSession?.id]);

   const [rufloConnection, setRufloConnection] = useState<RufloConnectionState>('closed');
   useEffect(() => {
     const sessionId = rufloSession?.id;
     if (!sessionId) {
       setRufloConnection('closed');
       return;
     }
     let cancelled = false;
     let attempt = 0;
     let lastEventId = '';
     let reconnectTimer: number | undefined;
     let controller: AbortController | undefined;
     let terminal = false;
     const refreshSession = async () => {
       try {
         const latest = await apiJson<RufloClientSession>(`/api/ruflo/sessions/${encodeURIComponent(sessionId)}`);
         if (!cancelled) {
           setRufloSession((current) => current?.id === sessionId ? { ...current, ...latest } : latest);
           if (latest.proposal) setRufloProposal(latest.proposal);
         }
       } catch {
         // The last server snapshot remains visible until the stream recovers.
       }
     };
     const applyEvent = (event: { id?: string; type?: string; payload?: { session?: Partial<RufloClientSession> } }) => {
       const snapshot = event.payload?.session;
       if (snapshot && !cancelled) {
         setRufloSession((current) => current?.id === sessionId ? { ...current, ...snapshot, proposal: snapshot.proposal ?? current.proposal } as RufloClientSession : current);
       }
       if (event.type === 'proposal_created' || event.type === 'approval_requested') void refreshSession();
       if (event.type === 'session_completed' || event.type === 'session_failed') {
         terminal = true;
         controller?.abort();
         setRufloConnection('closed');
       }
     };
     const parseBlock = (block: string) => {
       const event = parseRufloSseBlock(block);
       if (!event || !acceptRufloLiveEvent(lastEventId, event.id)) return;
       if (event.id) lastEventId = event.id;
       applyEvent(event);
     };
     const connect = async () => {
       if (cancelled) return;
       setRufloConnection(attempt ? 'reconnecting' : 'connecting');
       controller = new AbortController();
       try {
         const response = await fetch(`/api/ruflo/sessions/${encodeURIComponent(sessionId)}/events`, {
           credentials: 'include',
           headers: lastEventId ? { 'Last-Event-ID': lastEventId } : undefined,
           signal: controller.signal,
         });
         if (response.status === 401 || response.status === 403 || response.status === 404) {
           setRufloConnection('unauthorized');
           return;
         }
         if (!response.ok || !response.body) throw new Error('The Ruflo live stream is unavailable.');
         attempt = 0;
         setRufloConnection('live');
         const reader = response.body.getReader();
         const decoder = new TextDecoder();
         let buffer = '';
         while (!cancelled) {
           const chunk = await reader.read();
           if (chunk.done) break;
           buffer += decoder.decode(chunk.value, { stream: true });
           const blocks = buffer.split(/\r?\n\r?\n/);
           buffer = blocks.pop() ?? '';
           blocks.forEach(parseBlock);
         }
         if (buffer.trim()) parseBlock(buffer);
       } catch (error) {
         if (cancelled || (error instanceof DOMException && error.name === 'AbortError')) return;
          reportBrowserError(error, {
            source: 'Ruflo SSE connection',
            http: {
              method: 'GET',
              url: `/api/ruflo/sessions/${encodeURIComponent(sessionId)}/events`,
            },
          });
       }
       if (!cancelled && !terminal) {
         const delay = Math.min(10_000, 1_000 * (2 ** Math.min(attempt, 3)));
         attempt += 1;
         reconnectTimer = window.setTimeout(() => void connect(), delay);
       }
     };
     void connect();
     return () => {
       cancelled = true;
       controller?.abort();
       if (reconnectTimer) window.clearTimeout(reconnectTimer);
     };
   }, [rufloSession?.id]);

  useEffect(() => { localStorage.setItem('cosmic-conversations', JSON.stringify(conversations)); }, [conversations]);
  useEffect(() => { if (repository) localStorage.setItem('cosmic-repository', JSON.stringify(repository)); else localStorage.removeItem('cosmic-repository'); }, [repository]);
  useEffect(() => { if (previewProposalId) localStorage.setItem('cosmic-preview-proposal-id', previewProposalId); else localStorage.removeItem('cosmic-preview-proposal-id'); }, [previewProposalId]);
  useEffect(() => {
    if (!active) return;
    setSelectedModelId(active.modelId);
    requestAnimationFrame(() => { if (stickToBottom.current && scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight; });
  }, [activeId]);
  const filteredConversations = useMemo(() => conversations.filter((item) => item.title.toLowerCase().includes(search.toLowerCase())), [conversations, search]);
  const notify = (message: string) => { setToast(message); window.setTimeout(() => setToast(''), 2600); };
  const updateActive = (fn: (conversation: Conversation) => Conversation) => setConversations((current) => current.map((item) => item.id === activeId ? fn(item) : item));
  const recordAppliedEvent = (result: ChangeExecutionResult) => {
    updateActive((item) => ({
      ...item,
      updatedAt: Date.now(),
      messages: [...item.messages, {
        id: `execution-${Date.now()}`,
        role: 'assistant',
        content: `Applied approved changes to ${result.files.length} ${result.files.length === 1 ? 'file' : 'files'}.\n\nChanges applied locally. Nothing has been committed or pushed.`,
        createdAt: Date.now(),
      }],
    }));
  };
  const recordCommittedEvent = (result: CommitResult) => {
    updateActive((item) => ({
      ...item,
      updatedAt: Date.now(),
      messages: [...item.messages, { id: `commit-${Date.now()}`, role: 'assistant', content: `Committed approved changes to ${result.repository.owner}/${result.repository.name}.`, createdAt: Date.now() }],
    }));
  };
  const recordPushedEvent = (result: PushResult) => {
    updateActive((item) => ({
      ...item,
      updatedAt: Date.now(),
      messages: [...item.messages, { id: `push-${Date.now()}`, role: 'assistant', content: `Pushed commit "${result.shortSha}" to "${result.branch}".`, createdAt: Date.now() }],
    }));
  };
  const newChat = () => {
    const next = starterConversation();
    setConversations((current) => [next, ...current]); setActiveId(next.id); setSelectedModelId(next.modelId); setDraft(''); setSidebarOpen(false);
  };
  const selectConversation = (id: string) => { setActiveId(id); setSidebarOpen(false); };
  const rename = (conversation: Conversation) => {
    const next = window.prompt('Rename conversation', conversation.title);
    if (next?.trim()) setConversations((current) => current.map((item) => item.id === conversation.id ? { ...item, title: next.trim() } : item));
  };
  const deleteConversation = (id: string) => {
    setConversations((current) => { const next = current.filter((item) => item.id !== id); if (id === activeId) { setActiveId(next[0]?.id ?? ''); if (!next.length) setSelectedModelId(fallbackModels[0].id); } return next; });
  };
  const changeModel = (modelId: string) => {
    setSelectedModelId(modelId);
    if (active) updateActive((item) => ({ ...item, modelId }));
    setModelOpen(false);
  };
  const selectComposerMode = (nextMode: ComposerMode) => {
    setComposerMode(nextMode);
    setComposerMenuOpen(false);
    if (nextMode !== 'ruflo') setRufloSession(null);
    if (nextMode !== 'ruflo') setRufloProposal(null);
  };
  const modeLabel = composerMode === 'ruflo' ? 'Ruflo Mode' : composerMode === 'agent' ? 'Normal Agent' : 'Chat';
  const modeDescription = composerMode === 'ruflo'
    ? 'Bounded inspection · proposal boundary only'
    : composerMode === 'agent'
      ? 'Approval-gated repository changes'
      : 'Conversation and technical reasoning';
  const handleSend = async (event?: FormEvent) => {
    event?.preventDefault();
    const text = draft.trim();
    if (!text || isStreaming || isProposing || isStartingRuflo || !selectedModel) return;
    if (composerMode === 'ruflo') {
      setDraft('');
      setRufloProposal(null);
      setIsStartingRuflo(true);
      try {
        const next = await apiJson<RufloClientSession>('/api/ruflo/sessions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            task: text,
            model: selectedModel.id,
            repository: repository ?? undefined,
            projectId: 'default',
            selectedFiles: contextPaths,
          }),
        });
        setRufloSession(next);
      } catch (error) {
        notify(error instanceof Error ? error.message : 'Could not start Ruflo Mode.');
      } finally {
        setIsStartingRuflo(false);
      }
      return;
    }
    const useNormalAgent = composerMode === 'agent' || isCodingRequest(text);
    if (repository && useNormalAgent) {
      setProposalRequest(text);
      setDraft('');
      setIsProposing(true);
       try {
         const nextSession = await createAgentSession({ model: selectedModel.id, task: text, repository, paths: contextPaths }) as RuntimeSession;
         setAgentSession(nextSession);
         if (nextSession.proposalData) setProposal(nextSession.proposalData);
      } catch (error) {
        notify(error instanceof Error ? error.message : 'Could not generate a change proposal.');
      } finally {
        setIsProposing(false);
      }
      return;
    }
     if (!repository && useNormalAgent) {
      setProposalRequest(text);
      setDraft('');
      setIsProposing(true);
      try {
         const result = await apiJson<{ proposal: ChangeProposal; session: RuntimeSession }>(
          '/api/workspace/default/proposal',
           { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ request: text, model: selectedModel.id, paths: contextPaths }) },
        );
        setProposal(result.proposal);
        setAgentSession(result.session);
      } catch (error) {
        notify(error instanceof Error ? error.message : 'Could not create the local workspace proposal.');
      } finally {
        setIsProposing(false);
      }
      return;
    }
    let conversation = active;
    if (!conversation) { conversation = starterConversation(); conversation.modelId = selectedModel.id; setConversations((current) => [conversation!, ...current]); setActiveId(conversation.id); }
    const userMessage: ChatMessage = { id: `user-${Date.now()}`, role: 'user', content: text, createdAt: Date.now() };
    const assistantId = `assistant-${Date.now()}`;
    const assistantMessage: ChatMessage = { id: assistantId, role: 'assistant', content: '', createdAt: Date.now(), streaming: true };
    const conversationId = conversation.id;
    setConversations((current) => current.map((item) => item.id === conversationId ? { ...item, title: item.title === 'New conversation' ? titleFromMessage(text) : item.title, modelId: selectedModel.id, messages: [...item.messages, userMessage, assistantMessage], updatedAt: Date.now() } : item));
    setDraft(''); setIsStreaming(true); stickToBottom.current = true;
    const controller = new AbortController(); abortRef.current = controller;
    try {
      const response = await fetch('/api/ai/chat/stream', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: selectedModel.id, messages: [...conversation.messages, userMessage].map((message) => ({ role: message.role, content: message.content })), repositoryContext: repository ? { repository, paths: contextPaths } : undefined }), signal: controller.signal });
      if (!response.ok || !response.body) { const body = await response.json().catch(() => null) as { error?: string } | null; throw new Error(body?.error ?? 'The provider is unavailable right now.'); }
      const reader = response.body.getReader(); const decoder = new TextDecoder(); let buffer = '';
      while (true) {
        const chunk = await reader.read(); if (chunk.done) break;
        buffer += decoder.decode(chunk.value, { stream: true });
        const events = buffer.split('\n\n'); buffer = events.pop() ?? '';
        for (const event of events) {
          const line = event.split('\n').find((entry) => entry.startsWith('data: ')); if (!line) continue;
          const data = line.slice(6); if (data === '[DONE]') continue;
           const parsed = JSON.parse(data) as { token?: string; error?: string; repositoryContext?: ContextUsage; repositoryContextUsed?: ContextUsage }; if (parsed.error) throw new Error(parsed.error);
           const usage = parsed.repositoryContext ?? parsed.repositoryContextUsed;
           if (usage) setConversations((current) => current.map((item) => item.id === conversationId ? { ...item, messages: item.messages.map((message) => message.id === assistantId ? { ...message, repositoryContext: usage } : message) } : item));
          if (parsed.token) setConversations((current) => current.map((item) => item.id === conversationId ? { ...item, messages: item.messages.map((message) => message.id === assistantId ? { ...message, content: message.content + parsed.token } : message) } : item));
          if (stickToBottom.current && scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
        }
      }
      setConversations((current) => current.map((item) => item.id === conversationId ? { ...item, messages: item.messages.map((message) => message.id === assistantId ? { ...message, streaming: false, content: message.content || 'The provider returned an empty response.' } : message) } : item));
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') notify('Generation stopped');
      else {
        const message = error instanceof Error ? error.message : 'The network connection failed.';
        setConversations((current) => current.map((item) => item.id === conversationId ? { ...item, messages: item.messages.map((entry) => entry.id === assistantId ? { ...entry, content: friendlyError(message), error: true, streaming: false } : entry) } : item));
      }
    } finally { setIsStreaming(false); abortRef.current = null; }
  };
  const retry = (message: ChatMessage) => {
    const previous = active?.messages[active.messages.findIndex((item) => item.id === message.id) - 1];
    if (previous?.role === 'user') { setDraft(previous.content); window.setTimeout(() => void handleSend(), 0); }
  };
  const onComposerKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void handleSend(); } };
  const onScroll = () => { if (!scrollRef.current) return; const distance = scrollRef.current.scrollHeight - scrollRef.current.scrollTop - scrollRef.current.clientHeight; stickToBottom.current = distance < 120; };

  return <div className="chat-app">
    <aside className={`conversation-sidebar ${sidebarOpen ? 'is-open' : ''}`}>
      <div className="sidebar-brand"><div className="brand-mark"><Aperture size={16} /></div><span>Cosmic Agent</span><button className="icon-button mobile-close" onClick={() => setSidebarOpen(false)} aria-label="Close conversation history"><X size={17} /></button></div>
      <button className="new-chat-button" onClick={newChat}><Plus size={17} /> New chat <span>⌘ K</span></button>
      <label className="conversation-search"><Search size={15} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search conversations" aria-label="Search conversations" /></label>
      <div className="history-label">Recent conversations</div>
      <div className="history-list">{filteredConversations.length ? filteredConversations.map((conversation) => <div className={`history-item ${conversation.id === activeId ? 'active' : ''}`} key={conversation.id}>
        {editingId === conversation.id ? <input autoFocus defaultValue={conversation.title} onBlur={(event) => { const value = event.target.value.trim(); if (value) setConversations((current) => current.map((item) => item.id === conversation.id ? { ...item, title: value } : item)); setEditingId(''); }} onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur(); }} /> : <button className="history-main" onClick={() => selectConversation(conversation.id)}><span>{conversation.title}</span><small>{conversation.messages.length ? `${conversation.messages.length} messages` : 'Empty chat'}</small></button>}
        <div className="history-actions"><button onClick={() => { setEditingId(conversation.id); }} aria-label={`Rename ${conversation.title}`}><Pencil size={13} /></button><button onClick={() => deleteConversation(conversation.id)} aria-label={`Delete ${conversation.title}`}><Trash2 size={13} /></button></div>
      </div>) : <div className="history-empty">{search ? 'No matching chats' : 'Your conversations will appear here.'}</div>}</div>
       <div className="sidebar-bottom"><button className="clear-history" onClick={() => { if (window.confirm('Clear all conversation history?')) { setConversations([]); setActiveId(''); notify('Conversation history cleared'); } }}><Trash2 size={15} /> Clear history</button><div className="sidebar-account"><div className="account-avatar">{user.email.slice(0, 2).toUpperCase()}</div><div><strong>{user.email}</strong><small>Private workspace</small></div><button className="account-menu-button" onClick={() => setSettingsOpen(true)} aria-label="Open settings"><SettingsIcon size={15} /></button><button className="account-menu-button" onClick={() => void apiJson('/api/auth/logout', { method: 'POST' }).then(onLogout)} aria-label="Sign out"><LogOut size={15} /></button></div></div>
    </aside>
    {sidebarOpen && <button className="drawer-overlay" onClick={() => setSidebarOpen(false)} aria-label="Close sidebar" />}
     <main className="chat-main">
         <header className="chat-header"><div className="header-title"><button className="icon-button menu-button" onClick={() => setSidebarOpen(true)} aria-label="Open conversation history"><Menu size={19} /></button><div><strong>{active?.title ?? 'New conversation'}</strong><span>Private workspace · read-only mode</span></div></div><div className="header-actions">{repository && <button className="context-indicator" onClick={() => setRepositoryOpen(true)}><span className="status-dot" /> {repository.owner}/{repository.name}{contextPaths.length ? ` · ${contextPaths.length} files` : ''}</button>}{previewProposalId && <Link className="preview-toggle" href={`/preview/${encodeURIComponent(previewProposalId)}`}><Eye size={14} /> Preview</Link>}<button className="resource-toggle" onClick={() => setResourceOpen((open) => !open)} aria-label="Toggle resource status"><Activity size={15} /> Resources</button><button className="repo-toggle" onClick={() => setRepositoryOpen((open) => !open)} aria-label="Toggle repository explorer"><GitBranch size={15} /> Repository</button><div className="header-status"><span className="status-dot" /> Ready</div></div></header>
       <div className="message-scroll" ref={scrollRef} onScroll={onScroll}>
              <div className="message-column">{!active?.messages.length && !proposal && !rufloProposal && !isProposing && !isStartingRuflo && !agentSession && !rufloSession ? <EmptyState onPrompt={(prompt) => setDraft(prompt)} /> : <>{active?.messages.map((message) => <MessageBubble key={message.id} message={message} onRetry={() => retry(message)} onEdit={(text) => setDraft(text)} />)}{(isProposing || isStartingRuflo) && <div className="proposal-loading"><Sparkles size={16} className="spin" /><span>{isStartingRuflo ? 'Starting Ruflo Mode and preparing bounded inspection…' : 'Inspecting the workspace and preparing a safe diff preview…'}</span></div>}{agentSession && <AgentTimeline session={agentSession} model={selectedModel} />}{rufloSession && <RufloActivityPanel session={rufloSession} connection={rufloConnection} />}{proposal && <ChangeProposalReview proposal={proposal} onCancel={() => { setProposal(null); setAgentSession(null); }} onRegenerate={() => { setProposal(null); setAgentSession(null); setDraft(proposalRequest); }} onApplied={(result) => { recordAppliedEvent(result); setPreviewProposalId(result.proposalId); }} onValidationFailed={(result) => {
              const validation = (result as ChangeExecutionResult & { validation?: { checks?: Array<{ details: string }>; summary?: string } }).validation;
              const details = validation?.checks?.map((check) => check.details).join(' ') || validation?.summary || result.message;
              setProposal(null);
              setAgentSession(null);
              setIsProposing(true);
              void apiJson<{ proposal: ChangeProposal; session: RuntimeSession }>(
                '/api/workspace/default/proposal',
                { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ request: proposalRequest, model: selectedModel.id, paths: contextPaths, previousErrors: [details] }) },
              ).then((next) => { setProposal(next.proposal); setAgentSession(next.session); notify('Validation failed. A new fix proposal is ready for approval.'); }).catch((error) => notify(error instanceof Error ? error.message : 'The fix proposal could not be generated.')).finally(() => setIsProposing(false));
             }} onCommitted={(result) => recordCommittedEvent(result)} onPushed={(result) => recordPushedEvent(result)} />}{rufloProposal && <ChangeProposalReview key={rufloProposal.proposalId} proposal={rufloProposal} executeEndpoint={rufloSession ? `/api/ruflo/sessions/${encodeURIComponent(rufloSession.id)}/execute` : undefined} gitEndpoints={rufloSession ? { commitReview: `/api/ruflo/sessions/${encodeURIComponent(rufloSession.id)}/git/commit-review`, commit: `/api/ruflo/sessions/${encodeURIComponent(rufloSession.id)}/git/commit`, pushReview: `/api/ruflo/sessions/${encodeURIComponent(rufloSession.id)}/git/push-review`, push: `/api/ruflo/sessions/${encodeURIComponent(rufloSession.id)}/git/push` } : undefined} codeApprovalLabel="Approve code changes" onCancel={() => { setRufloProposal(null); setRufloSession(null); }} onRegenerate={() => { const task = rufloSession?.task ?? ''; setRufloProposal(null); setRufloSession(null); if (task) setDraft(task); }} onWorkflowStart={() => setRufloSession((current) => current ? { ...current, status: 'running', phase: 'reviewing', workflowMessage: 'Reviewer is checking the approved change.' } : current)} onWorkflowResult={(result) => { const workflow = result.workflow; setRufloSession((current) => current ? { ...current, status: workflow.phase === 'completed' ? 'completed' : workflow.phase === 'failed' ? 'failed' : 'waiting', phase: workflow.phase, recoveryAttempts: workflow.recoveryAttempts, maxRecoveryAttempts: workflow.maxRecoveryAttempts, validation: workflow.validation, workflowMessage: workflow.message, proposal: workflow.proposal ?? current.proposal, error: workflow.phase === 'failed' ? { code: 'workflow_failed', message: workflow.message } : undefined } : current); if (workflow.proposal) setRufloProposal(workflow.proposal); if (workflow.phase === 'completed') { setPreviewProposalId(result.proposalId); notify('Ruflo completed after reviewer and validator approval.'); } else if (workflow.phase === 'waiting_approval') notify('Validation failed safely. A bounded fix proposal is waiting for approval.'); else notify(workflow.message); }} />}</>}</div>
      </div>
              <div className="composer-wrap">{contextPaths.length > 0 && <div className="context-chips" aria-label="Selected repository context">{contextPaths.map((path) => <button key={path} onClick={() => setContextPaths((current) => current.filter((item) => item !== path))}>@{path} <X size={11} /></button>)}</div>}<form className="composer" onSubmit={handleSend}><textarea value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={onComposerKeyDown} placeholder={composerMode === 'ruflo' ? 'Describe what Ruflo should inspect…' : repository ? "Ask about this repository…" : "Ask Cosmic Agent anything…"} rows={1} aria-label="Message Cosmic Agent" /><div className="composer-bottom"><div className="composer-meta"><ComposerModePicker mode={composerMode} open={composerMenuOpen} onToggle={() => setComposerMenuOpen((open) => !open)} onChange={selectComposerMode} /><div className="model-picker"><button type="button" className="model-trigger" onClick={() => setModelOpen((open) => !open)} aria-haspopup="listbox" aria-expanded={modelOpen}><Sparkles size={14} /><span>{selectedModel.displayName}</span><ChevronDown size={14} /></button>{modelOpen && <div className="model-menu" role="listbox">{models.map((model) => <button type="button" role="option" aria-selected={model.id === selectedModel.id} className={model.id === selectedModel.id ? 'selected' : ''} key={model.id} onClick={() => changeModel(model.id)}><span><strong>{model.displayName}</strong><small>{model.provider} · {model.capabilities.join(' · ')}</small></span>{model.id === selectedModel.id && <Check size={15} />}</button>)}</div>}</div><span className="composer-hint">Enter to send · Shift + Enter for newline</span></div>{isStreaming || isProposing ? <button type="button" className="stop-button" onClick={() => { abortRef.current?.abort(); setIsProposing(false); }}><Square size={13} fill="currentColor" /> Stop</button> : isStartingRuflo ? <button type="button" className="send-button" disabled aria-label="Starting Ruflo"><LoaderCircle className="spin" size={16} /></button> : <button type="submit" className="send-button" disabled={!draft.trim()} aria-label="Send message"><Send size={16} /></button>}</div></form><p className="composer-disclaimer">{modeDescription} · {composerMode === 'ruflo' ? 'Changes require explicit approval.' : 'Approval never writes without your confirmation.'}</p></div>
    </main>
    <RepositoryPanel open={repositoryOpen} repository={repository} onRepositoryChange={(next) => { setRepository(next); if (!next) setContextPaths([]); }} contextPaths={contextPaths} onAddContext={(path) => setContextPaths((current) => current.includes(path) ? current : [...current, path])} onRemoveContext={(path) => setContextPaths((current) => current.filter((item) => item !== path))} onClose={() => setRepositoryOpen(false)} />
     {resourceOpen && <button className="drawer-overlay resource-overlay" onClick={() => setResourceOpen(false)} aria-label="Close resource status" />}
     <ResourceStatusPanel open={resourceOpen} onClose={() => setResourceOpen(false)} />
      {settingsOpen && <><button className="drawer-overlay settings-overlay" onClick={() => setSettingsOpen(false)} aria-label="Close settings" /><ControlCenter onClose={() => setSettingsOpen(false)} onOpenFiles={() => { setSettingsOpen(false); setLocation('/files'); }} notify={notify} integrationDetail={(onBack) => <GitHubSettings embedded onBack={onBack} onClose={() => setSettingsOpen(false)} notify={notify} />} /></>}
    {toast && <div className="toast-note" role="status">{toast}</div>}
  </div>;
}

function EmptyState({ onPrompt }: { onPrompt: (prompt: string) => void }) {
  return <div className="empty-state"><div className="empty-orb"><Aperture size={32} /></div><h1>How can I help you today?</h1><p>Reason through software changes, understand code, and shape better technical decisions with a clear, reviewable conversation.</p><div className="prompt-grid">{promptSuggestions.map(([label, prompt]) => <button key={label} onClick={() => onPrompt(prompt)}><span>{label}</span><small>{prompt}</small><Send size={14} /></button>)}</div></div>;
}
function SourceUsage({ usage }: { usage?: ContextUsage }) {
  if (!usage) return null;
  const sources: UsedSource[] = usage.sources.length ? usage.sources : usage.paths.map((path) => ({ path }));
  const visibleSources = sources.slice(0, 4);
  if (!visibleSources.length) return null;
  return <div className="source-usage" data-testid="assistant-source-usage"><div className="source-usage-label"><FileCode2 size={13} /> Sources used <span>{sources.length > visibleSources.length ? `· ${sources.length - visibleSources.length} more` : '· bounded view'}</span></div><div className="source-usage-list">{visibleSources.map((source, index) => <span className="source-usage-item" data-testid={`assistant-source-${index}`} key={`${source.path}-${source.startLine ?? 0}`} title={source.path}>{source.path}{source.startLine ? `:${source.startLine}${source.endLine && source.endLine !== source.startLine ? `–${source.endLine}` : ''}` : ''}</span>)}</div></div>;
}
type ActivityTone = 'active' | 'complete' | 'failed' | 'neutral';
const activityIconFor = (label: string) => {
  const normalized = label.toLowerCase();
  if (normalized.includes('search')) return <Search size={13} />;
  if (normalized.includes('read') || normalized.includes('context')) return <FileCode2 size={13} />;
  if (normalized.includes('plan')) return <Sparkles size={13} />;
  if (normalized.includes('edit') || normalized.includes('proposal')) return <Pencil size={13} />;
  if (normalized.includes('review')) return <Eye size={13} />;
  if (normalized.includes('validat') || normalized.includes('test')) return <ShieldCheck size={13} />;
  if (normalized.includes('build')) return <Terminal size={13} />;
  if (normalized.includes('provider')) return <LoaderCircle size={13} />;
  return <Activity size={13} />;
};
const activityLabelForTool = (tool: string) => ({
  repository_search: 'Searching files',
  read_file: 'Reading file',
  file_context: 'Reading file context',
  analyze_repository: 'Reviewing repository',
  repository_status: 'Reviewing repository status',
  create_proposal: 'Creating proposal',
  run_typecheck: 'Validating',
  run_build: 'Building',
  inspect_validation_result: 'Reviewing validation',
  git_status: 'Reviewing Git status',
  git_diff: 'Reviewing changes',
  git_stage_proposed_changes: 'Staging approved files',
  git_commit: 'Creating approved commit',
  git_push: 'Pushing approved commit',
 } as Record<string, string>)[tool] ?? 'Working on the project';
const activityDetailForTrace = (status: string) =>
  status === 'failed' || status === 'denied' || status === 'timeout'
    ? 'This step stopped safely and needs attention.'
    : status === 'completed'
      ? 'Completed successfully.'
      : 'In progress.';

function ActivityPanel({ session }: { session: RuntimeSession }) {
  const [expanded, setExpanded] = useState(false);
  const traces = session.toolTraces ?? [];
  const events = session.events ?? [];
  const proposalFiles = session.proposalData?.files ?? [];
  const fileReadCount = session.context.filesIncluded;
  const filesAdded = proposalFiles.filter((file) => file.operation === 'create').length;
  const filesEdited = proposalFiles.filter((file) => file.operation === 'edit').length;
  const filesDeleted = proposalFiles.filter((file) => (file.operation as string) === 'delete').length;
  const filesRenamed = proposalFiles.filter((file) => (file.operation as string) === 'rename').length;
  const directoriesCreated = proposalFiles.filter((file) => (file.operation as string) === 'directory_create').length;
  const hasLineStats = Boolean(session.proposalData);
  const activity = [
    ...events.map((event) => ({ id: event.id, label: event.label, detail: event.detail, timestamp: event.timestamp, tone: event.type === 'task_failed' ? 'failed' as ActivityTone : event.type === 'task_completed' || event.type === 'proposal_generated' ? 'complete' as ActivityTone : 'neutral' as ActivityTone })),
     ...traces.map((trace) => ({ id: trace.toolCallId, label: activityLabelForTool(trace.tool), detail: activityDetailForTrace(trace.status), timestamp: trace.completedAt ?? trace.startedAt, tone: trace.status === 'failed' || trace.status === 'denied' || trace.status === 'timeout' ? 'failed' as ActivityTone : trace.status === 'completed' ? 'complete' as ActivityTone : 'active' as ActivityTone })),
  ].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  const visibleActivity = expanded ? activity : activity.slice(-5);
  const counters = [
    ['Actions', traces.length],
    ['Files read', fileReadCount ?? '—'],
    ['Files created', hasLineStats ? filesAdded : '—'],
    ['Files edited', hasLineStats ? filesEdited : '—'],
    ['Files deleted', hasLineStats ? filesDeleted : '—'],
    ['Files renamed', hasLineStats ? filesRenamed : '—'],
    ['Directories created', hasLineStats ? directoriesCreated : '—'],
    ['Lines added', hasLineStats ? session.proposalData!.addedLines : '—'],
    ['Lines removed', hasLineStats ? session.proposalData!.removedLines : '—'],
    ['Lines changed', hasLineStats ? session.proposalData!.addedLines + session.proposalData!.removedLines : '—'],
  ];
  const current = activity.at(-1);
  return <section className="live-activity-panel" aria-label="Live agent activity" data-testid="panel-live-activity">
    <div className="live-activity-head">
      <div><span className="agent-panel-kicker"><Activity size={11} /> Live activity</span><strong>{current?.label ?? 'No activity recorded'}</strong></div>
      <span className={`activity-pulse ${session.status === 'running' ? 'active' : session.status === 'failed' ? 'failed' : 'complete'}`} aria-label={session.status} />
    </div>
    <div className="activity-counters">{counters.map(([label, value]) => <div key={label} className="activity-counter"><strong>{value}</strong><span>{label}</span></div>)}</div>
    <div className="activity-list">{visibleActivity.map((item) => <div className={`activity-row ${item.tone}`} key={item.id}><span className="activity-row-icon">{activityIconFor(item.label)}</span><div><strong>{item.label}</strong>{item.detail && <small>{item.detail}</small>}</div><time>{new Date(item.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time></div>)}</div>
    {activity.length > 5 && <button className="activity-expand" onClick={() => setExpanded((value) => !value)}>{expanded ? 'Show latest' : `Show ${activity.length - 5} earlier events`}<ChevronDown size={13} className={expanded ? 'rotate' : ''} /></button>}
  </section>;
}

function RufloActivityPanel({ session, connection }: { session: RufloClientSession; connection: RufloConnectionState }) {
  const proposalLabels: Record<RufloClientSession['proposalStatus'], string> = { 'not-created': 'Not created', ready: 'Ready for approval', applied: 'Applied locally', completed: 'Completed' };
  const validationLabels: Record<RufloClientSession['validationStatus'], string> = { 'not-run': 'Not run', pass: 'Passed', fail: 'Failed safely', 'not-verified': 'Not verified' };
  const gitLabels: Record<RufloClientSession['git']['status'], string> = { 'not-available': 'Not available', 'not-requested': 'Not requested', ready: 'Ready for review', committed: 'Committed', pushed: 'Pushed', unavailable: 'Unavailable' };
  const statusTone = session.status === 'failed' ? 'failed' : session.status === 'completed' ? 'complete' : session.phase === 'waiting_approval' ? 'waiting' : 'active';
  const statusCopy = connection === 'live' ? 'Live stream connected' : connection === 'connecting' ? 'Connecting to stream' : connection === 'reconnecting' ? 'Reconnecting to stream' : connection === 'unauthorized' ? 'Stream unavailable' : session.status === 'waiting' ? 'Paused at approval gate' : session.status === 'completed' ? 'Session closed cleanly' : session.status === 'failed' ? 'Stopped safely' : 'Stream closed';
  const taskMap = new Map(session.tasks.map((task) => [task.id, task]));
  const completedTasks = session.tasks.filter((task) => task.status === 'complete').length;
  const activeTasks = session.tasks.filter((task) => task.status === 'active').length;
  const planPercent = session.tasks.length ? Math.round((completedTasks / session.tasks.length) * 100) : 0;
  const humanize = (value: string) => value.replaceAll('_', ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
  const formatUsd = (value?: number) => value === undefined ? 'Not metered' : `$${value.toFixed(4)}`;
  const activityIcon = (status: RufloActivity['status']) => status === 'failed' ? <CircleAlert size={14} /> : status === 'complete' ? <CircleCheck size={14} /> : <LoaderCircle size={14} className="spin" />;
  const approvalMessage = session.workflowMessage ?? (session.phase === 'waiting_approval'
    ? 'The proposal is held at the server approval boundary. Nothing is applied from this panel.'
    : session.phase === 'completed'
      ? 'Reviewer and validator both passed. Ruflo completed safely.'
      : session.status === 'failed'
        ? 'The session stopped safely. No further changes will be attempted.'
        : 'Ruflo is gathering readable project evidence. Changes remain behind approval.');

  return <section className="ruflo-panel" aria-label="Ruflo live swarm dashboard" data-testid="panel-ruflo-activity">
    <header className="ruflo-console-head">
      <div className="ruflo-title-block">
        <div className="ruflo-title-line"><span className="agent-panel-kicker"><Activity size={11} /> Ruflo / live swarm</span><span className="ruflo-session-id">{session.id}</span></div>
        <h2>Bounded execution surface</h2>
        <p>Reviewable agents, readable evidence, and a hard approval boundary.</p>
      </div>
      <div className={`ruflo-connection ${statusTone} ${connection}`} aria-label={`Session state: ${statusCopy}`} data-testid="status-ruflo-connection"><span className="ruflo-connection-dot" />{statusCopy}</div>
    </header>

    <div className="ruflo-mission">
      <span className="ruflo-eyebrow">Mission task</span>
      <strong data-testid="text-ruflo-task">{session.task}</strong>
      <div className="ruflo-mission-meta"><span><Bot size={12} /> {session.currentAgent}</span><span><Gauge size={12} /> {session.currentLabel}</span><span><Code2 size={12} /> {session.capability}</span></div>
    </div>

    <div className="ruflo-metrics" aria-label="Ruflo session metrics">
      <div className="ruflo-metric"><span>Tasks complete</span><strong>{completedTasks}<small> / {session.tasks.length || '—'}</small></strong><i><span style={{ width: `${planPercent}%` }} /></i></div>
      <div className="ruflo-metric"><span>Active agents</span><strong>{session.agents.filter((agent) => agent.status === 'active').length}<small> / {session.agents.length || '—'}</small></strong><em>{activeTasks} active task{activeTasks === 1 ? '' : 's'}</em></div>
      <div className="ruflo-metric"><span>Files in scope</span><strong>{session.affectedFiles.length || '—'}</strong><em>Server-reported surface</em></div>
      <div className="ruflo-metric"><span>Recovery budget</span><strong>{session.recoveryAttempts}<small> / {session.maxRecoveryAttempts}</small></strong><em>{session.recoveryAttempts ? 'Attempts used' : 'No recovery needed'}</em></div>
    </div>

    <div className="ruflo-dashboard-grid">
      <section className="ruflo-card ruflo-activity-card" aria-label="Live activity">
        <div className="ruflo-card-heading"><div><span className="ruflo-eyebrow"><Activity size={11} /> Live activity</span><h3>{session.currentLabel}</h3></div><span className="ruflo-card-count">{session.activity.length} events</span></div>
        <div className="ruflo-activity-list" aria-live="polite">{session.activity.length ? session.activity.slice(-8).map((item) => <div className={`ruflo-activity-row ${item.status}`} key={item.id} data-testid={`row-ruflo-activity-${item.id}`}><span className="ruflo-activity-mark">{activityIcon(item.status)}</span><div><strong>{item.label}</strong><small>{item.status === 'active' ? 'In progress on server' : item.status === 'failed' ? 'Stopped with an error' : 'Recorded by server'}</small></div><time>{new Date(item.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time></div>) : <p className="ruflo-empty">Waiting for the first server event.</p>}</div>
      </section>

      <section className="ruflo-card ruflo-agents-card" aria-label="Agent roster">
        <div className="ruflo-card-heading"><div><span className="ruflo-eyebrow"><Bot size={11} /> Agent roster</span><h3>Swarm assignments</h3></div><span className="ruflo-card-count">{session.agents.length} agents</span></div>
        <div className="ruflo-agents">{session.agents.length ? session.agents.map((agent) => <div className={`ruflo-agent-row ${agent.status}`} key={agent.id} data-testid={`row-ruflo-agent-${agent.id}`}><span className="ruflo-agent-mark">{agent.status === 'active' ? <LoaderCircle size={13} className="spin" /> : agent.status === 'complete' ? <CircleCheck size={13} /> : agent.status === 'failed' ? <CircleAlert size={13} /> : <span />}</span><div><strong>{agent.role}</strong><small>{agent.executionId ?? agent.id}</small></div><span className="ruflo-agent-state">{humanize(agent.status)}{agent.attempts ? ` · ${agent.attempts} attempt${agent.attempts === 1 ? '' : 's'}` : ''}</span></div>) : <p className="ruflo-empty">No agents have been assigned yet.</p>}</div>
      </section>
    </div>

    <div className="ruflo-dashboard-grid ruflo-lower-grid">
      <section className="ruflo-card" aria-label="Execution waves and task graph">
        <div className="ruflo-card-heading"><div><span className="ruflo-eyebrow"><Terminal size={11} /> Task graph</span><h3>Execution waves</h3></div><span className="ruflo-card-count">{session.executionWaves.length} waves</span></div>
        <div className="ruflo-waves">{session.executionWaves.length ? session.executionWaves.map((wave, index) => {
          const waveTasks = wave.taskIds.map((id) => taskMap.get(id)).filter((task): task is RufloClientSession['tasks'][number] => Boolean(task));
          const waveDone = waveTasks.filter((task) => task.status === 'complete').length;
          return <div className="ruflo-wave" key={wave.id} data-testid={`row-ruflo-wave-${wave.id}`}><div className="ruflo-wave-spine"><span>{String(index + 1).padStart(2, '0')}</span>{index < session.executionWaves.length - 1 && <i />}</div><div className="ruflo-wave-body"><div className="ruflo-wave-head"><strong>{wave.label}</strong><span className={`ruflo-wave-status ${wave.status}`}>{humanize(wave.status)}</span></div><small>{waveDone} of {waveTasks.length || wave.taskIds.length} tasks complete</small><div className="ruflo-task-list">{waveTasks.map((task) => <div className={`ruflo-task-row ${task.status}`} key={task.id}><span>{task.status === 'complete' ? <CircleCheck size={12} /> : task.status === 'failed' || task.status === 'blocked' ? <CircleAlert size={12} /> : task.status === 'active' ? <LoaderCircle size={12} className="spin" /> : <span className="ruflo-task-number" />}</span><strong>{task.title}</strong><em>{humanize(task.status)}{task.dependencies.length ? ` · waits ${task.dependencies.length}` : ''}</em></div>)}</div></div></div>;
        }) : <p className="ruflo-empty">The task graph will appear as Ruflo plans the mission.</p>}</div>
      </section>

      <section className="ruflo-card ruflo-guard-card" aria-label="Validation and recovery">
        <div className="ruflo-card-heading"><div><span className="ruflo-eyebrow"><ShieldCheck size={11} /> Safety ledger</span><h3>Validation &amp; recovery</h3></div><span className={`ruflo-ledger-state ${statusTone}`}>{humanize(session.phase)}</span></div>
        <div className="ruflo-ledger">
          <div className="ruflo-ledger-row"><span><LockKeyhole size={12} /> Proposal gate</span><strong className={session.proposalStatus === 'ready' ? 'waiting' : ''}>{proposalLabels[session.proposalStatus]}</strong></div>
          <div className="ruflo-ledger-row"><span><Check size={12} /> Validation</span><strong className={session.validationStatus === 'fail' ? 'failed' : session.validationStatus === 'pass' ? 'passed' : ''}>{validationLabels[session.validationStatus]}</strong></div>
          <div className="ruflo-ledger-row"><span><GitBranch size={12} /> Git boundary</span><strong>{gitLabels[session.git.status]}</strong></div>
        </div>
        {session.validation && <div className={`ruflo-validation-detail ${session.validation.status}`}><strong>{humanize(session.validation.status)}</strong><span>{session.validation.summary}</span></div>}
        {session.error && <div className="ruflo-error-detail"><CircleAlert size={13} /><span><strong>{session.error.code}</strong>{session.error.message}</span></div>}
        <div className={`ruflo-recovery-line ${statusTone}`}><span>Recovery attempts</span><strong>{session.recoveryAttempts} / {session.maxRecoveryAttempts}</strong></div>
      </section>
    </div>

    <section className="ruflo-card ruflo-telemetry" aria-label="Provider and cost details">
      <div className="ruflo-card-heading"><div><span className="ruflo-eyebrow"><Sparkles size={11} /> Runtime telemetry</span><h3>Provider route &amp; usage</h3></div><span className="ruflo-card-count">{session.usage.costStatus}</span></div>
      <div className="ruflo-telemetry-grid">
        <div className="ruflo-route"><span className="ruflo-subhead">Primary route</span><strong>{session.routing.primary.provider}</strong><small>{session.routing.primary.model}</small><p>{session.routing.reason}</p>{session.routing.fallbacks.length > 0 && <div className="ruflo-fallbacks"><span>Fallbacks</span>{session.routing.fallbacks.map((fallback) => <em key={`${fallback.provider}-${fallback.model}`}>{fallback.provider} / {fallback.model}</em>)}</div>}</div>
        <div className="ruflo-usage-stats"><div><span>Requests</span><strong>{session.usage.requests}</strong></div><div><span>Input tokens</span><strong>{session.usage.inputTokens.toLocaleString()}</strong></div><div><span>Output tokens</span><strong>{session.usage.outputTokens.toLocaleString()}</strong></div><div><span>Estimated cost</span><strong>{formatUsd(session.usage.estimatedCostUsd)}</strong></div></div>
      </div>
       {session.usage.providerModels.length > 0 && <div className="ruflo-provider-models"><span>Models observed</span>{session.usage.providerModels.map((model) => <em key={`${model.provider}-${model.model}`}>{model.provider} / {model.model}</em>)}</div>}
    </section>

    <div className="ruflo-bottom-grid">
      <section className="ruflo-card ruflo-files-card" aria-label="Affected files">
        <div className="ruflo-card-heading"><div><span className="ruflo-eyebrow"><FileCode2 size={11} /> Change surface</span><h3>Affected files</h3></div><span className="ruflo-card-count">{session.affectedFiles.length} paths</span></div>
        <div className="ruflo-file-list">{session.affectedFiles.length ? session.affectedFiles.map((file) => <span key={file} data-testid={`text-ruflo-file-${file}`}><FileCode2 size={11} />{file}</span>) : <span className="ruflo-empty">No affected files identified yet.</span>}</div>
      </section>
      <section className="ruflo-card ruflo-memory-card" aria-label="Bounded memory">
        <div className="ruflo-card-heading"><div><span className="ruflo-eyebrow"><Code2 size={11} /> Context boundary</span><h3>Working memory</h3></div><span className={`ruflo-memory-state ${session.memory.bounded ? 'bounded' : 'unbounded'}`}>{session.memory.bounded ? 'Bounded' : 'Review'}</span></div>
        <div className="ruflo-memory-main"><strong>{session.memory.factCount}</strong><span>facts available</span></div><p>{session.memory.status} · Session reports {session.memoryFactCount} retained fact{session.memoryFactCount === 1 ? '' : 's'}.</p>
      </section>
    </div>

    <div className={`ruflo-note ${statusTone}`} data-testid="status-ruflo-approval"><ShieldCheck size={15} /><div><strong>{session.phase === 'waiting_approval' ? 'Approval boundary engaged' : 'Server-authoritative workflow'}</strong><span>{approvalMessage}</span></div></div>
  </section>;
}

function AgentTimeline({ session, model }: { session: RuntimeSession; model: AiModel }) {
  const completedSteps = session.plan.filter((step) => step.status === 'complete').length;
  const planPercent = session.plan.length ? Math.round((completedSteps / session.plan.length) * 100) : 0;
  const hasWarnings = session.context.warnings.length > 0;
  const approvalLabel = session.status === 'waiting_approval' ? 'Approval required' : session.proposal ? 'Proposal ready' : session.status === 'completed' ? 'Approved and complete' : 'No approval requested';
  const statusLabel = session.status === 'waiting_approval' ? 'Waiting for approval' : session.status === 'failed' ? 'Stopped safely' : session.status === 'completed' ? 'Complete' : 'Running';
  const recoveryLabel = session.status === 'failed' ? 'Recovery checkpoint' : session.status === 'waiting_approval' ? 'Paused at approval gate' : session.status === 'completed' ? 'Run closed cleanly' : 'Recovery armed';
  const recoveryDetail = session.status === 'failed'
    ? 'The last step stopped safely. Review the activity and retry when ready.'
    : session.status === 'waiting_approval'
      ? 'No changes happen until you approve the proposal below.'
      : session.status === 'completed'
        ? 'All planned work has reached a final state.'
        : 'The current work is continuing safely.';
  const roleLabel = (role: string) => role === 'frontend' ? 'Frontend work' : role === 'backend' ? 'Backend work' : role === 'reviewer' ? 'Review' : role === 'validator' ? 'Validation' : 'Planning';

  return <section className="agent-timeline" aria-label="Agent execution timeline" data-testid="panel-agent-execution">
    <div className="agent-timeline-head">
       <div><span className="agent-kicker"><Activity size={12} /> Agent mode</span><strong>{session.task}</strong></div>
      <span className={`agent-status ${session.status}`} data-testid="status-agent-runtime">{statusLabel}</span>
    </div>

    <ActivityPanel session={session} />
    <div className="agent-scan-grid" aria-label="Execution summary">
      <div className="agent-scan-card" data-testid="status-agent-step"><span className="agent-scan-label"><Gauge size={12} /> Current step</span><strong>{session.currentStep.replaceAll('_', ' ')}</strong><small>{completedSteps} of {session.plan.length} plan steps complete</small></div>
       <div className="agent-scan-card" data-testid="status-agent-model"><span className="agent-scan-label"><Bot size={12} /> Selected model</span><strong>{model.displayName}</strong><small>Selected for this request</small></div>
       <div className="agent-scan-card" data-testid="status-agent-context"><span className="agent-scan-label"><Terminal size={12} /> Project context</span><strong>{session.context.filesIncluded} files inspected</strong><small>{session.context.chunked ? 'Context was safely split into sections' : 'Relevant source was read before planning'}</small></div>
       <div className={`agent-scan-card approval-card ${session.status === 'waiting_approval' ? 'needs-approval' : ''}`} data-testid="status-agent-approval"><span className="agent-scan-label"><LockKeyhole size={12} /> Approval status</span><strong>{approvalLabel}</strong><small>{session.proposal ? `${session.proposal.files.length} files in proposal` : 'No file changes are being made'}</small></div>
    </div>

    <div className="agent-progress-wrap">
       <div className="agent-progress-caption"><span>Execution plan</span><strong>{planPercent}%</strong></div>
       <div className="agent-progress" aria-label={`${planPercent}% of execution plan complete`}><span style={{ width: `${planPercent}%` }} /></div>
    </div>

    <div className="agent-surface-grid">
       <section className="agent-surface-panel plan-panel" aria-label="Execution plan">
         <div className="agent-panel-heading"><div><span className="agent-panel-kicker">Plan</span><strong>Steps for this request</strong></div><span className="agent-panel-count">{session.plan.length} steps</span></div>
        <div className="agent-plan">{session.plan.map((step, index) => <div className={`agent-step ${step.status}`} key={step.id} data-testid={`row-agent-step-${step.id}`}><span className="agent-step-mark">{step.status === 'complete' ? <CircleCheck size={14} /> : step.status === 'blocked' ? <CircleAlert size={14} /> : index + 1}</span><span>{step.title}</span><em>{step.status}</em></div>)}</div>
      </section>

      <section className="agent-surface-panel tools-panel" aria-label="Assigned work">
        <div className="agent-panel-heading"><div><span className="agent-panel-kicker"><ShieldCheck size={11} /> Assigned work</span><strong>People and checks involved</strong></div><span className="agent-panel-count">{session.orchestration.selectedWorkers.length} roles</span></div>
        <div className="agent-plan">{session.orchestration.selectedWorkers.map((role) => {
          const completed = role === 'reviewer' ? session.orchestration.reviewStatus === 'completed' : role === 'validator' ? session.orchestration.completedSubtasks.some((id) => id.includes('validator')) : Boolean(session.workerState.completedToolIds[role]?.length);
          return <div className={`agent-step ${completed ? 'complete' : session.status === 'failed' ? 'blocked' : 'active'}`} key={role}><span className="agent-step-mark">{completed ? <CircleCheck size={14} /> : session.status === 'failed' ? <CircleAlert size={14} /> : <LoaderCircle size={14} className="spin" />}</span><span>{role === 'frontend' ? 'Frontend work' : role === 'backend' ? 'Backend work' : role === 'reviewer' ? 'Review' : role === 'validator' ? 'Validation' : 'Planning'}</span><em>{completed ? 'complete' : session.status === 'failed' ? 'stopped' : 'working'}</em></div>;
        })}</div>
      </section>
    </div>

    <section className={`agent-recovery ${session.status}`} aria-label="Recovery state" data-testid="status-agent-recovery">
      <div className="recovery-icon">{session.status === 'failed' ? <CircleAlert size={15} /> : <ShieldCheck size={15} />}</div>
      <div><span className="agent-panel-kicker">{recoveryLabel}</span><strong>{recoveryDetail}</strong></div>
     <span className="recovery-iteration">{session.status === 'failed' ? 'Retry available' : session.status === 'waiting_approval' ? 'Your decision' : 'Safe progress'}</span>
    </section>

    {hasWarnings && <details className="agent-context-notes" data-testid="details-agent-context-notes"><summary><span>Context notes</span><span>{session.context.warnings.length} note{session.context.warnings.length === 1 ? '' : 's'}</span></summary><div>{session.context.warnings.map((warning, index) => <p key={`${warning}-${index}`}>{warning}</p>)}</div></details>}

    <details className="agent-event-log" data-testid="details-agent-events">
      <summary><span>Activity history</span><span>{session.events.length} update{session.events.length === 1 ? '' : 's'}</span></summary>
      <div className="agent-events">{session.events.slice(-6).map((event) => <div className="agent-event" key={event.id}><span className="agent-event-time">{new Date(event.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span><div><strong>{event.label}</strong>{event.detail && !/calling|runtime|tool|checkpoint|budget|read-only|approved tool/i.test(event.detail) && <small>{event.detail}</small>}</div></div>)}</div>
    </details>
  </section>;
}
function MessageBubble({ message, onRetry, onEdit }: { message: ChatMessage; onRetry: () => void; onEdit: (text: string) => void }) {
  return <article className={`message ${message.role} ${message.error ? 'error' : ''}`}><div className="message-avatar">{message.role === 'assistant' ? <Aperture size={15} /> : 'AR'}</div><div className="message-content"><div className="message-label"><strong>{message.role === 'assistant' ? 'Cosmic Agent' : 'You'}</strong><span>{new Date(message.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span></div>{message.error ? <div className="error-panel"><p>{message.content}</p><button onClick={onRetry}><RefreshCw size={14} /> Retry</button></div> : message.role === 'assistant' ? <><Markdown content={message.content} /><SourceUsage usage={message.repositoryContext} /></> : <p className="user-text">{message.content}</p>}{message.streaming && <span className="generation-cursor" aria-label="Generating response" />}{!message.streaming && <div className="message-actions"><button onClick={() => copyText(message.content)} aria-label="Copy message"><Copy size={13} /> Copy</button>{message.role === 'assistant' ? <><button onClick={onRetry}><RefreshCw size={13} /> Regenerate</button></> : <button onClick={() => onEdit(message.content)}><Pencil size={13} /> Edit</button>}</div>}</div></article>;
}
function friendlyAuthError(cause: unknown) {
  const message = cause instanceof Error ? cause.message.toLowerCase() : '';
  if (message.includes('already') || message.includes('exists')) return 'An account with that email already exists. Try signing in instead.';
  if (message.includes('invalid') || message.includes('credential') || message.includes('password') || message.includes('401')) return 'Those sign-in details were not accepted. Check your email and password and try again.';
  if (message.includes('network') || message.includes('fetch') || message.includes('connect')) return 'We could not connect to the workspace. Check your connection and try again.';
  return 'We could not complete that sign-in. Please try again.';
}
function friendlyError(message: string) { const lower = message.toLowerCase(); if (lower.includes('rate') || lower.includes('limit')) return 'The provider is temporarily busy. Please wait a moment and try again.'; if (lower.includes('unavailable') || lower.includes('configured')) return 'This model is unavailable right now. Try another model from the selector.'; return 'We could not reach the provider. Check your connection and try again.'; }
function isCodingRequest(text: string) {
  return /\b(create|add|build|edit|fix|change|update|remove|delete|rename|refactor|implement|modify|replace|improve|debug|configure|set up)\b/i.test(text.trim())
    || /\b(bug|feature|component|screen|login|patch|file|endpoint|route|api|backend|frontend|ui|configuration|config)\b/i.test(text);
}
function PreviewPage() {
  const { proposalId = '' } = useParams<{ proposalId: string }>();
  const [, setLocation] = useLocation();
  return <main className="preview-page"><header className="preview-page-header"><Link className="preview-back" href="/"><Aperture size={16} /> Cosmic Agent</Link><div><span className="repo-kicker"><Eye size={12} /> Dedicated application preview</span><strong>Approved project runtime</strong></div><span className="preview-page-id">{proposalId}</span></header><div className="preview-page-content"><PreviewPanel proposalId={proposalId} onClose={() => setLocation('/')} /></div></main>;
}
function Router({ user, onLogout }: { user: SessionUser; onLogout: () => void }) { return <ErrorBoundary><Switch><Route path="/" component={() => <Home user={user} onLogout={onLogout} />} /><Route path="/files" component={FileExplorerPage} /><Route path="/preview/:proposalId" component={PreviewPage} /><Route component={NotFound} /></Switch></ErrorBoundary>; }
function App() {
  const [user, setUser] = useState<SessionUser | null>(null);
  const [checking, setChecking] = useState(true);
  const [authCheckError, setAuthCheckError] = useState('');
  const checkAuthentication = () => {
    setChecking(true);
    setAuthCheckError('');
    void apiJson<{ user: SessionUser }>('/api/auth/me')
      .then((result) => setUser(result.user))
      .catch((cause) => {
        if (cause instanceof ApiHttpError && cause.status === 401) {
          setUser(null);
          return;
        }
        setUser(null);
        setAuthCheckError('We could not verify your session. Check your connection and try again.');
      })
      .finally(() => setChecking(false));
  };
  useEffect(() => { checkAuthentication(); }, []);
  const logout = () => { setUser(null); queryClient.clear(); };
  if (checking) return <main className="auth-shell"><LoaderCircle className="spin" size={22} /></main>;
  if (authCheckError) return <main className="auth-shell"><section className="auth-card"><div className="auth-brand"><div className="brand-mark"><Aperture size={17} /></div><span>Cosmic Agent</span></div><div className="auth-heading"><span className="repo-kicker"><CircleAlert size={12} /> Session check</span><h1>We hit a connection problem</h1><p>{authCheckError}</p></div><button className="auth-submit" onClick={checkAuthentication}><RefreshCw size={15} /> Try again</button></section></main>;
  return <QueryClientProvider client={queryClient}><TooltipProvider>{user ? <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, '')}><Router user={user} onLogout={logout} /></WouterRouter> : <AuthScreen onAuthenticated={setUser} />}<Toaster /></TooltipProvider></QueryClientProvider>;
}
export default App;