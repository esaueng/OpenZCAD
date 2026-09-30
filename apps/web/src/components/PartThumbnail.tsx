import { useEffect, useRef, useState, type Ref } from 'react';
import type { ProjectSummary } from '@openzcad/shared';

interface PartThumbnailProps {
  project: ProjectSummary;
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
  /** Null is a real empty part; undefined means there is no preview to show. */
  source: string | null | undefined;
}

const thumbnailPromises = new Map<string, Promise<string | null | undefined>>();

function thumbnailFor(
  cacheKey: string,
  project: ProjectSummary,
  loadThumbnail: PartThumbnailProps['loadThumbnail'],
  publishThumbnail: PartThumbnailProps['publishThumbnail']
): Promise<string | null | undefined> {
  const cached = thumbnailPromises.get(cacheKey);
  if (cached) {
    return cached;
  }
  for (const key of thumbnailPromises.keys()) {
    if (key !== cacheKey && key.startsWith(`${project.projectId}:`)) {
      thumbnailPromises.delete(key);
    }
  }
  const pending = loadThumbnail(project)
    .then((source) => {
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
    .catch(() => {
      thumbnailPromises.delete(cacheKey);
      return undefined;
    });
  void pending.then((source) => {
    // A miss before sign-in or before the account listing arrived must remain
    // retryable when those inputs change. Successful images and real empty
    // projects stay memoized.
    if (source === undefined) {
      thumbnailPromises.delete(cacheKey);
    }
  });
  thumbnailPromises.set(cacheKey, pending);
  return pending;
}

function ThumbnailPlaceholder({
  empty,
  previewRef
}: {
  empty: boolean;
  previewRef?: Ref<SVGSVGElement>;
}) {
  if (empty) {
    return <span className="start-tile-thumb-empty">No geometry</span>;
  }
  return (
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
  );
}

export function PartThumbnail({
  project,
  loadThumbnail,
  publishThumbnail
}: PartThumbnailProps) {
  const cacheKey = `${project.projectId}:${project.updatedAt}:${project.thumbnailArtifactId ?? ''}`;
  const previewRef = useRef<SVGSVGElement>(null);
  const [result, setResult] = useState<ThumbnailResult | null>(null);

  useEffect(() => {
    let active = true;
    let started = false;
    const load = () => {
      if (!active || started) return;
      started = true;
      void thumbnailFor(
        cacheKey,
        project,
        loadThumbnail,
        publishThumbnail
      ).then((source) => {
        if (active) {
          setResult({ key: cacheKey, source });
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
  }, [publishThumbnail, cacheKey, loadThumbnail, project]);

  if (result?.key === cacheKey) {
    if (result.source) {
      return <img src={result.source} alt="" draggable={false} />;
    }
    return <ThumbnailPlaceholder empty={result.source === null} />;
  }

  return <ThumbnailPlaceholder empty={false} previewRef={previewRef} />;
}
