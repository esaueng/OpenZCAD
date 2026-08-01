import { useEffect, useState } from 'react';
import type { BodyRepresentation, ProjectSummary } from '@openzcad/shared';

interface PartThumbnailProps {
  project: ProjectSummary;
  loadBodies(project: ProjectSummary): Promise<BodyRepresentation[]>;
}

interface ThumbnailResult {
  key: string;
  /** Null is a real empty part; undefined means the preview could not render. */
  source: string | null | undefined;
}

const thumbnailPromises = new Map<string, Promise<string | null | undefined>>();

function thumbnailFor(
  cacheKey: string,
  project: ProjectSummary,
  loadBodies: PartThumbnailProps['loadBodies']
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
  const pending = loadBodies(project)
    .then(async (bodies) => {
      const hasGeometry = bodies.some(
        (body) =>
          !body.consumed &&
          body.mesh.vertices.length >= 9 &&
          body.mesh.indices.length >= 3
      );
      if (!hasGeometry) {
        return null;
      }
      const { renderPartThumbnail } = await import('../lib/partThumbnail');
      return renderPartThumbnail(bodies);
    })
    .catch(() => {
      thumbnailPromises.delete(cacheKey);
      return undefined;
    });
  thumbnailPromises.set(cacheKey, pending);
  return pending;
}

function ThumbnailPlaceholder({ empty }: { empty: boolean }) {
  if (empty) {
    return <span className="start-tile-thumb-empty">No geometry</span>;
  }
  return (
    <svg viewBox="0 0 120 80" aria-hidden="true">
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

export function PartThumbnail({ project, loadBodies }: PartThumbnailProps) {
  const cacheKey = `${project.projectId}:${project.updatedAt}`;
  const [result, setResult] = useState<ThumbnailResult | null>(null);

  useEffect(() => {
    let active = true;
    void thumbnailFor(cacheKey, project, loadBodies).then((source) => {
      if (active) {
        setResult({ key: cacheKey, source });
      }
    });
    return () => {
      active = false;
    };
  }, [cacheKey, loadBodies, project]);

  if (result?.key === cacheKey) {
    if (result.source) {
      return <img src={result.source} alt="" draggable={false} />;
    }
    return <ThumbnailPlaceholder empty={result.source === null} />;
  }

  return <ThumbnailPlaceholder empty={false} />;
}
