import {
  Component,
  type ComponentType,
  type ErrorInfo,
  type ReactNode,
} from 'react';
import { reportBrowserError } from './browser-error-overlay';

export interface ErrorFallbackProps {
  error: Error;
  resetError: () => void;
  componentStack?: string;
}

interface ErrorBoundaryProps {
  children: ReactNode;
  FallbackComponent?: ComponentType<ErrorFallbackProps>;
  /** Changing this clears a caught error. Pass the route to recover on navigation. */
  resetKey?: unknown;
}

interface ErrorBoundaryState {
  error: Error | null;
  componentStack?: string;
}

function toError(value: unknown): Error {
  if (value instanceof Error) {
    return value;
  }
  if (typeof value === 'string') {
    return new Error(value);
  }
  try {
    return new Error(JSON.stringify(value));
  } catch {
    return new Error(String(value));
  }
}

function DefaultFallback({ error, resetError, componentStack }: ErrorFallbackProps) {
  return (
    <div style={{ minHeight: '100vh', width: '100%', padding: '32px', background: '#fff0f0', color: '#ff0000', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace' }}>
      <div style={{ maxWidth: '1200px', margin: '0 auto' }}>
        <h1 style={{ fontSize: '36px', fontWeight: 900, margin: 0 }}>REACT ERROR</h1>
        <pre style={{ marginTop: '20px', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', fontSize: '22px', lineHeight: 1.45 }}>
          {`TYPE: ${error.name}
MESSAGE: ${error.message}

FULL STACK:
${error.stack ?? String(error)}

REACT COMPONENT STACK:
${componentStack ?? '(not provided)'}`}
        </pre>
        <button
          type="button"
          onClick={resetError}
          style={{ marginTop: '20px', background: '#ff0000', color: '#ffffff', border: 0, padding: '12px 18px', fontSize: '18px', fontWeight: 800, cursor: 'pointer' }}
        >
          Try again
        </button>
      </div>
    </div>
  );
}

export class ErrorBoundary extends Component<
  ErrorBoundaryProps,
  ErrorBoundaryState
> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: unknown): ErrorBoundaryState {
    return { error: toError(error) };
  }

  componentDidCatch(error: unknown, info: ErrorInfo): void {
    const componentStack = info.componentStack ?? undefined;
    reportBrowserError(error, { source: 'React ErrorBoundary', componentStack });
    this.setState({ componentStack });
    console.error(
      'ErrorBoundary caught an error:',
      toError(error),
      info.componentStack,
    );
  }

  componentDidUpdate(prevProps: ErrorBoundaryProps): void {
    if (
      this.state.error !== null &&
      prevProps.resetKey !== this.props.resetKey
    ) {
      this.resetError();
    }
  }

  resetError = (): void => {
    this.setState({ error: null, componentStack: undefined });
  };

  render(): ReactNode {
    const { error } = this.state;
    if (error === null) {
      return this.props.children;
    }
    const Fallback = this.props.FallbackComponent ?? DefaultFallback;
    return <Fallback error={error} resetError={this.resetError} componentStack={this.state.componentStack} />;
  }
}
