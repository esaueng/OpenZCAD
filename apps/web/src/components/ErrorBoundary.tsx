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
  /** A remount is scheduled; render nothing rather than flash the card. */
  recovering?: boolean;
}

const reload = () => window.location.reload();

/**
 * A panel crash is remounted once on its own before the card is shown, so a
 * transient render failure does not cost the session. A second crash inside
 * this window is treated as persistent and left to the user.
 */
export const PANEL_AUTO_RETRY_WINDOW_MS = 30_000;
/** Lets the state that tripped the render settle before the remount. */
export const PANEL_AUTO_RETRY_DELAY_MS = 250;

export class ErrorBoundary extends Component<
  ErrorBoundaryProps,
  ErrorBoundaryState
> {
  override state: ErrorBoundaryState = { failed: false };
  private lastAutoRetryAt = Number.NEGATIVE_INFINITY;
  private retryTimer: number | undefined;

  static getDerivedStateFromError(error: unknown): ErrorBoundaryState {
    return {
      failed: true,
      staleChunk: isChunkLoadError(error),
      message: error instanceof Error ? error.message : String(error)
    };
  }

  override componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(`${this.props.label} crashed:`, error, info.componentStack);
    // A failed chunk download stays cached in the module map until
    // navigation, so a remount cannot fix it. Remounting the whole app would
    // rerun its startup, which a reload does more reliably.
    if (this.props.scope === 'page' || isChunkLoadError(error)) return;
    const now = Date.now();
    if (now - this.lastAutoRetryAt < PANEL_AUTO_RETRY_WINDOW_MS) return;
    this.lastAutoRetryAt = now;
    this.setState({ recovering: true });
    window.clearTimeout(this.retryTimer);
    this.retryTimer = window.setTimeout(this.retry, PANEL_AUTO_RETRY_DELAY_MS);
  }

  override componentDidUpdate(previous: ErrorBoundaryProps) {
    if (this.state.failed && previous.resetKey !== this.props.resetKey) {
      this.retry();
    }
  }

  override componentWillUnmount() {
    window.clearTimeout(this.retryTimer);
  }

  /** Remounts the children in place; the rest of the workspace is untouched. */
  private readonly retry = () => {
    window.clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    this.setState({ failed: false, recovering: false });
  };

  override render() {
    if (!this.state.failed) {
      return this.props.children;
    }
    if (this.state.recovering) {
      return null;
    }
    if (this.props.fallback !== undefined) {
      return this.props.fallback;
    }
    if (this.props.scope === 'page') {
      return this.renderPage();
    }
    if (this.state.staleChunk) {
      return (
        <section className="error-boundary" role="alert">
          <strong>{this.props.label} could not be rendered.</strong>
          <span>{STALE_CHUNK_MESSAGE}</span>
          <button type="button" className="secondary" onClick={reload}>
            Reload workspace
          </button>
        </section>
      );
    }
    return (
      <section className="error-boundary" role="alert">
        <strong>{this.props.label} could not be rendered.</strong>
        <span>
          Your document and the rest of the workspace are still available. Try
          again to restore this panel, or reload the workspace.
        </span>
        <button type="button" className="primary" onClick={this.retry}>
          Try again
        </button>
        <button type="button" className="secondary" onClick={reload}>
          Reload workspace
        </button>
      </section>
    );
  }

  private renderPage() {
    const stale = this.state.staleChunk === true;
    return (
      // The page keeps its main landmark; only the message is the alert, so
      // the card is not announced whole on top of its focused Reload button.
      <main
        className="error-page"
        data-variant={stale ? 'update' : 'crash'}
        aria-labelledby="error-page-title"
      >
        <div className="error-page-card">
          <span className="error-page-mark">
            <BrandMark />
          </span>
          <span className="error-page-eyebrow">
            {stale ? 'Loading interrupted' : 'Something went wrong'}
          </span>
          <h1 id="error-page-title">
            {stale
              ? 'Part of OpenZCAD could not load'
              : `${this.props.label} could not be rendered.`}
          </h1>
          <p role="alert">
            {stale
              ? STALE_CHUNK_MESSAGE
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
            Reload workspace
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
