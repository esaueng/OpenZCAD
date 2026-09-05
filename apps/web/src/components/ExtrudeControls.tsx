import type { BodyId } from '@openzcad/shared';
import type { ExtrudeChoice } from '../lib/extrudeInference';

interface ExtrudeControlsProps {
  choice: ExtrudeChoice;
  bodies: { bodyId: BodyId; name: string }[];
  disabled: boolean;
  onChange(choice: ExtrudeChoice): void;
  onDistance(): void;
}

export function ExtrudeControls({
  choice,
  bodies,
  disabled,
  onChange,
  onDistance
}: ExtrudeControlsProps) {
  const needsTarget = choice.operation === 'add' || choice.operation === 'cut';
  return (
    <div className="extrude-controls">
      <label className="field">
        <span>Operation</span>
        <select
          aria-label="Extrude operation"
          value={choice.operation}
          disabled={disabled}
          onChange={(event) => {
            const operation = event.target.value as ExtrudeChoice['operation'];
            onChange(
              operation === 'add' || operation === 'cut'
                ? {
                    operation,
                    ...(needsTarget && choice.targetBodyId
                      ? { targetBodyId: choice.targetBodyId }
                      : bodies.length === 1
                        ? { targetBodyId: bodies[0]!.bodyId }
                        : {})
                  }
                : { operation }
            );
          }}
        >
          <option value="automatic">Automatic</option>
          <option value="new-body">New Body</option>
          <option value="add">Add</option>
          <option value="cut">Cut</option>
        </select>
      </label>
      {needsTarget && (
        <label className="field">
          <span>Target body</span>
          <select
            aria-label="Extrude target body"
            value={choice.targetBodyId ?? ''}
            disabled={disabled}
            onChange={(event) =>
              onChange({
                operation: choice.operation,
                ...(event.target.value
                  ? { targetBodyId: event.target.value as BodyId }
                  : {})
              })
            }
          >
            <option value="">Select a body</option>
            {bodies.map((body) => (
              <option key={body.bodyId} value={body.bodyId}>
                {body.name}
              </option>
            ))}
          </select>
        </label>
      )}
      <button type="button" disabled={disabled} onClick={onDistance}>
        Distance…
      </button>
      {needsTarget && !choice.targetBodyId && (
        <span className="muted">Select a target before applying.</span>
      )}
    </div>
  );
}
