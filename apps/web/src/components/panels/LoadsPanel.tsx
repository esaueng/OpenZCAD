import { useEffect, useState } from 'react';
import type { BodyNode } from '@openzcad/shared';
import { getBodyLoad, loadMagnitude, type BodyLoad } from '../../lib/workflow';
import { formatN } from '../../lib/format';
import { BodyRoleList } from '../BodyRoleList';

interface LoadsPanelProps {
  bodies: BodyNode[];
  selectedNodeId: string | null;
  loadedCount: number;
  onSelect(nodeId: string): void;
  onSetLoad(body: BodyNode, load: BodyLoad | null): void;
}

const AXES = ['fx', 'fy', 'fz'] as const;

export function LoadsPanel({
  bodies,
  selectedNodeId,
  loadedCount,
  onSelect,
  onSetLoad
}: LoadsPanelProps) {
  const selected = bodies.find((body) => body.id === selectedNodeId) ?? null;
  const selectedLoad = selected ? getBodyLoad(selected) : null;
  const [draft, setDraft] = useState<Record<(typeof AXES)[number], string>>({
    fx: '0',
    fy: '-500',
    fz: '0'
  });

  // Refresh the draft when the selection (or its stored load) changes.
  useEffect(() => {
    if (selectedLoad) {
      setDraft({
        fx: String(selectedLoad.fx),
        fy: String(selectedLoad.fy),
        fz: String(selectedLoad.fz)
      });
    }
  }, [selectedNodeId, selectedLoad?.fx, selectedLoad?.fy, selectedLoad?.fz]);

  const parsed: BodyLoad = {
    fx: Number(draft.fx) || 0,
    fy: Number(draft.fy) || 0,
    fz: Number(draft.fz) || 0
  };
  const magnitude = loadMagnitude(parsed);

  return (
    <>
      <h3>Bodies · {loadedCount} loaded</h3>
      <BodyRoleList bodies={bodies} selectedNodeId={selectedNodeId} onSelect={onSelect} />

      {selected ? (
        <>
          <h3>Force on {selected.name}</h3>
          <div className="field">
            <span>Components (N)</span>
            <div className="field-grid">
              {AXES.map((axis) => (
                <input
                  key={axis}
                  type="number"
                  aria-label={`${axis.toUpperCase()} component in newtons`}
                  value={draft[axis]}
                  onChange={(event) =>
                    setDraft((current) => ({ ...current, [axis]: event.target.value }))
                  }
                />
              ))}
            </div>
            <small>
              X / Y / Z in newtons · resultant {formatN(magnitude)}
            </small>
          </div>
          <div className="button-grid">
            <button
              type="button"
              className="outline-action"
              disabled={magnitude === 0}
              title={magnitude === 0 ? 'Enter a non-zero force' : 'Apply this force'}
              onClick={() => onSetLoad(selected, parsed)}
            >
              Apply load
            </button>
            <button
              type="button"
              className="secondary"
              disabled={!selectedLoad}
              onClick={() => onSetLoad(selected, null)}
            >
              Remove load
            </button>
          </div>
        </>
      ) : (
        bodies.length > 0 && (
          <p className="panel-copy">Select a body to apply a force to it.</p>
        )
      )}

      {loadedCount === 0 && bodies.length > 0 && (
        <div className="callout warning">
          No loads applied. Add at least one force so the study has something to optimize
          against.
        </div>
      )}
    </>
  );
}
