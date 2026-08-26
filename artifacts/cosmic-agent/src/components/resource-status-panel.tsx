import { Activity, Database, Gauge, Layers3, LoaderCircle, X } from "lucide-react";
import { type ResourceStatus, useGetAiResources } from "@workspace/api-client-react";

function stateLabel(value: string): string {
  return value.replaceAll("_", " ");
}

export function ResourceStatusPanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { data, isLoading, isError } = useGetAiResources({ query: { refetchInterval: 15_000 } as never });
  return <aside className={`resource-panel ${open ? "is-open" : ""}`} aria-label="Resource status">
    <div className="resource-panel-head"><div><span className="repo-kicker"><Activity size={12} /> Resource intelligence</span><strong>Runtime resources</strong></div><button className="icon-button resource-close" onClick={onClose} aria-label="Close resource status"><X size={17} /></button></div>
    {isLoading ? <div className="repo-loading"><LoaderCircle className="spin" size={15} /> Checking resources</div> : isError || !data ? <div className="repo-error">Resource status is temporarily unavailable.</div> : <div className="resource-content">
      <ResourceSection icon={<Gauge size={14} />} title="AI resources">
        <ResourceRow label="Groq" value={stateLabel(data.ai.status)} tone={data.ai.status} />
        <ResourceRow label="Configured keys" value={`${data.ai.configuredKeyCount}`} />
        <ResourceRow label="Available keys" value={`${data.ai.availableKeyCount}`} />
        <div className="resource-key-list">{data.ai.keys.map((key) => <span key={key.id} className={`resource-key ${key.status}`}><i />{key.id} · {stateLabel(key.status)}</span>)}</div>
      </ResourceSection>
      <ResourceSection icon={<Database size={14} />} title="GitHub">
        <ResourceRow label="API" value={data.github.message} tone={data.github.api} />
        <ResourceRow label="Cache" value={`${stateLabel(data.github.cache.status)} · ${data.github.cache.hits} hits`} />
        {data.github.remaining !== null && <ResourceRow label="Remaining" value={`${data.github.remaining}${data.github.limit ? ` / ${data.github.limit}` : ""}`} />}
      </ResourceSection>
      <ResourceSection icon={<Layers3 size={14} />} title="Context">
        <ResourceRow label="Files included" value={`${data.context.filesIncluded}`} />
        <ResourceRow label="Approx. size" value={`${Math.round(data.context.approximateChars / 1000)}k characters`} />
        <ResourceRow label="Chunking" value={data.context.chunked ? "Active" : "Not needed"} />
        {data.context.lastWarnings.map((warning) => <p className="resource-warning" key={warning}>{warning}</p>)}
      </ResourceSection>
      <p className="resource-safe-note"><Activity size={12} /> Server-side telemetry only. Secrets and credentials are never displayed.</p>
    </div>}
  </aside>;
}

function ResourceSection({ icon, title, children }: { icon: React.ReactNode; title: string; children: React.ReactNode }) {
  return <section className="resource-section"><h3>{icon}{title}</h3><div className="resource-section-body">{children}</div></section>;
}

function ResourceRow({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return <div className="resource-row"><span>{label}</span><strong className={tone ? `tone-${tone}` : ""}>{value}</strong></div>;
}