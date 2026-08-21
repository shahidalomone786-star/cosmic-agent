import { type RepositoryOverview as RepositoryOverviewData, type RepositoryRef, useGetRepositoryOverview } from "@workspace/api-client-react";
import { ArrowRight, Boxes, CircleAlert, RefreshCw } from "lucide-react";

type RepositoryOverviewProps = {
  repository: RepositoryRef;
  contextPaths: string[];
  onAddContext: (path: string) => void;
  onRemoveContext: (path: string) => void;
};

function OverviewList({ items, empty, file, contextPaths, onAddContext, onRemoveContext }: { items: string[]; empty: string; file?: boolean; contextPaths?: string[]; onAddContext?: (path: string) => void; onRemoveContext?: (path: string) => void }) {
  if (!items.length) return <div className="overview-empty" data-testid="empty-overview-list">{empty}</div>;
  return <div className="overview-list">{items.slice(0, 12).map((item) => {
    const selected = contextPaths?.includes(item);
    return file && onAddContext && onRemoveContext
      ? <button className={`overview-pill file-pill context-file-pill ${selected ? "selected" : ""}`} onClick={() => selected ? onRemoveContext(item) : onAddContext(item)} data-testid={`overview-item-${item}`} key={item} title={item}>{selected ? "@" : "+"} {item}</button>
      : <span className={`overview-pill ${file ? "file-pill" : ""}`} data-testid={`overview-item-${item}`} key={item} title={item}>{item}</span>;
  })}</div>;
}

function OverviewSkeleton() {
  return <div className="overview-skeleton" aria-label="Loading repository overview" data-testid="loading-repository-overview"><span /><span /><span /><span /><span /></div>;
}

function OverviewContent({ overview, contextPaths, onAddContext, onRemoveContext }: { overview: RepositoryOverviewData; contextPaths: string[]; onAddContext: (path: string) => void; onRemoveContext: (path: string) => void }) {
  const categoryGroups = overview.files.reduce<Record<string, typeof overview.files>>((groups, file) => {
    (groups[file.category] ??= []).push(file);
    return groups;
  }, {});
  const categoryLabels: Record<string, string> = {
    "react-component": "React components",
    "typescript-javascript": "TypeScript / JavaScript",
    "api-server": "API / server",
    authentication: "Authentication",
    database: "Database",
    configuration: "Configuration",
    styling: "Styling",
    test: "Tests",
    documentation: "Documentation",
    package: "Package metadata",
    other: "Other",
  };
  return <div data-testid="repository-overview-content">
    <div className="overview-heading">
      <div><h2>Repository overview</h2><p>Cached intelligence for a read-only workspace</p></div>
    </div>
    <div className="overview-stats">
      <div className="overview-stat"><strong>{overview.fileCount}</strong><span>files indexed</span></div>
      <div className="overview-stat"><strong>{overview.sourceCount}</strong><span>source files</span></div>
      <div className="overview-stat"><strong>{overview.configCount}</strong><span>config files</span></div>
      <div className="overview-stat"><strong>{overview.testCount}</strong><span>test files</span></div>
    </div>
    <div className="overview-meta">
      <div><span>Language</span><strong>{overview.language || "Not detected"}</strong></div>
      <div><span>Framework</span><strong>{overview.framework || "Not detected"}</strong></div>
      <div><span>Package manager</span><strong>{overview.packageManager || "Not detected"}</strong></div>
      <div><span>Branch</span><strong>{overview.repository.branch}</strong></div>
    </div>
    <section className="overview-section">
      <h3>Architecture layers</h3>
      {overview.architecture.length ? <div className="overview-architecture">{overview.architecture.map((layer) => <div className="architecture-layer" data-testid={`architecture-layer-${layer.layer}`} key={layer.layer}><strong>{layer.layer}</strong><div className="architecture-paths">{layer.paths.slice(0, 8).map((path) => <button key={path} onClick={() => contextPaths.includes(path) ? onRemoveContext(path) : onAddContext(path)} className={contextPaths.includes(path) ? "selected" : ""} title={`Add ${path} to chat context`}>{contextPaths.includes(path) ? "@" : "+"} {path}</button>)}</div></div>)}</div> : <div className="overview-empty">No layer relationships were detected in the indexed files.</div>}
    </section>
    <section className="overview-section">
      <h3>Relationships</h3>
      {overview.dependencies.length ? <div className="dependency-list">{overview.dependencies.slice(0, 12).map((dependency, index) => <div className="dependency-row" data-testid={`dependency-${index}`} key={`${dependency.from}-${dependency.to}-${index}`}><span title={dependency.from}>{dependency.from}</span><ArrowRight size={12} /><span title={dependency.to}>{dependency.to}</span></div>)}</div> : <div className="overview-empty">No dependency relationships were returned.</div>}
    </section>
    <section className="overview-section">
      <h3>Entry points</h3>
      <OverviewList items={overview.entryPoints} empty="No entry points identified." file />
    </section>
    <section className="overview-section">
      <h3>Important files</h3>
      <OverviewList items={[...overview.authenticationFiles, ...overview.apiFiles, ...overview.databaseFiles]} empty="No authentication, API, or database files identified." file contextPaths={contextPaths} onAddContext={onAddContext} onRemoveContext={onRemoveContext} />
    </section>
    <section className="overview-section">
      <h3>File classification</h3>
      {Object.keys(categoryGroups).length ? <div className="file-classification">{Object.entries(categoryGroups).map(([category, files]) => <div className="classification-group" key={category} data-testid={`classification-${category}`}><div className="classification-heading"><strong>{categoryLabels[category] ?? category}</strong><span>{files.length}</span></div><div className="overview-list">{files.slice(0, 10).map((file) => <button className={`overview-pill file-pill context-file-pill ${contextPaths.includes(file.path) ? "selected" : ""}`} onClick={() => contextPaths.includes(file.path) ? onRemoveContext(file.path) : onAddContext(file.path)} key={file.path} title={`${file.path} · ${file.language}${file.size ? ` · ${Math.round(file.size / 1024)} KB` : ""}`} data-testid={`classified-file-${file.path}`}>{contextPaths.includes(file.path) ? "@" : "+"} {file.path}</button>)}</div></div>)}</div> : <div className="overview-empty">No classified files were returned.</div>}
    </section>
    <section className="overview-section">
      <h3>Top directories</h3>
      <OverviewList items={overview.directories} empty="No directories returned." />
    </section>
  </div>;
}

export function RepositoryOverview({ repository, contextPaths, onAddContext, onRemoveContext }: RepositoryOverviewProps) {
  const overviewQuery = useGetRepositoryOverview();
  const overview = overviewQuery.data;
  const isPending = overviewQuery.isPending;
  const loadOverview = () => overviewQuery.mutate({ data: { repository } });

  return <div className="repo-overview" data-testid="repository-overview">
    <div className="overview-heading">
      <div><h2>Repository overview</h2><p>{repository.owner}/{repository.name} · {repository.branch}</p></div>
      <button className="overview-refresh" onClick={loadOverview} disabled={isPending} aria-label="Refresh repository overview" data-testid="button-refresh-overview"><RefreshCw size={14} className={isPending ? "spin" : ""} /></button>
    </div>
    {!overview && !overviewQuery.isError && !isPending && <div className="overview-empty" data-testid="empty-repository-overview"><Boxes size={16} /><p>Build a compact map of this repository’s structure, runtime, and relationships.</p><button className="context-button" onClick={loadOverview} data-testid="button-load-overview">Load repository intelligence</button></div>}
    {isPending && <OverviewSkeleton />}
    {overviewQuery.isError && <div className="overview-error" role="alert" data-testid="error-repository-overview"><CircleAlert size={15} /><div>Repository intelligence could not be loaded. The source browser is still available.</div><button onClick={loadOverview} data-testid="button-retry-overview"><RefreshCw size={12} /> Retry overview</button></div>}
    {overview && !isPending && <OverviewContent overview={overview} contextPaths={contextPaths} onAddContext={onAddContext} onRemoveContext={onRemoveContext} />}
  </div>;
}