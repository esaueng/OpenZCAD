import { Suspense } from 'react';
import { lazyWithStaleChunkNotice } from '../lib/staleChunk';
import { ErrorBoundary } from './ErrorBoundary';
import type * as PatternProgressModule from './PatternProgress';

interface PatternProgressSlotProps {
  name: string;
  onCancel(): void;
}

/**
 * The pill without its own chunk: shown while that chunk loads, and in its
 * place when it cannot load (an older deployment's chunk gone) or crashes.
 * The rebuild it stands for is running either way, so Cancel stays.
 */
export function PatternProgressFallback({
  name,
  onCancel
}: PatternProgressSlotProps) {
  return (
    <div
      className="pattern-progress"
      role="region"
      aria-label="Pattern rebuild"
      aria-busy="true"
    >
      <span role="status">Rebuilding {name}.</span>
      <button type="button" onClick={onCancel}>
        Cancel pattern
      </button>
    </div>
  );
}

/**
 * The pattern rebuild pill in the activity lane, its own chunk loaded by
 * `load`. A failure here stays here: without its own boundary a chunk that
 * did not load reached the page's and replaced the whole workspace,
 * mid-rebuild.
 */
export function patternProgressSlot(
  load: () => Promise<typeof PatternProgressModule> = () =>
    import('./PatternProgress')
) {
  const LazyPatternProgress = lazyWithStaleChunkNotice(() =>
    load().then((module) => ({ default: module.PatternProgress }))
  );
  return function PatternProgressSlot(props: PatternProgressSlotProps) {
    const fallback = <PatternProgressFallback {...props} />;
    return (
      <ErrorBoundary
        label="Pattern progress"
        fallback={fallback}
        fallbackWhileRecovering
      >
        <Suspense fallback={fallback}>
          <LazyPatternProgress {...props} />
        </Suspense>
      </ErrorBoundary>
    );
  };
}

// Off the entry chunk: shown only while a pattern's Done rebuilds.
export const PatternProgressSlot = patternProgressSlot();
