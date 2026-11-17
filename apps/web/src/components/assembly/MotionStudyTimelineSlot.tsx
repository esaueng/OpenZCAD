import { Suspense, type ComponentProps } from 'react';
import { lazyWithStaleChunkNotice } from '../../lib/staleChunk';
import { ErrorBoundary } from '../ErrorBoundary';
import type * as MotionStudyTimelineModule from './MotionStudyTimeline';

type MotionStudyTimelineSlotProps = ComponentProps<
  typeof MotionStudyTimelineModule.MotionStudyTimeline
> & { resetKey?: string };

/**
 * Assemble's motion study timeline in the viewer's mode overlay, its own
 * chunk loaded by `load`. A failure here stays here: without its own
 * boundary a chunk that did not load reached the 3D viewer's boundary and
 * took the viewer with it. What shows instead is the panel's own "did not
 * load" line and its Reload.
 */
export function motionStudyTimelineSlot(
  load: () => Promise<typeof MotionStudyTimelineModule> = () =>
    import('./MotionStudyTimeline')
) {
  const LazyMotionStudyTimeline = lazyWithStaleChunkNotice(() =>
    load().then((module) => ({ default: module.MotionStudyTimeline }))
  );
  return function MotionStudyTimelineSlot({
    resetKey,
    ...props
  }: MotionStudyTimelineSlotProps) {
    return (
      <ErrorBoundary label="Motion study timeline" resetKey={resetKey}>
        <Suspense fallback={null}>
          <LazyMotionStudyTimeline {...props} />
        </Suspense>
      </ErrorBoundary>
    );
  };
}

// Off the entry chunk: the timeline is drawn only in Assemble.
export const MotionStudyTimelineSlot = motionStudyTimelineSlot();
