import { AlertCircle, ArrowLeft } from 'lucide-react';
import { Link } from 'wouter';

export default function NotFound() {
  return (
    <main className="not-found-shell" data-testid="page-not-found">
      <section className="not-found-card" role="alert">
        <div className="not-found-orbit" aria-hidden="true"><AlertCircle size={26} /></div>
        <span className="repo-kicker">COSMIC AGENT / NAVIGATION</span>
        <h1>That route is outside the observatory.</h1>
        <p>We could not find the workspace surface you requested. Your sessions and repository context remain untouched.</p>
        <Link href="/" className="not-found-link" data-testid="link-return-home"><ArrowLeft size={15} /> Return to workspace</Link>
      </section>
    </main>
  );
}