import { useState } from "react";
import { AlertTriangle, Check, ChevronDown, ChevronRight, Copy, FileCode2, RotateCw, ShieldCheck, X } from "lucide-react";
import { executeChangeProposal, undoChangeProposal, type ChangeExecutionResult, type ChangeProposal } from "@workspace/api-client-react";

function copyText(text: string) {
  void navigator.clipboard?.writeText(text);
}

export function ChangeProposalReview({
  proposal,
  onCancel,
  onRegenerate,
  onApplied,
}: {
  proposal: ChangeProposal;
  onCancel: () => void;
  onRegenerate: () => void;
  onApplied: (result: ChangeExecutionResult) => void;
}) {
  const [execution, setExecution] = useState<ChangeExecutionResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [openFiles, setOpenFiles] = useState<string[]>(proposal.files[0] ? [proposal.files[0].path] : []);
  const toggleFile = (path: string) => setOpenFiles((current) => current.includes(path) ? current.filter((item) => item !== path) : [...current, path]);
  const riskClass = proposal.risk.toLowerCase();
  const approve = async () => {
    setBusy(true); setError("");
    try {
      const result = await executeChangeProposal({ proposalId: proposal.proposalId });
      setExecution(result);
      if (result.status === "applied") onApplied(result);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Execution failed. No changes were applied.");
    } finally { setBusy(false); }
  };
  const undo = async () => {
    setBusy(true); setError("");
    try { await undoChangeProposal({ proposalId: proposal.proposalId }); setExecution(null); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Undo failed. The file was not changed."); }
    finally { setBusy(false); }
  };

  return <section className="proposal-review" aria-label="Proposed code change" data-testid="change-proposal-review">
    <div className="proposal-heading">
      <div>
        <div className="proposal-kicker"><ShieldCheck size={13} /> Proposal-only preview</div>
        <h3>{proposal.summary}</h3>
        <p>{proposal.explanation}</p>
      </div>
      <span className={`risk-badge ${riskClass}`}><AlertTriangle size={12} /> {proposal.risk} risk</span>
    </div>
    <div className="proposal-stats">
      <span><strong>{proposal.files.length}</strong> {proposal.files.length === 1 ? "file" : "files"} changed</span>
      <span className="added-stat">+{proposal.addedLines} added</span>
      <span className="removed-stat">−{proposal.removedLines} removed</span>
    </div>
    <div className="proposal-files">
      {proposal.files.map((file) => {
        const isOpen = openFiles.includes(file.path);
        return <div className="proposal-file" key={file.path}>
          <button className="proposal-file-toggle" onClick={() => toggleFile(file.path)} aria-expanded={isOpen}>
            {isOpen ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
            <FileCode2 size={15} />
            <span className="proposal-file-name">{file.path}</span>
            <span className="language-badge">{file.language}</span>
            <span className="file-stats"><b>+{file.addedLines}</b> <i>−{file.removedLines}</i></span>
          </button>
          {isOpen && <div className="proposal-file-body">
            <div className="proposal-file-explanation"><strong>Why this file changes</strong><span>{file.explanation}</span></div>
            <div className="diff-toolbar"><span>Unified diff · unchanged context included</span><button onClick={() => copyText(file.diff)}><Copy size={12} /> Copy diff</button></div>
            <pre className="diff-viewer" aria-label={`Diff for ${file.path}`}>{file.diff.split("\n").map((line, index) => {
              const kind = line.startsWith("+") && !line.startsWith("+++") ? "added" : line.startsWith("-") && !line.startsWith("---") ? "removed" : line.startsWith("@@") ? "hunk" : "context";
              return <code className={`diff-line ${kind}`} key={`${file.path}-${index}`}><span className="diff-marker">{kind === "added" ? "+" : kind === "removed" ? "−" : " "}</span><span>{line.slice(kind === "added" || kind === "removed" ? 1 : 0) || " "}</span></code>;
            })}</pre>
          </div>}
        </div>;
      })}
    </div>
    {busy && <div className="execution-progress" role="status"><strong>Applying Changes</strong><span className="done">✓ Validating proposal</span><span className="done">✓ Checking file versions</span><span className="active">● Applying patch</span><span>○ Running typecheck</span><span>○ Running build</span></div>}
    {execution?.status === "applied" && <div className="execution-success" role="status"><strong>Changes Applied Successfully</strong><span>{execution.message}</span><small>{execution.files.length} files modified · +{execution.addedLines} / −{execution.removedLines} lines · Typecheck: {execution.typecheck} · Build: {execution.build}</small></div>}
    {execution?.status === "validation_failed" && <div className="execution-failure" role="alert"><strong>Changes Applied — Validation Failed</strong><span>{execution.message}</span><small>Affected files: {execution.files.join(", ")}</small></div>}
    {error && <div className="execution-failure" role="alert"><strong>Execution stopped safely</strong><span>{error}</span></div>}
    {!execution && !busy && <div className="proposal-safety"><ShieldCheck size={15} /><span>Nothing has been written. Approval sends only this server-held proposal ID for validation and execution.</span></div>}
    <div className="proposal-actions">
      {execution?.status === "applied" && execution.canUndo && <button className="proposal-undo" onClick={undo} disabled={busy}><RotateCw size={14} /> Undo changes</button>}
      <button className="proposal-cancel" onClick={onCancel} disabled={busy}><X size={14} /> {execution?.status === "applied" ? "Continue chat" : "Cancel"}</button>
      {!execution && <><button className="proposal-regenerate" onClick={onRegenerate} disabled={busy}><RotateCw size={14} /> Regenerate</button><button className="proposal-approve" onClick={() => void approve()} disabled={busy}><Check size={14} /> {busy ? "Applying…" : "Approve changes"}</button></>}
    </div>
  </section>;
}