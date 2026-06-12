import type { BodyNode } from '@openzcad/shared';
import { getBodyLoad, getBodyRole, loadMagnitude } from '../lib/workflow';
import { formatN } from '../lib/format';

interface BodyRoleListProps {
  bodies: BodyNode[];
  selectedNodeId: string | null;
  onSelect(nodeId: string): void;
}

/**
 * Compact body list with role/load badges; shared by the Preserve,
 * Constraints, and Loads panels. Selection drives the panel's actions and
 * the viewport callout.
 */
export function BodyRoleList({ bodies, selectedNodeId, onSelect }: BodyRoleListProps) {
  if (bodies.length === 0) {
    return (
      <p className="panel-copy">No bodies yet — add geometry in the Model step first.</p>
    );
  }

  return (
    <div className="body-list" role="list" aria-label="Bodies">
      {bodies.map((body) => {
        const role = getBodyRole(body);
        const load = getBodyLoad(body);
        return (
          <button
            key={body.id}
            type="button"
            role="listitem"
            className={`body-row ${selectedNodeId === body.id ? 'selected' : ''}`}
            onClick={() => onSelect(body.id)}
          >
            <span className="body-name">{body.name}</span>
            {load && <span className="role-badge load">{formatN(loadMagnitude(load))}</span>}
            <span className={`role-badge ${role ?? ''}`}>{role ?? 'design'}</span>
          </button>
        );
      })}
    </div>
  );
}
