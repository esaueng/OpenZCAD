import { useEffect, useRef, useState } from 'react';
import {
  documentNodesWithHistory,
  documentAssetsWithHistory,
  referenceImagesWithHistory,
  type ArtifactRecord,
  type ProjectDocument
} from '@openzcad/shared';
import type { api } from '../lib/api';

export interface UnusedMeshPayloadsProps {
  document: ProjectDocument;
  getDocument(): ProjectDocument | null;
  transport: Pick<typeof api, 'listArtifacts' | 'discardMeshPayload'>;
  /** Keep the parent's stored-file list aligned with confirmed removal. */
  onRemove?(update: (artifacts: ArtifactRecord[]) => ArtifactRecord[]): void;
}

function referencedArtifacts(document: ProjectDocument): Set<string> {
  const ids = new Set<string>();
  for (const asset of documentAssetsWithHistory(document)) {
    if (asset.artifactId) ids.add(asset.artifactId);
  }
  for (const node of documentNodesWithHistory(document)) {
    if (
      node?.kind === 'feature' &&
      'artifactId' in node.data &&
      typeof node.data.artifactId === 'string'
    ) {
      ids.add(node.data.artifactId);
    }
  }
  // An I05 picture stays while the image, or an undo step that can restore
  // it, names its archive.
  for (const image of referenceImagesWithHistory(document)) {
    if (typeof image.artifactId === 'string') ids.add(image.artifactId);
  }
  return ids;
}

/** What a removable artifact is, in the words its row uses. */
function subjectOf(kind: ArtifactRecord['kind']): string {
  return kind === 'mesh-payload'
    ? 'mesh data'
    : kind === 'reference-image'
      ? 'image'
      : 'imported file';
}

/** Durable account listing makes failed compensation recoverable after reload. */
export default function UnusedMeshPayloads({
  document,
  getDocument,
  transport,
  onRemove
}: UnusedMeshPayloadsProps) {
  const projectId = document.projectId;
  const [artifacts, setArtifacts] = useState<ArtifactRecord[]>([]);
  const [pending, setPending] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const active = useRef(false);
  useEffect(() => {
    active.current = true;
    void transport.listArtifacts(projectId).then(
      (result) => {
        if (active.current) setArtifacts(result.artifacts);
      },
      () => {
        if (active.current)
          setMessage(
            'Unused mesh data could not be listed. Reopen File to retry.'
          );
      }
    );
    return () => {
      active.current = false;
    };
  }, [projectId, transport]);

  const referenced = referencedArtifacts(document);
  const unused = artifacts.filter(
    (artifact) =>
      artifact.projectId === projectId &&
      (artifact.kind === 'mesh-payload' ||
        artifact.kind === 'stl-import' ||
        artifact.kind === 'mesh-import' ||
        artifact.kind === 'reference-image') &&
      !referenced.has(artifact.artifactId)
  );

  async function remove(artifact: ArtifactRecord) {
    // Originals and pictures are stored files: owner-only removal, by kind.
    const originalKind =
      artifact.kind === 'stl-import' ||
      artifact.kind === 'mesh-import' ||
      artifact.kind === 'reference-image'
        ? artifact.kind
        : undefined;
    const subject = subjectOf(artifact.kind);
    const current = getDocument();
    if (
      !current ||
      current.projectId !== projectId ||
      referencedArtifacts(current).has(artifact.artifactId)
    ) {
      setMessage(`This ${subject} is in use and was kept.`);
      return;
    }
    setPending(artifact.artifactId);
    setMessage(null);
    try {
      const result = originalKind
        ? await transport.discardMeshPayload(
            projectId,
            artifact.artifactId,
            originalKind
          )
        : await transport.discardMeshPayload(projectId, artifact.artifactId);
      if (!active.current) return;
      if (result.deleted) {
        onRemove?.((stored) =>
          stored.filter(
            (item) =>
              item.projectId !== projectId ||
              item.artifactId !== artifact.artifactId
          )
        );
        setArtifacts((stored) =>
          stored.filter((item) => item.artifactId !== artifact.artifactId)
        );
        setMessage(`Unused ${subject} removed.`);
      } else {
        setMessage(
          `This ${subject} is still used by stored project history and was kept.`
        );
      }
    } catch (error) {
      if (active.current)
        setMessage(
          error instanceof Error
            ? error.message
            : 'Mesh cleanup failed. Try Remove again.'
        );
    } finally {
      if (active.current) setPending(null);
    }
  }

  if (unused.length === 0 && !message) return null;
  return (
    <>
      <div className="topbar-menu-sep" />
      <strong className="topbar-menu-label">
        Unused imported files, mesh data and images
      </strong>
      {unused.map((artifact) => (
        <button
          key={artifact.artifactId}
          type="button"
          className="topbar-menu-item"
          aria-label={`Remove unused ${subjectOf(artifact.kind)}: ${artifact.name}`}
          disabled={pending !== null}
          onClick={() => void remove(artifact)}
        >
          <span>{artifact.name}</span>
          <small>
            {pending === artifact.artifactId ? 'Removing…' : 'Remove'}
          </small>
        </button>
      ))}
      {message ? (
        <span
          className="topbar-menu-empty"
          role="status"
          aria-label="Mesh cleanup"
        >
          {message}
        </span>
      ) : null}
    </>
  );
}
