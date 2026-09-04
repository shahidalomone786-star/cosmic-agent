import { useEffect, useState } from 'react';

const BROWSER_ERROR_EVENT = 'cosmic-agent-browser-error';

type BrowserHttpDetails = {
  method?: string;
  url?: string;
  requestBody?: string;
  status?: number;
  statusText?: string;
  responseHeaders?: string;
  responseBody?: string;
};

type BrowserErrorDetails = {
  source?: string;
  fileName?: string;
  lineNumber?: number;
  columnNumber?: number;
  componentStack?: string;
  rawEventMessage?: string;
  http?: BrowserHttpDetails;
};

type BrowserErrorEventDetail = {
  error: unknown;
  details?: BrowserErrorDetails;
};

type BrowserErrorReport = {
  id: string;
  capturedAt: string;
  source: string;
  type: string;
  message: string;
  stack: string;
  raw: string;
  details: BrowserErrorDetails;
};

function rawValue(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value instanceof Error) return `${value.name}: ${value.message}\n${value.stack ?? ''}`;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function errorReport(detail: BrowserErrorEventDetail): BrowserErrorReport {
  const error = detail.error;
  const errorObject = error instanceof Error ? error : undefined;
  const raw = rawValue(error);
  return {
    id: `${Date.now()}-${Math.random()}`,
    capturedAt: new Date().toISOString(),
    source: detail.details?.source ?? 'browser',
    type: errorObject?.name ?? (error === null ? 'null' : typeof error),
    message: errorObject?.message ?? (typeof error === 'string' ? error : raw),
    stack: errorObject?.stack ?? raw,
    raw,
    details: detail.details ?? {},
  };
}

export function reportBrowserError(error: unknown, details?: BrowserErrorDetails): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent<BrowserErrorEventDetail>(BROWSER_ERROR_EVENT, {
    detail: { error, details },
  }));
}

function BrowserErrorReportView({ report }: { report: BrowserErrorReport }) {
  const http = report.details.http;
  return (
    <article style={{ borderTop: '3px solid #ff0000', padding: '18px 0' }}>
      <div style={{ fontSize: '22px', fontWeight: 900, marginBottom: '8px' }}>
        {report.type}: {report.message}
      </div>
      <pre style={{ margin: '8px 0', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', fontSize: '18px', lineHeight: 1.45 }}>
        {`SOURCE: ${report.source}
CAPTURED: ${report.capturedAt}
FILE: ${report.details.fileName ?? '(not provided)'}
LINE: ${report.details.lineNumber ?? '(not provided)'}
COLUMN: ${report.details.columnNumber ?? '(not provided)'}

FULL STACK:
${report.stack}

RAW BROWSER ERROR:
${report.raw}`}
      </pre>
      {report.details.rawEventMessage !== undefined && (
        <pre style={{ margin: '8px 0', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', fontSize: '18px' }}>
          {`RAW EVENT MESSAGE:
${report.details.rawEventMessage}`}
        </pre>
      )}
      {report.details.componentStack !== undefined && (
        <pre style={{ margin: '8px 0', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', fontSize: '18px' }}>
          {`REACT COMPONENT STACK:
${report.details.componentStack}`}
        </pre>
      )}
      {http && (
        <pre style={{ margin: '8px 0', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', fontSize: '18px' }}>
          {`HTTP REQUEST:
METHOD: ${http.method ?? '(not provided)'}
URL: ${http.url ?? '(not provided)'}
REQUEST BODY:
${http.requestBody ?? '(not provided)'}

HTTP RESPONSE:
STATUS: ${http.status ?? '(not provided)'}
STATUS TEXT: ${http.statusText ?? '(not provided)'}
HEADERS:
${http.responseHeaders ?? '(not provided)'}
RAW RESPONSE BODY:
${http.responseBody ?? '(not provided)'}`}
        </pre>
      )}
    </article>
  );
}

export function BrowserErrorOverlay() {
  const [reports, setReports] = useState<BrowserErrorReport[]>([]);

  useEffect(() => {
    const onReportedError = (event: Event) => {
      const detail = (event as CustomEvent<BrowserErrorEventDetail>).detail;
      if (detail) setReports((current) => [...current, errorReport(detail)]);
    };
    const onWindowError = (event: ErrorEvent) => {
      reportBrowserError(event.error ?? event.message, {
        source: 'window.error',
        fileName: event.filename,
        lineNumber: event.lineno,
        columnNumber: event.colno,
        rawEventMessage: event.message,
      });
    };
    const onUnhandledRejection = (event: PromiseRejectionEvent) => {
      reportBrowserError(event.reason, { source: 'window.unhandledrejection' });
    };

    window.addEventListener(BROWSER_ERROR_EVENT, onReportedError);
    window.addEventListener('error', onWindowError);
    window.addEventListener('unhandledrejection', onUnhandledRejection);
    return () => {
      window.removeEventListener(BROWSER_ERROR_EVENT, onReportedError);
      window.removeEventListener('error', onWindowError);
      window.removeEventListener('unhandledrejection', onUnhandledRejection);
    };
  }, []);

  if (!reports.length) return null;
  return (
    <aside
      role="alert"
      aria-live="assertive"
      style={{
        position: 'fixed',
        inset: '12px',
        zIndex: 2147483647,
        overflow: 'auto',
        background: '#fff0f0',
        border: '8px solid #ff0000',
        color: '#ff0000',
        padding: '20px',
        boxShadow: '0 0 0 9999px rgba(255, 255, 255, 0.94), 0 12px 48px rgba(128, 0, 0, 0.45)',
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
      }}
    >
      <div style={{ fontSize: '32px', fontWeight: 900, marginBottom: '4px' }}>
        BROWSER ERROR CAPTURE
      </div>
      <div style={{ fontSize: '20px', fontWeight: 800, marginBottom: '8px' }}>
        {reports.length} error{reports.length === 1 ? '' : 's'} captured. Original diagnostic data follows.
      </div>
      {reports.map((report) => <BrowserErrorReportView key={report.id} report={report} />)}
    </aside>
  );
}