import {
  Suspense,
  type ComponentProps,
  type ComponentType,
  type ReactElement,
  type ReactNode
} from 'react';
import { preloadableLazy } from '../lib/staleChunk';
import { ErrorBoundary } from './ErrorBoundary';

/** An optional surface loaded on demand, failing only in its own place. */
export interface PreloadableSlot<P extends object> {
  (props: P): ReactElement;
  /** Loads and evaluates the chunk; later renders need no Suspense. */
  preload(): Promise<void>;
  /** Whether a render now shows the surface rather than suspending. */
  isLoaded(): boolean;
}

/**
 * {@link preloadableLazy} behind its own error boundary. A chunk that cannot
 * load (a deploy removed it mid-session) or a surface that crashes stays in
 * this slot: without the boundary the error passed through Suspense to the
 * page's boundary and replaced the whole workspace or library. The chunk
 * failure is still reported, so the workspace offers its Reload; the slot
 * shows `failed` (the boundary's own "did not load" line when omitted).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- mirrors React.lazy's own constraint
export function preloadableSlot<T extends ComponentType<any>>(
  label: string,
  load: () => Promise<{ default: T }>,
  {
    pending = null,
    failed
  }: {
    /** Shown while the chunk loads. */
    pending?: ReactNode;
    /** Shown in the surface's place when it cannot load or render. */
    failed?: ReactNode;
  } = {}
): PreloadableSlot<ComponentProps<T>> {
  const Lazy = preloadableLazy(load);
  const Slot = ((props: ComponentProps<T>) => (
    <ErrorBoundary label={label} fallback={failed}>
      <Suspense fallback={pending}>
        <Lazy {...props} />
      </Suspense>
    </ErrorBoundary>
  )) as PreloadableSlot<ComponentProps<T>>;
  Slot.preload = () => Lazy.preload();
  Slot.isLoaded = () => Lazy.isLoaded();
  return Slot;
}
