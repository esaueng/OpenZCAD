import { useEffect, useRef } from 'react';
import { Link2, Link2Off, LoaderCircle, RotateCw } from 'lucide-react';
import { BrandMark } from './BrandMark';
import { useModalFocus } from '../lib/useModalFocus';

export type SharePageState =
  | { phase: 'loading' }
  | {
      phase: 'error';
      title: string;
      message: string;
      guidance: string;
      /** A transient failure: retrying the same link can succeed. */
      retryable: boolean;
    };

/** A share destination stays visible until it opens or the visitor leaves. */
export function SharePage({
  state,
  onRetry,
  onBack,
  onReturnToModel
}: {
  state: SharePageState;
  onRetry?: () => void;
  onBack: () => void;
  onReturnToModel?: () => void;
}) {
  const heading = useRef<HTMLHeadingElement>(null);
  const page = useRef<HTMLElement>(null);
  useModalFocus(page, { enabled: Boolean(onReturnToModel) });
  useEffect(() => {
    const previousTitle = document.title;
    document.title = 'Shared model · OpenZCAD';
    return () => {
      document.title = previousTitle;
    };
  }, []);
  useEffect(() => {
    heading.current?.focus();
  }, [state]);
  const loading = state.phase === 'loading';
  // A link that is gone or malformed stays that way; only offer retry when
  // the same link can still open, and then make it the primary action.
  const canRetry = state.phase === 'error' && state.retryable && onRetry;
  return (
    <main ref={page} className="share-page" aria-label="Shared model">
      <header className="share-page-brand">
        <BrandMark compact />
        <span>OpenZCAD</span>
        <span className="share-page-label">Shared model</span>
      </header>
      <section className="share-page-card" aria-labelledby="share-page-heading">
        <div
          className={`share-page-icon${loading ? '' : ' error'}`}
          aria-hidden="true"
        >
          {loading ? <Link2 size={28} /> : <Link2Off size={28} />}
        </div>
        <div role="status" aria-live="polite">
          <h1 id="share-page-heading" ref={heading} tabIndex={-1}>
            {loading ? 'Opening shared model…' : state.title}
          </h1>
          <p className="share-page-message">
            {loading
              ? 'Loading the model and checking its shared files.'
              : state.message}
          </p>
        </div>
        <p className="share-page-guidance">
          {loading
            ? 'Keep this page open. You can return to your projects at any time.'
            : state.guidance}
        </p>
        <div className="share-page-actions">
          {loading ? (
            <span className="share-page-progress">
              <LoaderCircle size={16} className="spin" aria-hidden="true" />
              Opening model
            </span>
          ) : canRetry ? (
            <button className="primary" type="button" onClick={onRetry}>
              <RotateCw size={16} aria-hidden="true" />
              Try again
            </button>
          ) : null}
          <button
            className={loading || canRetry ? 'secondary' : 'primary'}
            type="button"
            onClick={onBack}
          >
            Back to projects
          </button>
          {onReturnToModel && (
            <button
              className="secondary"
              type="button"
              onClick={onReturnToModel}
            >
              Return to previous model
            </button>
          )}
        </div>
      </section>
      <p className="share-page-footer">
        A model shared with you through OpenZCAD
      </p>
    </main>
  );
}
