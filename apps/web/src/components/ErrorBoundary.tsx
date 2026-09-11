import { Component, type ErrorInfo, type ReactNode } from 'react';
import { isChunkLoadError, STALE_CHUNK_MESSAGE } from '../lib/staleChunk';

interface ErrorBoundaryProps {
  children: ReactNode;
  label: string;
  resetKey?: string | number;
  fallback?: ReactNode;
}

interface ErrorBoundaryState {
  failed: boolean;
  staleChunk?: boolean;
}

export class ErrorBoundary extends Component<
  ErrorBoundaryProps,
  ErrorBoundaryState
> {
  override state: ErrorBoundaryState = { failed: false };

  static getDerivedStateFromError(error: unknown): ErrorBoundaryState {
    return { failed: true, staleChunk: isChunkLoadError(error) };
  }

  override componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(`${this.props.label} crashed:`, error, info.componentStack);
  }

  override componentDidUpdate(previous: ErrorBoundaryProps) {
    if (this.state.failed && previous.resetKey !== this.props.resetKey) {
      this.setState({ failed: false });
    }
  }

  override render() {
    if (!this.state.failed) {
      return this.props.children;
    }
    if (this.props.fallback !== undefined) {
      return this.props.fallback;
    }
    return (
      <section className="error-boundary" role="alert">
        <strong>{this.props.label} could not be rendered.</strong>
        <span>
          {this.state.staleChunk
            ? STALE_CHUNK_MESSAGE
            : 'Your document is still available. Reload to recover this panel.'}
        </span>
        <button type="button" onClick={() => window.location.reload()}>
          Reload workspace
        </button>
      </section>
    );
  }
}
