import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type Ref
} from 'react';
import type { ProjectSummary } from '@openzcad/shared';
import {
  getKeySessionRevision,
  getKeySessionVersion,
  isCurrentKeySession,
  isKeySessionActive,
  subscribeKeySession
} from '../lib/e2ee/keySession';
import { projectNeedsUpdate } from '../lib/projectShelf';

interface PartThumbnailProps {
  project: ProjectSummary;
  accountId?: string | null;
  /**
   * Reads this device's cached preview. It must not load the project document:
   * the shelf has to stay reachable for a part whose source is far too large to
   * hold in memory, so a missing preview is answered from the cache or not at
   * all.
   */
  loadThumbnail(project: ProjectSummary): Promise<string | null | undefined>;
  /**
   * Publishes this device's preview to the account when the listing has none,
   * and answers a miss from the same cache. It does not render either: the
   * shelf never draws a card (see `loadThumbnail`), so a project with no
   * record stays a placeholder until the workspace writes one — which it now
   * does on every leave, not only after an idle pause.
   */
  publishThumbnail(project: ProjectSummary): Promise<string | null | undefined>;
}

interface ThumbnailResult {
  key: string;
  projectId: string;
  authorization: string;
  protected: boolean;
  /** Null is a real empty part; undefined means there is no preview to show. */
  source: string | null | undefined;
}

const thumbnailPromises = new Map<
  string,
  Promise<ThumbnailResult | undefined>
>();
// Only already-decoded images/known-empty answers are reused on remount. Keep
// one answer per project, bounded independently of the number of refreshes.
const thumbnails = new Map<string, ThumbnailResult>();
const latestRequest = new Map<string, string>();
const MAX_RETAINED_THUMBNAILS = 256;
subscribeKeySession(() => {
  for (const [id, value] of thumbnails)
    if (value.protected) thumbnails.delete(id);
  for (const key of thumbnailPromises.keys())
    if (key.startsWith('protected:')) thumbnailPromises.delete(key);
  for (const [id, key] of latestRequest)
    if (key.startsWith('protected:')) latestRequest.delete(id);
});

async function decodeThumbnail(source: string) {
  const image = new Image();
  if (typeof image.decode === 'function') {
    image.src = source;
    await image.decode();
  } else {
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () =>
        reject(new Error('Thumbnail could not be decoded.'));
      image.src = source;
    });
  }
}

function cachedThumbnail(
  projectId: string,
  authorization: string,
  protectedImage: boolean
): ThumbnailResult | undefined {
  const cached = thumbnails.get(projectId);
  // A device image already visible before encryption is a safe seed, but a
  // protected image is never carried into another account/key session.
  return cached &&
    (cached.authorization === authorization ||
      (!cached.protected && protectedImage))
    ? cached
    : undefined;
}

function thumbnailFor(
  cacheKey: string,
  authorization: string,
  protectedImage: boolean,
  isCurrent: () => boolean,
  project: ProjectSummary,
  loadThumbnail: PartThumbnailProps['loadThumbnail'],
  publishThumbnail: PartThumbnailProps['publishThumbnail']
): Promise<ThumbnailResult | undefined> {
  latestRequest.set(project.projectId, cacheKey);
  const ready = thumbnails.get(project.projectId);
  if (ready?.key === cacheKey && ready.authorization === authorization) {
    if (ready.source && !project.thumbnailArtifactId && isCurrent())
      void publishThumbnail(project).catch(() => undefined);
    return Promise.resolve(ready);
  }
  const cached = thumbnailPromises.get(cacheKey);
  if (cached) {
    return cached;
  }
  const pending = loadThumbnail(project)
    .then((source) => {
      if (!isCurrent() || latestRequest.get(project.projectId) !== cacheKey)
        return undefined;
      // Only a cache miss reaches the publisher. A cached null is an answer —
      // the part is genuinely empty — and re-deriving it every visit would
      // undo the caching this store exists for.
      if (source === undefined) {
        return publishThumbnail(project);
      }
      // A device preview still needs publishing when the account has no
      // artifact. Show it immediately while the upload fills the cross-device
      // cache in the background.
      if (source && !project.thumbnailArtifactId) {
        void publishThumbnail(project).catch(() => undefined);
      }
      return source;
    })
    .then(async (source) => {
      if (
        source === undefined ||
        !isCurrent() ||
        latestRequest.get(project.projectId) !== cacheKey
      )
        return undefined;
      if (source) await decodeThumbnail(source);
      if (!isCurrent() || latestRequest.get(project.projectId) !== cacheKey)
        return undefined;
      const result = {
        key: cacheKey,
        projectId: project.projectId,
        authorization,
        protected: protectedImage,
        source
      };
      thumbnails.delete(project.projectId);
      thumbnails.set(project.projectId, result);
      if (thumbnails.size > MAX_RETAINED_THUMBNAILS) {
        const oldest = thumbnails.keys().next().value!;
        thumbnails.delete(oldest);
        latestRequest.delete(oldest);
      }
      return result;
    })
    .catch(() => undefined)
    .finally(() => {
      if (thumbnailPromises.get(cacheKey) === pending)
        thumbnailPromises.delete(cacheKey);
      if (
        !thumbnails.has(project.projectId) &&
        latestRequest.get(project.projectId) === cacheKey
      )
        latestRequest.delete(project.projectId);
    });
  thumbnailPromises.set(cacheKey, pending);
  return pending;
}

/** Prime a bounded first screen from device images before mounting its tiles.
 * A slow/blocked store cannot hold the library; unfinished reads remain reusable.
 * The caller supplies a cache-only loader: no document loads or uploads here.
 */
export async function preparePartThumbnails(
  projects: readonly ProjectSummary[],
  accountId: string | null,
  loadCached: PartThumbnailProps['loadThumbnail']
): Promise<void> {
  const revision = getKeySessionRevision();
  const sessionVersion = getKeySessionVersion();
  const unique = [
    ...new Map(projects.map((project) => [project.projectId, project])).values()
  ];
  const reads = unique.slice(0, 16).map(async (project) => {
    const protectedImage = project.storageFormat === 2;
    if (
      projectNeedsUpdate(project) ||
      (protectedImage && (!accountId || !isKeySessionActive()))
    )
      return;
    const authorization = protectedImage
      ? `protected:${accountId}:${sessionVersion}`
      : 'device';
    const key = `${authorization}:${project.projectId}:${project.updatedAt}:${project.documentVersion ?? ''}:${project.thumbnailArtifactId ?? ''}`;
    // A cache-only miss must not occupy the normal request slot: a mounted
    // tile still needs to try its account artifact after a slow device read.
    const source = await loadCached(project).catch(() => undefined);
    if (
      source === undefined ||
      thumbnails.has(project.projectId) ||
      thumbnailPromises.has(key)
    )
      return;
    await thumbnailFor(
      key,
      authorization,
      protectedImage,
      () => !protectedImage || isCurrentKeySession(revision),
      project,
      async () => source,
      async () => undefined
    );
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.all(reads),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, 120);
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * One placeholder for every tile without a picture. An empty part used to
 * swap the wire cube for a line of mono text, so two tiles in the same row
 * looked unrelated; it now keeps the cube and adds a caption.
 */
function ThumbnailPlaceholder({
  empty,
  previewRef
}: {
  empty: boolean;
  previewRef?: Ref<SVGSVGElement>;
}) {
  return (
    <>
      <svg ref={previewRef} viewBox="0 0 120 80" aria-hidden="true">
        <g
          fill="none"
          stroke="currentColor"
          strokeWidth={1.1}
          strokeLinejoin="round"
        >
          <path d="M34 52 60 40l26 12-26 12-26-12Z" />
          <path d="M34 52V32l26-12 26 12v20" />
          <path d="M60 40V20" />
        </g>
      </svg>
      {/* Hidden from the tile's name like the rest of the preview: inside
          the open button it came first, so every empty part was announced
          as "No geometry" before its own name. */}
      {empty && (
        <span className="start-tile-thumb-empty" aria-hidden="true">
          No geometry
        </span>
      )}
    </>
  );
}

export function PartThumbnail({
  project,
  accountId = null,
  loadThumbnail,
  publishThumbnail
}: PartThumbnailProps) {
  const sessionVersion = useSyncExternalStore(
    subscribeKeySession,
    getKeySessionVersion,
    getKeySessionVersion
  );
  const protectedImage = project.storageFormat === 2;
  const revision = getKeySessionRevision();
  const authorized =
    !projectNeedsUpdate(project) &&
    (!protectedImage || (accountId !== null && isKeySessionActive()));
  const authorization = protectedImage
    ? `protected:${accountId}:${sessionVersion}`
    : 'device';
  const cacheKey = `${authorization}:${project.projectId}:${project.updatedAt}:${project.documentVersion ?? ''}:${project.thumbnailArtifactId ?? ''}`;
  const previewRef = useRef<Element | null>(null);
  const attachPreview = useCallback((node: Element | null) => {
    previewRef.current = node;
  }, []);
  const [result, setResult] = useState<ThumbnailResult | undefined>(() =>
    authorized
      ? cachedThumbnail(project.projectId, authorization, protectedImage)
      : undefined
  );
  const projectRef = useRef(project);
  projectRef.current = project;
  const authorizationRef = useRef(authorization);
  authorizationRef.current = authorization;

  useEffect(() => {
    let active = true;
    let started = false;
    if (!authorized) return;
    const isCurrent = () =>
      authorizationRef.current === authorization &&
      (!protectedImage || isCurrentKeySession(revision));
    const load = () => {
      if (!active || started || !isCurrent()) return;
      started = true;
      void thumbnailFor(
        cacheKey,
        authorization,
        protectedImage,
        isCurrent,
        projectRef.current,
        loadThumbnail,
        publishThumbnail
      ).then((next) => {
        if (active && next && isCurrent()) {
          setResult(next);
        }
      });
    };
    // All project cards remain searchable and keyboard-accessible, while
    // offscreen previews wait until scrolling brings them near the viewport.
    const preview = previewRef.current;
    let observer: IntersectionObserver | undefined;
    if (preview && typeof IntersectionObserver !== 'undefined') {
      observer = new IntersectionObserver(
        (entries) => {
          if (entries.some((entry) => entry.isIntersecting)) {
            observer?.disconnect();
            load();
          }
        },
        { rootMargin: '200px' }
      );
      observer.observe(preview);
    } else {
      load();
    }
    return () => {
      active = false;
      observer?.disconnect();
    };
  }, [
    publishThumbnail,
    cacheKey,
    loadThumbnail,
    authorization,
    authorized,
    protectedImage,
    revision
  ]);

  const visible =
    authorized &&
    result?.projectId === project.projectId &&
    (result.authorization === authorization ||
      (!result.protected && protectedImage))
      ? result
      : authorized
        ? cachedThumbnail(project.projectId, authorization, protectedImage)
        : undefined;
  if (visible?.source) {
    return (
      <img ref={attachPreview} src={visible.source} alt="" draggable={false} />
    );
  }
  // Unknown/loading is not an empty model. Keep its slot quiet while the
  // cache/decode completes; the wire cube is reserved for a confirmed miss.
  if (!visible)
    return (
      <span
        ref={attachPreview}
        className="start-tile-thumb-loading"
        aria-hidden="true"
      />
    );
  return (
    <ThumbnailPlaceholder
      empty={visible?.key === cacheKey && visible.source === null}
      previewRef={attachPreview}
    />
  );
}
