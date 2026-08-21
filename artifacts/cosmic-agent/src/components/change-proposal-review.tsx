import { useState } from "react";
import { AlertTriangle, Check, ChevronDown, ChevronRight, Copy, FileCode2, RotateCw, ShieldCheck, X } from "lucide-react";
import type { ChangeProposal } from "@workspace/api-client-react";

function copyText(text: string) {
  void navigator.clipboard?.writeText(text);
}

export function ChangeProposalReview({
  proposal,
  onCancel,
  onRegenerate,
}: {
  proposal: ChangeProposal;
  onCancel: () => void;
  onRegenerate: () => void;
}) {
  const [approved, setApproved] = useState(false);
  const [openFiles, setOpenFiles] = useState<string[]>(proposal.files[0] ? [proposal.files[0].path] : []);
  const toggleFile = (path: string) => setOpenFiles((current) => current.includes(path) ? current.filter((item) => item !== path) : [...current, path]);
  const riskClass = proposal.risk.toLowerCase();

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
    <div className="proposal-safety"><ShieldCheck size={15} /><span>Nothing has been written. Approval only records your review decision and leaves the repository unchanged.</span></div>
    <div className="proposal-actions">
      <button className="proposal-cancel" onClick={onCancel} disabled={approved}><X size={14} /> Cancel</button>
      <button className="proposal-regenerate" onClick={onRegenerate} disabled={approved}><RotateCw size={14} /> Regenerate</button>
      <button className={`proposal-approve ${approved ? "approved" : ""}`} onClick={() => setApproved(true)} disabled={approved}>{approved ? <><Check size={14} /> Approved — ready for execution</> : <><Check size={14} /> Approve changes</>}</button>
    </div>
  </section>;
}