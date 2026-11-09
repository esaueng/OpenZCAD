import { useLayoutEffect, useRef, type RefObject } from 'react';
import type { ProjectDocument } from '@openzcad/shared';
import type { LocalProjectAutosave } from '../lib/localProjectAutosave';

/** Schedule accepted documents only; transient previews never replace them. */
export function useLocalProjectAutosaveSchedule({
  document,
  autosave,
  flush,
  timeoutRef,
  onCanonicalChange
}: {
  document: ProjectDocument | null;
  autosave: LocalProjectAutosave;
  flush(): Promise<void>;
  timeoutRef: RefObject<number | null>;
  onCanonicalChange(): void;
}): void {
  const onChangeRef = useRef(onCanonicalChange);
  onChangeRef.current = onCanonicalChange;
  useLayoutEffect(() => {
    if (!document) return;
    if (autosave.enqueue(document)) {
      onChangeRef.current();
      // Start the device transaction before paint. Only cache bookkeeping
      // stays debounced, without presenting it as an unsaved edit.
      void flush().catch(() => undefined);
      return;
    }
    const timeout = window.setTimeout(() => {
      timeoutRef.current = null;
      void flush().catch(() => undefined);
    }, 450);
    timeoutRef.current = timeout;
    return () => {
      if (timeoutRef.current === timeout) {
        window.clearTimeout(timeout);
        timeoutRef.current = null;
      }
    };
  }, [document, autosave, flush, timeoutRef]);
}
