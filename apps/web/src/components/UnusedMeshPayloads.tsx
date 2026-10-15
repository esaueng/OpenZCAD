import { useEffect, useRef, useState } from 'react';
import {
  documentNodesWithHistory,
  type ArtifactRecord,
  type ProjectDocument
} from '@openzcad/shared';
import type { api } from '../lib/api';

export interface UnusedMeshPayloadsProps {
  document: ProjectDocument;
  getDocument(): ProjectDocument | null;
  transport: Pick<typeof api, 'listArtifacts' | 'discardMeshPayload'>;
}

function referencedArtifacts(document: ProjectDocument): Set<string> {
  const ids = new Set<string>();
  for (const node of documentNodesWithHistory(document)) {
    if (
      node?.kind === 'feature' &&
      'artifactId' in node.data &&
      typeof node.data.artifactId === 'string'
    ) {
      ids.add(node.data.artifactId);
    }
  }
  return ids;
}

/** Durable account listing makes failed compensation recoverable after reload. */
export default function UnusedMeshPayloads({
  document,
  getDocument,
  transport
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
      artifact.kind === 'mesh-payload' &&
      !referenced.has(artifact.artifactId)
  );

  async function remove(artifact: ArtifactRecord) {
    const current = getDocument();
    if (
      !current ||
      current.projectId !== projectId ||
      referencedArtifacts(current).has(artifact.artifactId)
    ) {
      setMessage('This mesh data is in use and was kept.');
      return;
    }
    setPending(artifact.artifactId);
    setMessage(null);
    try {
      const result = await transport.discardMeshPayload(
        projectId,
        artifact.artifactId
      );
      if (!active.current) return;
      if (result.deleted) {
        setArtifacts((stored) =>
          stored.filter((item) => item.artifactId !== artifact.artifactId)
        );
        setMessage('Unused mesh data removed.');
      } else {
        setMessage(
          'This mesh data is still used by stored project history and was kept.'
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
      <strong className="topbar-menu-label">Unused imported mesh data</strong>
      {unused.map((artifact) => (
        <button
          key={artifact.artifactId}
          type="button"
          className="topbar-menu-item"
          aria-label={`Remove unused mesh data: ${artifact.name}`}
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
