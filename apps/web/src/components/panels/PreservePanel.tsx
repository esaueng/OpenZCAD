import type { BodyNode } from '@openzcad/shared';
import { getBodyRole, type BodyRole } from '../../lib/workflow';
import { BodyRoleList } from '../BodyRoleList';

interface PreservePanelProps {
  bodies: BodyNode[];
  selectedNodeId: string | null;
  preservedCount: number;
  onSelect(nodeId: string): void;
  onSetRole(body: BodyNode, role: BodyRole | null): void;
}

export function PreservePanel({
  bodies,
  selectedNodeId,
  preservedCount,
  onSelect,
  onSetRole
}: PreservePanelProps) {
  const selected = bodies.find((body) => body.id === selectedNodeId) ?? null;
  const selectedRole = selected ? getBodyRole(selected) : null;

  return (
    <>
      <h3>Bodies · {preservedCount} preserved</h3>
      <BodyRoleList bodies={bodies} selectedNodeId={selectedNodeId} onSelect={onSelect} />

      {selected ? (
        <>
          <h3>Selected · {selected.name}</h3>
          <div className="button-grid">
            <button
              type="button"
              className={selectedRole === 'preserve' ? 'outline-action' : 'secondary'}
              onClick={() => onSetRole(selected, 'preserve')}
            >
              Mark preserve
            </button>
            <button
              type="button"
              className="secondary"
              disabled={selectedRole === null}
              onClick={() => onSetRole(selected, null)}
            >
              Clear role
            </button>
          </div>
        </>
      ) : (
        bodies.length > 0 && (
          <p className="panel-copy">
            Select a body in the list or click it in the viewport to mark it.
          </p>
        )
      )}

      {preservedCount === 0 && bodies.length > 0 && (
        <div className="callout warning">
          Nothing is preserved yet. The optimizer treats unmarked bodies as removable design
          space — mark mounting bosses, bearing seats, and interfaces you must keep.
        </div>
      )}
    </>
  );
}
