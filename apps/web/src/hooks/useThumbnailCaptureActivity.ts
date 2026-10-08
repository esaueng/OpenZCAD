import { useEffect } from 'react';
import type { ThumbnailCapture } from '../lib/projectThumbnailCapture';

/** Keep shelf GL/readback out of interactive input and exact regeneration. */
export function useThumbnailCaptureActivity(
  capture: ThumbnailCapture,
  busy: boolean
) {
  useEffect(() => {
    const activity = () => capture.activity();
    const events = [
      'pointerdown',
      'pointermove',
      'keydown',
      'wheel',
      'input'
    ] as const;
    for (const event of events)
      window.addEventListener(event, activity, {
        capture: true,
        passive: true
      });
    return () => {
      for (const event of events)
        window.removeEventListener(event, activity, true);
    };
  }, [capture]);

  useEffect(() => {
    capture.setBusy(busy);
    return () => capture.setBusy(false);
  }, [busy, capture]);
}
