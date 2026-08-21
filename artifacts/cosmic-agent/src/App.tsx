import { type FormEvent, type ReactNode, useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ErrorBoundary } from '@/components/error-boundary';
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';
import NotFound from '@/pages/not-found';
import {
  Activity,
  Aperture,
  ArrowUpRight,
  Check,
  ChevronDown,
  CircleHelp,
  Clock3,
  Command,
  FileCode2,
  GitBranch,
  Info,
  LayoutDashboard,
  Menu,
  MessageSquare,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRight,
  Plus,
  RefreshCw,
  Send,
  Settings2,
  ShieldCheck,
  Sparkles,
  X,
} from 'lucide-react';
import {
  Route,
  Switch,
  useLocation,
  Router as WouterRouter,
} from 'wouter';

const queryClient = new QueryClient();

type ActivityEvent = {
  id: string;
  title: ReactNode;
  time: string;
  muted?: boolean;
};

type Message = {
  id: string;
  author: 'you' | 'cosmic';
  time: string;
  content: ReactNode;
};

const initialActivity: ActivityEvent[] = [
  { id: 'connected', title: <>Workspace connected</>, time: 'just now' },
  { id: 'branch', title: <>Target branch selected: <strong>main</strong></>, time: 'just now' },
  { id: 'approval', title: <>Waiting for your task</>, time: 'next step', muted: true },
];

const initialMessages: Message[] = [
  {
    id: 'welcome',
    author: 'cosmic',
    time: 'now',
    content: <>I’m ready when you are. Share a task and I’ll turn it into a reviewable plan before anything else.</>,
  },
];

const suggestions = [
  'Tighten the empty state',
  'Trace the auth flow',
  'Add coverage for a bug',
];

function Home() {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [activityOpen, setActivityOpen] = useState(false);
  const [connectOpen, setConnectOpen] = useState(false);
  const [approvalOpen, setApprovalOpen] = useState(false);
  const [repository, setRepository] = useState('northstar / web-console');
  const [branch, setBranch] = useState('main');
  const [draft, setDraft] = useState('');
  const [messages, setMessages] = useState<Message[]>(initialMessages);
  const [activity, setActivity] = useState<ActivityEvent[]>(initialActivity);
  const [toast, setToast] = useState('');

  const notify = (message: string) => {
    setToast(message);
    window.setTimeout(() => setToast(''), 2600);
  };

  const handleSend = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const trimmed = draft.trim();
    if (!trimmed) return;
    setMessages((current) => [
      ...current,
      { id: `user-${Date.now()}`, author: 'you', time: 'now', content: trimmed },
      {
        id: `agent-${Date.now()}`,
        author: 'cosmic',
        time: 'now',
        content: <>I’ve captured that as a proposed change. I’ll outline the files, constraints, and checks for your review next.</>,
      },
    ]);
    setActivity((current) => [
      ...current.filter((item) => item.id !== 'approval'),
      { id: `plan-${Date.now()}`, title: <>Plan drafted for review</>, time: 'just now' },
      { id: 'approval', title: <>Explicit approval required</>, time: 'next step', muted: true },
    ]);
    setDraft('');
    notify('Plan staged for your review');
  };

  const chooseSuggestion = (suggestion: string) => {
    setDraft(`${suggestion} in ${repository}`);
    notify('Prompt added to the composer');
  };

  const saveConnection = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setConnectOpen(false);
    setActivity((current) => [
      { id: `connected-${Date.now()}`, title: <>Workspace connected</>, time: 'just now' },
      { id: 'branch', title: <>Target branch selected: <strong>{branch}</strong></>, time: 'just now' },
      ...current.filter((item) => item.id !== 'connected' && item.id !== 'branch'),
    ]);
    notify('Workspace details saved locally');
  };

  const approvePlan = () => {
    setApprovalOpen(false);
    setActivity((current) => [
      { id: `approved-${Date.now()}`, title: <>Approval recorded for planned activity</>, time: 'just now' },
      ...current.filter((item) => item.id !== 'approval'),
    ]);
    notify('Approval recorded — no execution has started');
  };

  const resetWorkspace = () => {
    setMessages(initialMessages);
    setActivity(initialActivity);
    setDraft('');
    notify('Workspace returned to welcome state');
  };

  return (
    <div className="cosmic-app">
      <aside className={`app-sidebar ${sidebarOpen ? 'open' : ''} ${sidebarCollapsed ? 'collapsed' : ''}`} data-testid="sidebar-navigation">
        <div className="brand-lockup">
          <div className="brand-mark" data-testid="brand-mark"><Aperture /></div>
          <span className="brand-name">COSMIC AGENT</span>
          <span className="brand-phase">P1</span>
        </div>

        <div className="sidebar-label">Workspace</div>
        <nav className="sidebar-nav" aria-label="Workspace navigation">
          <button className="sidebar-link active" onClick={() => notify('Workspace is already open')} data-testid="nav-workspace">
            <LayoutDashboard /><span>Workspace</span>
          </button>
          <button className="sidebar-link" onClick={() => notify('Conversation view is part of this workspace')} data-testid="nav-conversation">
            <MessageSquare /><span>Conversation</span><span className="sidebar-badge">1</span>
          </button>
          <button className="sidebar-link" onClick={() => setActivityOpen(true)} data-testid="nav-activity">
            <Activity /><span>Activity</span>
          </button>
        </nav>

        <div className="sidebar-label" style={{ marginTop: 25 }}>Controls</div>
        <nav className="sidebar-nav" aria-label="Workspace controls">
          <button className="sidebar-link" onClick={() => setConnectOpen(true)} data-testid="nav-repository">
            <GitBranch /><span>Repository</span>
          </button>
          <button className="sidebar-link" onClick={() => notify('Preferences are coming in a later phase')} data-testid="nav-settings">
            <Settings2 /><span>Preferences</span>
          </button>
        </nav>

        <div className="workspace-mini" data-testid="workspace-summary">
          <div className="mini-topline"><span>Current target</span><Check /></div>
          <div className="mini-repo"><span className="mini-repo-dot" />{repository}</div>
          <div className="mini-branch">{branch} · review only</div>
        </div>

        <div className="sidebar-footer">
          <div className="profile-row">
            <div className="avatar" data-testid="avatar-initials">AR</div>
            <div><div className="profile-name">Avery Rowan</div><div className="profile-role">workspace owner</div></div>
            <button className="sidebar-settings" onClick={() => notify('Profile controls are not connected')} aria-label="Open profile controls" data-testid="button-profile">
              <ChevronDown size={14} />
            </button>
          </div>
        </div>
      </aside>

      {sidebarOpen && <button className="drawer-backdrop" aria-label="Close navigation" onClick={() => setSidebarOpen(false)} data-testid="button-close-navigation" />}

      <main className="app-main">
        <header className="topbar">
          <div className="crumbs">
            <button className="mobile-menu" onClick={() => setSidebarOpen(true)} aria-label="Open navigation" data-testid="button-open-navigation"><Menu /></button>
            <span>Workspace</span><span className="crumb-divider">/</span><strong data-testid="text-page-title">New session</strong>
          </div>
          <div className="topbar-actions">
            <button className="quiet-button" onClick={() => notify('Keyboard shortcuts are not active in Phase 1')} aria-label="Keyboard shortcuts" data-testid="button-shortcuts"><Command /></button>
            <button className="quiet-button" onClick={() => notify('Help center is not connected')} aria-label="Help" data-testid="button-help"><CircleHelp /></button>
            <button className="view-activity" onClick={() => setActivityOpen(true)} data-testid="button-view-activity"><PanelRight /> Activity</button>
            <button className="secondary-button" onClick={() => setConnectOpen(true)} data-testid="button-connect-repository"><Plus /> Connect repository</button>
          </div>
        </header>

        <div className="main-scroll">
          <div className="welcome-grid">
            <div className="eyebrow">Mission control for software changes</div>
            <h1 className="hero-heading" data-testid="text-welcome-heading">Bring a task.<br /><em>Keep the controls.</em></h1>
            <p className="hero-copy" data-testid="text-welcome-copy">COSMIC AGENT helps you move from a repository and a clear brief to an auditable plan. Nothing is read, changed, run, committed, or pushed without an explicit next step.</p>

            <section className="command-panel" aria-label="Task composer">
              <div className="panel-top">
                <div className="panel-title"><Sparkles /> Start a workspace conversation</div>
                <div className="status-chip" data-testid="status-simulation">Simulation mode</div>
              </div>
              <form className="prompt-form" onSubmit={handleSend}>
                <textarea
                  className="prompt-textarea"
                  value={draft}
                  onChange={(event) => setDraft(event.target.value)}
                  placeholder="Describe the change you want to reason through…"
                  aria-label="Describe a software change"
                  data-testid="input-task-prompt"
                />
                <div className="prompt-footer">
                  <div className="prompt-hint"><Info /> No repository activity will occur in this phase.</div>
                  <button className="primary-button" type="submit" data-testid="button-send-task">Draft a plan <Send /></button>
                </div>
              </form>
              <div className="suggestion-row">
                {suggestions.map((suggestion) => (
                  <button className="suggestion" key={suggestion} type="button" onClick={() => chooseSuggestion(suggestion)} data-testid={`button-suggestion-${suggestion.toLowerCase().replaceAll(' ', '-')}`}>
                    {suggestion}
                  </button>
                ))}
              </div>
            </section>

            <div className="surface-grid">
              <section className="conversation-section" aria-label="Conversation">
                <div className="section-heading"><h2>Conversation</h2><span data-testid="text-message-count">{messages.length} messages</span></div>
                <div className="conversation-card" data-testid="conversation-card">
                  {messages.map((message) => (
                    <div className="conversation-item" key={message.id} data-testid={`message-${message.id}`}>
                      <div className={`message-avatar ${message.author === 'cosmic' ? 'agent' : ''}`}>{message.author === 'cosmic' ? <Aperture size={13} /> : 'AR'}</div>
                      <div className="message-body">
                        <div className="message-meta"><strong>{message.author === 'cosmic' ? 'Cosmic Agent' : 'You'}</strong><time>{message.time}</time></div>
                        <p>{message.content}</p>
                      </div>
                    </div>
                  ))}
                </div>
                <div className="trust-banner" data-testid="trust-banner">
                  <ShieldCheck />
                  <p><strong>Approval is the boundary.</strong> Plans are simulated here. An approval records intent only; it does not authorize hidden execution.</p>
                </div>
              </section>

              <aside className="activity-column" aria-label="Activity">
                <ActivityPanel activity={activity} onClear={() => { setActivity([]); notify('Activity cleared'); }} onReview={() => setApprovalOpen(true)} />
              </aside>
            </div>
          </div>
        </div>
      </main>

      {activityOpen && (
        <>
          <button className="drawer-backdrop" aria-label="Close activity drawer" onClick={() => setActivityOpen(false)} data-testid="button-close-activity" />
          <aside className="activity-drawer" aria-label="Activity drawer">
            <div className="drawer-head"><strong>Planned activity</strong><button className="drawer-close" onClick={() => setActivityOpen(false)} aria-label="Close activity" data-testid="button-dismiss-activity"><X /></button></div>
            <ActivityPanel activity={activity} onClear={() => { setActivity([]); notify('Activity cleared'); }} onReview={() => setApprovalOpen(true)} />
          </aside>
        </>
      )}

      {connectOpen && (
        <div className="modal-backdrop" role="presentation">
          <form className="modal" onSubmit={saveConnection} role="dialog" aria-modal="true" aria-labelledby="connect-title">
            <div className="modal-head">
              <div><h3 id="connect-title">Set a workspace target</h3><p>This only changes the simulated session context.</p></div>
              <button type="button" className="modal-close" onClick={() => setConnectOpen(false)} aria-label="Close repository dialog" data-testid="button-close-connect"><X size={17} /></button>
            </div>
            <div className="modal-body">
              <label className="field-label" htmlFor="repository">Repository reference</label>
              <input className="field-input" id="repository" value={repository} onChange={(event) => setRepository(event.target.value)} data-testid="input-repository" />
              <label className="field-label" htmlFor="branch" style={{ marginTop: 17 }}>Target branch</label>
              <input className="field-input" id="branch" value={branch} onChange={(event) => setBranch(event.target.value)} data-testid="input-branch" />
              <div className="modal-note"><Info /><span>Phase 1 stores these labels in the current browser session. No repository is accessed.</span></div>
            </div>
            <div className="modal-actions"><button type="button" className="secondary-button" onClick={() => setConnectOpen(false)} data-testid="button-cancel-connect">Cancel</button><button type="submit" className="primary-button" data-testid="button-save-connect">Save target <Check /></button></div>
          </form>
        </div>
      )}

      {approvalOpen && (
        <div className="modal-backdrop" role="presentation">
          <div className="modal" role="dialog" aria-modal="true" aria-labelledby="approval-title">
            <div className="modal-head">
              <div><h3 id="approval-title">Approve planned activity?</h3><p>Review the boundary before recording your intent.</p></div>
              <button className="modal-close" onClick={() => setApprovalOpen(false)} aria-label="Close approval dialog" data-testid="button-close-approval"><X size={17} /></button>
            </div>
            <div className="modal-body">
              <div className="trust-banner" style={{ marginTop: 0 }}><ShieldCheck /><p><strong>Safe by design.</strong> This records an approval for the simulated plan only. It will not read files, edit code, execute commands, run tests, create commits, or push changes.</p></div>
            </div>
            <div className="modal-actions"><button className="secondary-button" onClick={() => setApprovalOpen(false)} data-testid="button-cancel-approval">Keep reviewing</button><button className="primary-button" onClick={approvePlan} data-testid="button-approve-plan">Record approval <Check /></button></div>
          </div>
        </div>
      )}

      {toast && <div className="toast-note" role="status" data-testid="status-toast">{toast}</div>}
      <button className="quiet-button" onClick={() => { setSidebarCollapsed((value) => !value); }} aria-label="Toggle sidebar" data-testid="button-toggle-sidebar" style={{ position: 'fixed', bottom: 15, left: sidebarCollapsed ? 77 : 273, zIndex: 35, background: 'hsl(var(--card))', border: '1px solid hsl(var(--border))' }}>
        {sidebarCollapsed ? <PanelLeftOpen size={15} /> : <PanelLeftClose size={15} />}
      </button>
    </div>
  );
}

function ActivityPanel({ activity, onClear, onReview }: { activity: ActivityEvent[]; onClear: () => void; onReview: () => void }) {
  return (
    <div className="activity-card">
      <div className="section-heading">
        <h2>Planned activity</h2>
        <button className="quiet-button" onClick={onClear} aria-label="Clear activity" data-testid="button-clear-activity" style={{ color: 'hsl(var(--sidebar-foreground) / .45)', padding: 2 }}><RefreshCw size={12} /></button>
      </div>
      <div className="activity-list" data-testid="activity-list">
        {activity.length === 0 ? (
          <div className="activity-text" data-testid="empty-activity"><strong>No activity yet.</strong><span className="activity-time">A new plan will appear here.</span></div>
        ) : activity.map((item) => (
          <div className="activity-item" key={item.id} data-testid={`activity-${item.id}`}>
            <div className={`activity-dot ${item.muted ? 'muted' : ''}`} />
            <div className="activity-text">{item.title}<span className="activity-time">{item.time}</span></div>
          </div>
        ))}
        {activity.some((item) => item.id === 'approval') && (
          <button className="primary-button" onClick={onReview} data-testid="button-review-approval" style={{ width: '100%', marginTop: 15, padding: '8px 10px', fontSize: 10 }}>
            Review approval boundary <ArrowUpRight size={13} />
          </button>
        )}
      </div>
    </div>
  );
}

function Router() {
  return (
    <RoutedErrorBoundary>
      <Switch>
        <Route path="/" component={Home} />
        <Route component={NotFound} />
      </Switch>
    </RoutedErrorBoundary>
  );
}

function RoutedErrorBoundary({ children }: { children: ReactNode }) {
  const [location] = useLocation();
  return <ErrorBoundary resetKey={location}>{children}</ErrorBoundary>;
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, '')}>
          <Router />
        </WouterRouter>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;