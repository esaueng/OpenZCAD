import { Component, type ErrorInfo, type ReactNode } from 'react';
import { isChunkLoadError, STALE_CHUNK_MESSAGE } from '../lib/staleChunk';
import { BrandMark } from './BrandMark';

interface ErrorBoundaryProps {
  children: ReactNode;
  label: string;
  resetKey?: string | number;
  fallback?: ReactNode;
  /**
   * `page` when the boundary wraps the whole app: its fallback is then the
   * only thing on screen, so it takes the viewport rather than a panel strip.
   */
  scope?: 'panel' | 'page';
}

interface ErrorBoundaryState {
  failed: boolean;
  staleChunk?: boolean;
  message?: string;
}

const reload = () => window.location.reload();

export class ErrorBoundary extends Component<
  ErrorBoundaryProps,
  ErrorBoundaryState
> {
  override state: ErrorBoundaryState = { failed: false };

  static getDerivedStateFromError(error: unknown): ErrorBoundaryState {
    return {
      failed: true,
      staleChunk: isChunkLoadError(error),
      message: error instanceof Error ? error.message : String(error)
    };
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
    if (this.props.scope === 'page') {
      return this.renderPage();
    }
    return (
      <section className="error-boundary" role="alert">
        <strong>{this.props.label} could not be rendered.</strong>
        <span>
          {this.state.staleChunk
            ? STALE_CHUNK_MESSAGE
            : 'Your document is still available. Reload to recover this panel.'}
        </span>
        <button type="button" className="secondary" onClick={reload}>
          Reload workspace
        </button>
      </section>
    );
  }

  private renderPage() {
    const stale = this.state.staleChunk === true;
    return (
      <main
        className="error-page"
        data-variant={stale ? 'update' : 'crash'}
        role="alert"
        aria-labelledby="error-page-title"
      >
        <div className="error-page-card">
          <span className="error-page-mark">
            <BrandMark />
          </span>
          <span className="error-page-eyebrow">
            {stale ? 'Update available' : 'Something went wrong'}
          </span>
          <h1 id="error-page-title">
            {stale
              ? 'OpenZCAD has been updated'
              : `${this.props.label} could not be rendered.`}
          </h1>
          <p>
            {stale
              ? 'A new version was released while this tab was open, and this tab can no longer load the parts it needs. Reload to continue on the new version.'
              : 'An unexpected error stopped the workspace. Reload to recover.'}
          </p>
          <p className="error-page-note">
            OpenZCAD autosaves as you work, and reloading reopens your projects
            from this device.
          </p>
          <button
            type="button"
            className="primary error-page-action"
            onClick={reload}
            autoFocus
          >
            {stale ? 'Reload to update' : 'Reload workspace'}
          </button>
          {!stale && this.state.message ? (
            <details className="error-page-details">
              <summary>Error details</summary>
              <code>{this.state.message}</code>
            </details>
          ) : null}
        </div>
      </main>
    );
  }
}
