import { useState } from "react";
import { AlertTriangle, Check, ChevronDown, ChevronRight, Copy, FileCode2, RotateCw, ShieldCheck, X } from "lucide-react";
import {
  commitChangeProposal,
  executeChangeProposal,
  getChangeProposalCommitReview,
  getChangeProposalPushReview,
  pushChangeProposal,
  undoChangeProposal,
  type ChangeExecutionResult,
  type ChangeProposal,
  type CommitResult,
  type CommitReview,
  type PushResult,
  type PushReview,
} from "@workspace/api-client-react";

function copyText(text: string) {
  void navigator.clipboard?.writeText(text);
}

function getApiErrorCode(cause: unknown): string {
  if (!cause || typeof cause !== "object") return "";
  const data = (cause as { data?: unknown }).data;
  if (data && typeof data === "object" && typeof (data as { error?: unknown }).error === "string") {
    return (data as { error: string }).error;
  }
  return cause instanceof Error ? cause.message : "";
}

export function ChangeProposalReview({
  proposal,
  onCancel,
  onRegenerate,
  onApplied,
  onCommitted,
  onPushed,
}: {
  proposal: ChangeProposal;
  onCancel: () => void;
  onRegenerate: () => void;
  onApplied: (result: ChangeExecutionResult) => void;
  onCommitted?: (result: CommitResult) => void;
  onPushed?: (result: PushResult) => void;
}) {
  const [execution, setExecution] = useState<ChangeExecutionResult | null>(null);
  const [commitReview, setCommitReview] = useState<CommitReview | null>(null);
  const [commit, setCommit] = useState<CommitResult | null>(null);
  const [pushReview, setPushReview] = useState<PushReview | null>(null);
  const [commitMessage, setCommitMessage] = useState(`Update ${proposal.summary}`.slice(0, 200));
  const [phase, setPhase] = useState<"idle" | "commit_review" | "commit_processing" | "provider_not_configured" | "push_review" | "push_processing" | "no_push" | "success" | "conflict">("idle");
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
      if (result.status === "applied") {
        onApplied(result);
        const review = await getChangeProposalCommitReview({ proposalId: proposal.proposalId });
        setCommitReview(review);
        setPhase("commit_review");
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Execution failed. No changes were applied.");
    } finally { setBusy(false); }
  };
  const commitChanges = async () => {
    setBusy(true); setError(""); setPhase("commit_processing");
    try {
      const result = await commitChangeProposal({ proposalId: proposal.proposalId, message: commitMessage });
      setCommit(result);
      onCommitted?.(result);
      setPushReview(await getChangeProposalPushReview({ proposalId: proposal.proposalId }));
      setPhase("push_review");
    } catch (cause) {
      const message = getApiErrorCode(cause) || "Commit was cancelled safely.";
      setError(message);
      setPhase(message === "GITHUB_PROVIDER_NOT_CONFIGURED" ? "provider_not_configured" : "conflict");
    } finally { setBusy(false); }
  };
  const pushChanges = async () => {
    setBusy(true); setError(""); setPhase("push_processing");
    try {
      const result = await pushChangeProposal({ proposalId: proposal.proposalId });
      setPhase("success");
      setPushReview((current) => current ? { ...current, commitSha: result.commitSha, shortSha: result.shortSha } : current);
      onPushed?.(result);
    } catch (cause) {
      setError(getApiErrorCode(cause) || "Push was cancelled safely.");
      setPhase("conflict");
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
    {busy && <div className="execution-progress" role="status"><strong>Applying Changes</strong><span className="done"><Check size={12} /> Validating proposal</span><span className="done"><Check size={12} /> Checking file versions</span><span className="active"><RotateCw size={12} /> Applying patch</span><span><ChevronRight size={12} /> Running typecheck</span><span><ChevronRight size={12} /> Running build</span></div>}
    {execution?.status === "applied" && <div className="execution-success" role="status"><strong>Changes Applied Successfully</strong><span>{execution.message}</span><small>{execution.files.length} files modified · +{execution.addedLines} / −{execution.removedLines} lines · Typecheck: {execution.typecheck} · Build: {execution.build}</small></div>}
    {execution?.status === "validation_failed" && <div className="execution-failure" role="alert"><strong>Changes Applied — Validation Failed</strong><span>{execution.message}</span><small>Affected files: {execution.files.join(", ")}</small></div>}
    {commitReview && <section className="github-review" aria-label="Commit review">
       <div className="github-review-heading"><div><div className="proposal-kicker"><ShieldCheck size={13} /> Commit review</div><h4>{phase === "provider_not_configured" ? "Provider Not Configured" : phase === "push_review" || phase === "no_push" || phase === "success" ? "Commit approved" : "Ready to Commit"}</h4><p>{commitReview.repository.owner}/{commitReview.repository.name} · {commitReview.branch}</p></div><span className="github-state">{phase === "commit_processing" ? "Commit Approval" : phase === "push_processing" ? "Push Approval" : phase === "success" ? "Push complete" : phase === "conflict" ? "Safely stopped" : phase === "provider_not_configured" ? "Writes disabled" : phase === "push_review" ? "Push review" : phase === "no_push" ? "Push declined" : "Awaiting approval"}</span></div>
      <div className="github-review-stats"><span><strong>{commitReview.files.length}</strong> files</span><span className="added-stat">+{commitReview.addedLines}</span><span className="removed-stat">−{commitReview.removedLines}</span><span>Validation: {commitReview.validation}</span></div>
      <p className="github-diff-summary">{commitReview.diffSummary}</p>
      <div className="github-file-list">{commitReview.files.map((file) => <span key={file}>{file}</span>)}</div>
       {phase === "commit_review" || phase === "commit_processing" ? <><div className="approval-notice"><strong>Explicit commit approval required</strong><span>Review the validated files and message. The approval request sends only the server-held proposal ID and message.</span></div><label className="commit-message-label">Commit message<input value={commitMessage} onChange={(event) => setCommitMessage(event.target.value)} maxLength={200} disabled={busy} /></label><div className="github-actions"><button className="proposal-cancel" onClick={() => setPhase("idle")} disabled={busy}>Cancel commit</button><button className="proposal-approve" onClick={() => void commitChanges()} disabled={busy || !commitMessage.trim()}><Check size={14} /> {busy ? "Requesting commit…" : "Approve commit"}</button></div></> : null}
       {phase === "provider_not_configured" && <div className="execution-failure" role="alert"><strong>Provider Not Configured</strong><span>GITHUB_PROVIDER_NOT_CONFIGURED</span><small>No commit was performed. Cosmic Agent GitHub writes are disabled until a server-side provider is configured.</small></div>}
       {phase === "push_review" && pushReview && <div className="push-review"><div className="push-review-title"><strong>Push review</strong><span>Commit {pushReview.shortSha}</span></div><span>Review the approved commit before pushing it to {pushReview.repository.owner}/{pushReview.repository.name} on {pushReview.branch}.</span><div className="approval-notice"><strong>Explicit push approval required</strong><span>No push occurs until you choose the approval action below.</span></div><div className="github-actions"><button className="proposal-cancel" onClick={() => setPhase("no_push")} disabled={busy}>Do not push</button><button className="proposal-approve" onClick={() => void pushChanges()} disabled={busy}><Check size={14} /> {busy ? "Requesting push…" : "Approve push"}</button></div></div>}
       {phase === "no_push" && commit && <div className="execution-success" role="status"><strong>Push declined. Nothing was pushed.</strong><span>Commit review {commit.shortSha} remains available; no push request was made.</span></div>}
       {phase === "success" && pushReview && <div className="execution-success" role="status"><strong>GitHub Update Successful</strong><span>Commit “{pushReview.shortSha}” pushed to {pushReview.branch}.</span><small>Commit created · Push completed</small></div>}
      {phase === "conflict" && <div className="execution-failure" role="alert"><strong>Remote branch changed. Push was cancelled to protect existing work.</strong><span>{error}</span></div>}
    </section>}
    {error && <div className="execution-failure" role="alert"><strong>Execution stopped safely</strong><span>{error}</span></div>}
    {!execution && !busy && <div className="proposal-safety"><ShieldCheck size={15} /><span>Nothing has been written. Approval sends only this server-held proposal ID for validation and execution.</span></div>}
    <div className="proposal-actions">
      {execution?.status === "applied" && execution.canUndo && <button className="proposal-undo" onClick={undo} disabled={busy}><RotateCw size={14} /> Undo changes</button>}
      <button className="proposal-cancel" onClick={onCancel} disabled={busy}><X size={14} /> {execution?.status === "applied" ? "Continue chat" : "Cancel"}</button>
      {!execution && <><button className="proposal-regenerate" onClick={onRegenerate} disabled={busy}><RotateCw size={14} /> Regenerate</button><button className="proposal-approve" onClick={() => void approve()} disabled={busy}><Check size={14} /> {busy ? "Applying…" : "Approve changes"}</button></>}
    </div>
  </section>;
}