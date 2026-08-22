import { type FormEvent, type KeyboardEvent, useEffect, useMemo, useRef, useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createChangeProposal, createAgentSession, type AiModel, type AgentSession, type ChangeExecutionResult, type ChangeProposal, type CommitResult, type PushResult, useListAiModels } from '@workspace/api-client-react';
import { ErrorBoundary } from '@/components/error-boundary';
import { RepositoryPanel, type RepositoryRef } from '@/components/repository-panel';
import { ResourceStatusPanel } from '@/components/resource-status-panel';
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';
import NotFound from '@/pages/not-found';
import { ChangeProposalReview } from '@/components/change-proposal-review';
import {
  Aperture, Check, ChevronDown, Clipboard, Code2, Copy, Menu, MoreHorizontal,
  FileCode2,
  Activity, GitBranch, Pencil, Plus, RefreshCw, Search, Send, Sparkles, Trash2, X, Square,
} from 'lucide-react';
import { Route, Switch, useLocation, Router as WouterRouter } from 'wouter';

const queryClient = new QueryClient();
type Role = 'user' | 'assistant';
type UsedSource = { path: string; startLine?: number; endLine?: number };
type ContextUsage = { paths: string[]; sources: UsedSource[]; warnings?: string[]; approximateChars?: number; chunked?: boolean };
type ChatMessage = { id: string; role: Role; content: string; createdAt: number; error?: boolean; streaming?: boolean; repositoryContext?: ContextUsage };
type Conversation = { id: string; title: string; modelId: string; messages: ChatMessage[]; updatedAt: number };
type RuntimeSession = AgentSession & { proposalData?: ChangeProposal };

const fallbackModels: AiModel[] = [
  { id: 'openai/gpt-oss-120b', displayName: 'GPT OSS 120B', provider: 'groq', capabilities: ['coding', 'reasoning'], contextWindow: 131072, enabled: true, recommended: true },
  { id: 'openai/gpt-oss-20b', displayName: 'GPT OSS 20B', provider: 'groq', capabilities: ['coding', 'reasoning', 'fast'], contextWindow: 131072, enabled: true, recommended: false },
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

function Home() {
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
  const [proposal, setProposal] = useState<ChangeProposal | null>(null);
  const [proposalRequest, setProposalRequest] = useState('');
  const [isProposing, setIsProposing] = useState(false);
  const [agentSession, setAgentSession] = useState<RuntimeSession | null>(null);
  const [editingId, setEditingId] = useState('');
  const [repository, setRepository] = useState<RepositoryRef | null>(() => {
    try { return JSON.parse(localStorage.getItem('cosmic-repository') ?? 'null') as RepositoryRef | null; } catch { return null; }
  });
  const [contextPaths, setContextPaths] = useState<string[]>([]);
  const [repositoryOpen, setRepositoryOpen] = useState(false);
  const [resourceOpen, setResourceOpen] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  const active = conversations.find((conversation) => conversation.id === activeId) ?? null;
  const selectedModel = models.find((model) => model.id === selectedModelId) ?? models[0] ?? fallbackModels[0];

  useEffect(() => { localStorage.setItem('cosmic-conversations', JSON.stringify(conversations)); }, [conversations]);
  useEffect(() => { if (repository) localStorage.setItem('cosmic-repository', JSON.stringify(repository)); else localStorage.removeItem('cosmic-repository'); }, [repository]);
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
  const handleSend = async (event?: FormEvent) => {
    event?.preventDefault();
    const text = draft.trim();
    if (!text || isStreaming || !selectedModel) return;
    if (repository && contextPaths.length && isCodingRequest(text)) {
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
      <div className="sidebar-bottom"><button className="clear-history" onClick={() => { if (window.confirm('Clear all conversation history?')) { setConversations([]); setActiveId(''); notify('Conversation history cleared'); } }}><Trash2 size={15} /> Clear history</button><div className="sidebar-account"><div className="account-avatar">AR</div><div><strong>Avery Rowan</strong><small>Workspace owner</small></div><MoreHorizontal size={16} /></div></div>
    </aside>
    {sidebarOpen && <button className="drawer-overlay" onClick={() => setSidebarOpen(false)} aria-label="Close sidebar" />}
     <main className="chat-main">
       <header className="chat-header"><div className="header-title"><button className="icon-button menu-button" onClick={() => setSidebarOpen(true)} aria-label="Open conversation history"><Menu size={19} /></button><div><strong>{active?.title ?? 'New conversation'}</strong><span>Private workspace · read-only mode</span></div></div><div className="header-actions">{repository && <button className="context-indicator" onClick={() => setRepositoryOpen(true)}><span className="status-dot" /> {repository.owner}/{repository.name}{contextPaths.length ? ` · ${contextPaths.length} files` : ''}</button>}<button className="resource-toggle" onClick={() => setResourceOpen((open) => !open)} aria-label="Toggle resource status"><Activity size={15} /> Resources</button><button className="repo-toggle" onClick={() => setRepositoryOpen((open) => !open)} aria-label="Toggle repository explorer"><GitBranch size={15} /> Repository</button><div className="header-status"><span className="status-dot" /> Ready</div></div></header>
       <div className="message-scroll" ref={scrollRef} onScroll={onScroll}>
         <div className="message-column">{!active?.messages.length && !proposal && !isProposing && !agentSession ? <EmptyState onPrompt={(prompt) => setDraft(prompt)} /> : <>{active?.messages.map((message) => <MessageBubble key={message.id} message={message} onRetry={() => retry(message)} onEdit={(text) => setDraft(text)} />)}{isProposing && <div className="proposal-loading"><Sparkles size={16} className="spin" /><span>Reading selected files and preparing a safe diff preview…</span></div>}{agentSession && <AgentTimeline session={agentSession} />}{proposal && <ChangeProposalReview proposal={proposal} onCancel={() => { setProposal(null); setAgentSession(null); }} onRegenerate={() => { setProposal(null); setAgentSession(null); setDraft(proposalRequest); }} onApplied={(result) => recordAppliedEvent(result)} onCommitted={(result) => recordCommittedEvent(result)} onPushed={(result) => recordPushedEvent(result)} />}</>}</div>
      </div>
       <div className="composer-wrap">{contextPaths.length > 0 && <div className="context-chips" aria-label="Selected repository context">{contextPaths.map((path) => <button key={path} onClick={() => setContextPaths((current) => current.filter((item) => item !== path))}>@{path} <X size={11} /></button>)}</div>}<form className="composer" onSubmit={handleSend}><textarea value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={onComposerKeyDown} placeholder={repository ? "Ask about this repository…" : "Ask Cosmic Agent anything…"} rows={1} aria-label="Message Cosmic Agent" /><div className="composer-bottom"><div className="composer-meta"><div className="model-picker"><button type="button" className="model-trigger" onClick={() => setModelOpen((open) => !open)} aria-haspopup="listbox" aria-expanded={modelOpen}><Sparkles size={14} /><span>{selectedModel.displayName}</span><ChevronDown size={14} /></button>{modelOpen && <div className="model-menu" role="listbox">{models.map((model) => <button type="button" role="option" aria-selected={model.id === selectedModel.id} className={model.id === selectedModel.id ? 'selected' : ''} key={model.id} onClick={() => changeModel(model.id)}><span><strong>{model.displayName}</strong><small>{model.provider} · {model.capabilities.join(' · ')}</small></span>{model.id === selectedModel.id && <Check size={15} />}</button>)}</div>}</div><span className="composer-hint">Enter to send · Shift + Enter for newline</span></div>{isStreaming || isProposing ? <button type="button" className="stop-button" onClick={() => { abortRef.current?.abort(); setIsProposing(false); }}><Square size={13} fill="currentColor" /> Stop</button> : <button type="submit" className="send-button" disabled={!draft.trim()} aria-label="Send message"><Send size={16} /></button>}</div></form><p className="composer-disclaimer">Proposal preview mode · approval never writes to the repository.</p></div>
    </main>
    <RepositoryPanel open={repositoryOpen} repository={repository} onRepositoryChange={(next) => { setRepository(next); if (!next) setContextPaths([]); }} contextPaths={contextPaths} onAddContext={(path) => setContextPaths((current) => current.includes(path) ? current : [...current, path])} onRemoveContext={(path) => setContextPaths((current) => current.filter((item) => item !== path))} onClose={() => setRepositoryOpen(false)} />
     {resourceOpen && <button className="drawer-overlay resource-overlay" onClick={() => setResourceOpen(false)} aria-label="Close resource status" />}
     <ResourceStatusPanel open={resourceOpen} onClose={() => setResourceOpen(false)} />
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
function AgentTimeline({ session }: { session: RuntimeSession }) {
  const statusLabel = session.status === 'waiting_approval' ? 'Waiting for approval' : session.status === 'failed' ? 'Stopped safely' : session.status === 'completed' ? 'Complete' : 'Running';
  return <section className="agent-timeline" aria-label="Agent execution timeline">
    <div className="agent-timeline-head"><div><span className="agent-kicker"><Activity size={12} /> Agent runtime</span><strong>{session.task}</strong></div><span className={`agent-status ${session.status}`}>{statusLabel}</span></div>
    <div className="agent-progress"><span style={{ width: `${Math.round((session.plan.filter((step) => step.status === 'complete').length / session.plan.length) * 100)}%` }} /></div>
    <div className="agent-plan">{session.plan.map((step) => <div className={`agent-step ${step.status}`} key={step.id}><span className="agent-step-mark">{step.status === 'complete' ? '✓' : step.status === 'active' ? '●' : step.status === 'blocked' ? '!' : '○'}</span><span>{step.title}</span></div>)}</div>
    <div className="agent-events">{session.events.slice(-6).map((event) => <div className="agent-event" key={event.id}><span className="agent-event-time">{new Date(event.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span><div><strong>{event.label}</strong>{event.detail && <small>{event.detail}</small>}</div></div>)}</div>
    <div className="agent-runtime-meta"><span>Iteration {session.iteration}/{session.maxIterations}</span><span>{session.toolResults.length} tool call{session.toolResults.length === 1 ? '' : 's'}</span><span>{session.context.filesIncluded} source{session.context.filesIncluded === 1 ? '' : 's'} included</span></div>
  </section>;
}
function MessageBubble({ message, onRetry, onEdit }: { message: ChatMessage; onRetry: () => void; onEdit: (text: string) => void }) {
  return <article className={`message ${message.role} ${message.error ? 'error' : ''}`}><div className="message-avatar">{message.role === 'assistant' ? <Aperture size={15} /> : 'AR'}</div><div className="message-content"><div className="message-label"><strong>{message.role === 'assistant' ? 'Cosmic Agent' : 'You'}</strong><span>{new Date(message.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span></div>{message.error ? <div className="error-panel"><p>{message.content}</p><button onClick={onRetry}><RefreshCw size={14} /> Retry</button></div> : message.role === 'assistant' ? <><Markdown content={message.content} /><SourceUsage usage={message.repositoryContext} /></> : <p className="user-text">{message.content}</p>}{message.streaming && <span className="generation-cursor" aria-label="Generating response" />}{!message.streaming && <div className="message-actions"><button onClick={() => copyText(message.content)} aria-label="Copy message"><Copy size={13} /> Copy</button>{message.role === 'assistant' ? <><button onClick={onRetry}><RefreshCw size={13} /> Regenerate</button></> : <button onClick={() => onEdit(message.content)}><Pencil size={13} /> Edit</button>}</div>}</div></article>;
}
function friendlyError(message: string) { const lower = message.toLowerCase(); if (lower.includes('rate') || lower.includes('limit')) return 'The provider is temporarily busy. Please wait a moment and try again.'; if (lower.includes('unavailable') || lower.includes('configured')) return 'This model is unavailable right now. Try another model from the selector.'; return 'We could not reach the provider. Check your connection and try again.'; }
function isCodingRequest(text: string) { return /^(fix|add|change|update|remove|refactor|implement|make|improve|replace|rename|create)\b/i.test(text.trim()) || /\b(bug|feature|component|screen|login|patch|edit)\b/i.test(text); }
function Router() { return <ErrorBoundary><Switch><Route path="/" component={Home} /><Route component={NotFound} /></Switch></ErrorBoundary>; }
function App() { return <QueryClientProvider client={queryClient}><TooltipProvider><WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, '')}><Router /></WouterRouter><Toaster /></TooltipProvider></QueryClientProvider>; }
export default App;