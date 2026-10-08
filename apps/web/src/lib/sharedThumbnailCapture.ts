import type { ThumbnailCapture } from './projectThumbnailCapture';

/** Keep background card coordination behind the workspace's lazy boundary. */
export function lazyThumbnailCapture(
  load: () => Promise<ThumbnailCapture>
): ThumbnailCapture {
  let capture: ThumbnailCapture | undefined;
  let loading: Promise<ThumbnailCapture> | undefined;
  let busy = false;
  let staged: Parameters<ThumbnailCapture['stage']> | undefined;
  const listeners = new Map<
    Parameters<ThumbnailCapture['subscribe']>[0],
    (() => void) | undefined
  >();
  const ready = () => {
    loading ??= load()
      .then((loaded) => {
        capture = loaded;
        capture.setBusy(busy);
        for (const listener of listeners.keys()) {
          listeners.set(listener, capture.subscribe(listener));
        }
        if (staged) capture.stage(...staged);
        staged = undefined;
        return loaded;
      })
      .catch((error: unknown) => {
        loading = undefined;
        throw error;
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
      if (capture) capture.stage(entry, host);
      else {
        staged = [entry, host];
        void ready().catch(() => undefined);
      }
    },
    flush() {
      return capture
        ? capture.flush()
        : ready()
            .then((loaded) => loaded.flush())
            .catch(() => undefined);
    },
    discard() {
      staged = undefined;
      capture?.discard();
    },
    subscribe(listener) {
      // Keep pending subscriptions across a failed import, until their
      // owner unsubscribes or a later call successfully loads the module.
      const token = (entry: Parameters<typeof listener>[0]) => listener(entry);
      listeners.set(token, capture?.subscribe(token));
      if (!capture) void ready().catch(() => undefined);
      return () => {
        listeners.get(token)?.();
        listeners.delete(token);
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
