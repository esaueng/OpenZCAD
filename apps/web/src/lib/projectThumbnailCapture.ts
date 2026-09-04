import type {
  ArtifactId,
  BodyRepresentation,
  ProjectId
} from '@openzcad/shared';
import type { ProjectThumbnailRecord } from './localProjectStore';
import { thumbnailRecordDescribes } from './projectShelf';

const DEFAULT_IDLE_MS = 4000;

export interface StagedThumbnail {
  projectId: ProjectId;
  version: number;
  updatedAt: string;
  /** The bodies geometry reported ready for `version`, unconsumed only. */
  bodies: BodyRepresentation[];
}

export interface CapturedThumbnail {
  projectId: ProjectId;
  version: number;
  updatedAt: string;
  source: string | null;
  /** Present when the record this capture settled on was already published. */
  artifactId?: ArtifactId;
}

export interface ThumbnailCaptureHost {
  /**
   * Draws the card synchronously from meshes already in memory. Synchronous
   * on purpose: a leave-time flush has to finish before the shelf reads the
   * store, and nothing asynchronous may sit between "the user left" and "the
   * record exists" or the card is a placeholder until the next visit.
   */
  render(bodies: BodyRepresentation[]): string | null;
  load(projectId: string): Promise<ProjectThumbnailRecord | null>;
  save(
    projectId: string,
    thumbnail: { source: string | null; version: number; updatedAt: string }
  ): Promise<void>;
  /**
   * Serialises renders. Browsers keep WebGL contexts alive for a while after
   * disposal, so two cards drawn back to back can evict the live viewport.
   * Only synchronous render work may go through it: a network call in the
   * queue stalls every capture behind it, including the one a recovery copy
   * waits on.
   */
  queue<T>(work: () => T): Promise<T>;
}

export interface ThumbnailCapture {
  /**
   * Records what the workspace currently shows and arms the idle timer. The
   * routine path: a part left alone for a few seconds gets its card without
   * anyone leaving.
   */
  stage(input: StagedThumbnail, host: ThumbnailCaptureHost): void;
  /**
   * Captures whatever is staged and unwritten, now. Called on every path that
   * leaves the document; resolves once the record is on disk, so a shelf that
   * loads next reads the card. Never rejects.
   */
  flush(): Promise<void>;
  /** Forgets the staged entry so a later flush cannot write it back. */
  discard(): void;
  subscribe(listener: (captured: CapturedThumbnail) => void): () => void;
}

/**
 * The one place a card preview is captured from an open document.
 *
 * Before this existed the only capture was an idle timer inside the
 * workspace, and a project opened, modelled and left within four seconds of
 * its last edit never got a card at all. Worse, the empty workspace had
 * already recorded "no geometry" for its first version, and because the
 * shelf never renders — it must stay reachable for a part whose source is too
 * large to load — nothing could ever replace that record until the project
 * was reopened and left idle. Keeping the staged state here, outside React,
 * lets the leave paths in App flush it regardless of which components are
 * mounted at the time (the sync agent unmounts during every rebuild).
 *
 * Records are keyed by document version. A capture writes only the version it
 * was staged with, so a late write after the document moved on is harmless,
 * and a version already on disk is never rendered twice.
 */
export function createThumbnailCapture(
  options: { idleMs?: number } = {}
): ThumbnailCapture {
  const idleMs = options.idleMs ?? DEFAULT_IDLE_MS;
  let staged: { entry: StagedThumbnail; host: ThumbnailCaptureHost } | null =
    null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let inflight: Promise<void> | null = null;
  const written = new Map<string, number>();
  const listeners = new Set<(captured: CapturedThumbnail) => void>();

  function clearTimer() {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  }

  function isWritten(entry: StagedThumbnail): boolean {
    return written.get(entry.projectId) === entry.version;
  }

  function notify(captured: CapturedThumbnail) {
    for (const listener of listeners) {
      listener(captured);
    }
  }

  async function captureOnce(
    entry: StagedThumbnail,
    host: ThumbnailCaptureHost
  ): Promise<void> {
    const cached = await host.load(entry.projectId).catch(() => null);
    if (
      cached &&
      thumbnailRecordDescribes(cached, { documentVersion: entry.version })
    ) {
      // Another tab, or an earlier idle capture, already drew this version.
      written.set(entry.projectId, entry.version);
      notify({
        projectId: entry.projectId,
        version: entry.version,
        updatedAt: entry.updatedAt,
        source: cached.source,
        ...(cached.artifactId ? { artifactId: cached.artifactId } : {})
      });
      return;
    }
    let source: string | null;
    try {
      source = await host.queue(() => host.render(entry.bodies));
    } catch {
      // No context, or a driver that refused: keep whatever record exists
      // rather than recording "no geometry" for a part that has some. Left
      // unwritten so the next flush tries once more.
      return;
    }
    try {
      await host.save(entry.projectId, {
        source,
        version: entry.version,
        updatedAt: entry.updatedAt
      });
    } catch {
      return;
    }
    written.set(entry.projectId, entry.version);
    notify({
      projectId: entry.projectId,
      version: entry.version,
      updatedAt: entry.updatedAt,
      source
    });
  }

  function run(): Promise<void> {
    if (inflight) {
      return inflight;
    }
    inflight = (async () => {
      // A stage() that lands while a capture is in flight leaves a newer
      // version pending; loop until the staged entry is the one written, and
      // stop after one attempt at any entry that failed so a dead render
      // cannot spin.
      for (;;) {
        const current = staged;
        if (!current || isWritten(current.entry)) {
          return;
        }
        await captureOnce(current.entry, current.host);
        if (staged === current) {
          return;
        }
      }
    })().finally(() => {
      inflight = null;
    });
    return inflight;
  }

  return {
    stage(entry, host) {
      staged = { entry, host };
      clearTimer();
      if (isWritten(entry)) {
        return;
      }
      timer = setTimeout(() => {
        timer = null;
        void run();
      }, idleMs);
    },
    flush() {
      clearTimer();
      return run();
    },
    discard() {
      clearTimer();
      staged = null;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    }
  };
}

/**
 * The instance the workspace stages into and the leave paths flush. Module
 * scope rather than React state so it outlives the agent that stages it.
 */
export const sharedThumbnailCapture = createThumbnailCapture();
