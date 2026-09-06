import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useGetControlCenter, getGetControlCenterQueryKey, type ControlCenterCategory, type ControlCenterModule, type ControlCenterSnapshot } from '@workspace/api-client-react';
import {
  Activity,
  AlertTriangle,
  ArrowLeft,
  BadgeCheck,
  BarChart3,
  CheckCircle2,
  ChevronRight,
  CircleOff,
  Clock3,
  Code2,
  Database,
  FileCode2,
  FolderOpen,
  GitBranch,
  Github,
  HardDrive,
  History,
  KeyRound,
  LayoutDashboard,
  LockKeyhole,
  Network,
  PlugZap,
  RefreshCw,
  ScrollText,
  ServerCog,
  Settings2,
  ShieldCheck,
  Terminal,
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
          <span className="control-center-kicker">COSMIC AGENT / PHASE 12.5</span>
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
        {!isLoading && !isError && data && (activeModule ? <ModuleDetail module={activeModule} integrationDetail={activeModule.id === 'integrations' ? integrationDetail?.(() => setView('integrations')) : undefined} onBack={() => setView('overview')} /> : <Overview data={data} modules={modules} restrictedCount={restrictedCount} verifiedCount={verifiedCount} isFetching={isFetching} onRefresh={() => void refetch()} onSelect={selectView} notify={notify} />)}
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

function ModuleDetail({ module, onBack, integrationDetail }: { module: ControlCenterModule; onBack: () => void; integrationDetail?: ReactNode }) {
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
    {module.id === 'integrations' && integrationDetail && <section className="control-integration-detail" data-testid="panel-control-center-integrations-detail">
      <div className="control-block-heading"><div><span className="control-section-kicker"><Github size={12} /> CONNECTED DETAIL</span><h2>GitHub credentials</h2></div><span className="control-count">sanitized status</span></div>
      {integrationDetail}
    </section>}
  </div>;
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