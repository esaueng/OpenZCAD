import type { ThumbnailCapture } from './projectThumbnailCapture';

/** Keep background card coordination behind the workspace's lazy boundary. */
export function lazyThumbnailCapture(
  load: () => Promise<ThumbnailCapture>
): ThumbnailCapture {
  let capture: ThumbnailCapture | undefined;
  let loading: Promise<ThumbnailCapture> | undefined;
  let busy = false;
  const ready = () => {
    loading ??= load().then((loaded) => {
      capture = loaded;
      capture.setBusy(busy);
      return loaded;
    });
    return loading;
  };
  const run = (work: (loaded: ThumbnailCapture) => void) => {
    if (capture) work(capture);
    else
      void ready()
        .then(work)
        .catch(() => undefined);
  };
  return {
    activity() {
      if (capture) capture.activity();
      else if (loading) run((loaded) => loaded.activity());
    },
    setBusy(next) {
      busy = next;
      capture?.setBusy(next);
    },
    stage(entry, host) {
      run((loaded) => loaded.stage(entry, host));
    },
    flush() {
      return capture
        ? capture.flush()
        : ready()
            .then((loaded) => loaded.flush())
            .catch(() => undefined);
    },
    discard() {
      if (capture) capture.discard();
      else if (loading) run((loaded) => loaded.discard());
    },
    subscribe(listener) {
      let active = true;
      let unsubscribe: (() => void) | undefined;
      run((loaded) => {
        if (active) unsubscribe = loaded.subscribe(listener);
      });
      return () => {
        active = false;
        unsubscribe?.();
      };
    }
  };
}

/** Shared by staging and leave-time flush, independently of React lifetime. */
export const sharedThumbnailCapture = lazyThumbnailCapture(() =>
  import('./projectThumbnailCapture').then(({ createThumbnailCapture }) =>
    createThumbnailCapture()
  )
);
