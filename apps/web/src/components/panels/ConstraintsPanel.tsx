import type { BodyNode } from '@openzcad/shared';
import { getBodyRole, type BodyRole } from '../../lib/workflow';
import { BodyRoleList } from '../BodyRoleList';

interface ConstraintsPanelProps {
  bodies: BodyNode[];
  selectedNodeId: string | null;
  fixedCount: number;
  obstacleCount: number;
  onSelect(nodeId: string): void;
  onSetRole(body: BodyNode, role: BodyRole | null): void;
}

export function ConstraintsPanel({
  bodies,
  selectedNodeId,
  fixedCount,
  obstacleCount,
  onSelect,
  onSetRole
}: ConstraintsPanelProps) {
  const selected = bodies.find((body) => body.id === selectedNodeId) ?? null;
  const selectedRole = selected ? getBodyRole(selected) : null;

  return (
    <>
      <h3>
        Bodies · {fixedCount} fixed · {obstacleCount} obstacle
      </h3>
      <BodyRoleList bodies={bodies} selectedNodeId={selectedNodeId} onSelect={onSelect} />

      {selected ? (
        <>
          <h3>Selected · {selected.name}</h3>
          <div className="button-grid">
            <button
              type="button"
              className={selectedRole === 'fixed' ? 'outline-action' : 'secondary'}
              title="Geometry that anchors the part (bolted faces, ground)"
              onClick={() => onSetRole(selected, 'fixed')}
            >
              Mark fixed
            </button>
            <button
              type="button"
              className={selectedRole === 'obstacle' ? 'outline-action' : 'secondary'}
              title="Keep-out volume the optimizer must avoid"
              onClick={() => onSetRole(selected, 'obstacle')}
            >
              Mark obstacle
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
            Select a body to mark it as a fixed support or a keep-out obstacle.
          </p>
        )
      )}

      {fixedCount === 0 && bodies.length > 0 && (
        <div className="callout warning">
          No fixed support yet. Without an anchor the study cannot resist the applied loads.
        </div>
      )}
    </>
  );
}
