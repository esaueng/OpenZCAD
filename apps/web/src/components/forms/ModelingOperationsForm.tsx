import { useRef, useState, type FormEvent, type ReactNode } from 'react';
import type { BodyId } from '@openzcad/shared';
import { ExprInput } from '../ExprInput';
import type { BodyOption } from './FeatureForms';
import {
  buildModelingOperationSubmission,
  modelingFormValidationReason,
  type ExactPreflightResult,
  type ExactPreflightState,
  type ModelingFaceOption,
  type ModelingOperationFormState,
  type ModelingOperationKind,
  type ModelingOperationSubmission
} from '../../lib/modelingOperations';

const OPERATION_LABELS: Record<ModelingOperationKind, string> = {
  mirror: 'Mirror',
  shell: 'Shell',
  'solid-offset': 'Solid offset'
};

export interface ModelingOperationsFormProps {
  operation: ModelingOperationKind;
  scope: Record<string, number>;
  bodies: BodyOption[];
  faceOptions?: ModelingFaceOption[];
  initialTarget?: BodyId;
  initial?: ModelingOperationFormState;
  unsupportedReason?: string;
  onPreflight(
    submission: ModelingOperationSubmission
  ): Promise<ExactPreflightResult>;
  onSubmit(submission: ModelingOperationSubmission): void;
  onCancel?: () => void;
  onTargetBodyChange?: (bodyId: BodyId) => void;
  onOpeningFaceSelectionChange?: (hashes: number[]) => void;
  onRequestOpeningFaceSelection?: () => void;
}

function initialState(
  operation: ModelingOperationKind,
  targetBodyId: BodyId | '',
  initial: ModelingOperationFormState | undefined
): ModelingOperationFormState {
  if (initial?.operation === operation) {
    return initial;
  }
  switch (operation) {
    case 'mirror':
      return {
        operation,
        value: {
          name: 'Mirror',
          targetBodyId,
          origin: { x: '0', y: '0', z: '0' },
          normal: { x: '1', y: '0', z: '0' }
        }
      };
    case 'shell':
      return {
        operation,
        value: {
          name: 'Shell',
          targetBodyId,
          thickness: '2',
          openingFaceHashes: []
        }
      };
    case 'solid-offset':
      return {
        operation,
        value: {
          name: 'Solid offset',
          targetBodyId,
          distance: '1'
        }
      };
  }
}

interface FieldGroupProps {
  legend: string;
  children: ReactNode;
}

function FieldGroup({ legend, children }: FieldGroupProps) {
  return (
    <fieldset className="field">
      <legend>{legend}</legend>
      <div className="field-triple">{children}</div>
    </fieldset>
  );
}

function preflightMessage(state: ExactPreflightState): ReactNode {
  switch (state.status) {
    case 'idle':
      return null;
    case 'pending':
      return (
        <p className="muted" role="status" aria-live="polite">
          Checking the exact kernel result…
        </p>
      );
    case 'ready':
      return (
        <p className="muted" role="status">
          Exact preflight passed. Review the values, then create the feature.
        </p>
      );
    case 'refused':
      return (
        <p className="field-error" role="alert">
          Exact preflight refused: {state.reason}
        </p>
      );
  }
}

export function ModelingOperationsForm({
  operation,
  scope,
  bodies,
  faceOptions = [],
  initialTarget,
  initial,
  unsupportedReason,
  onPreflight,
  onSubmit,
  onCancel,
  onTargetBodyChange,
  onOpeningFaceSelectionChange,
  onRequestOpeningFaceSelection
}: ModelingOperationsFormProps) {
  const defaultTarget =
    initialTarget ?? bodies.find((body) => !body.consumed)?.bodyId ?? '';
  const [state, setState] = useState<ModelingOperationFormState>(() =>
    initialState(operation, defaultTarget, initial)
  );
  const [preflight, setPreflight] = useState<ExactPreflightState>({
    status: 'idle'
  });
  const preflightEpoch = useRef(0);

  const effectivePreflight: ExactPreflightState = unsupportedReason
    ? { status: 'refused', reason: unsupportedReason }
    : preflight;
  const validationReason = modelingFormValidationReason(state, scope);
  const canCheck = validationReason === null && unsupportedReason === undefined;

  const invalidatePreflight = () => {
    preflightEpoch.current += 1;
    setPreflight({ status: 'idle' });
  };

  const replaceState = (next: ModelingOperationFormState) => {
    invalidatePreflight();
    setState(next);
  };

  const setName = (name: string) => {
    replaceState({
      ...state,
      value: { ...state.value, name }
    } as ModelingOperationFormState);
  };

  const setTarget = (targetBodyId: BodyId) => {
    onTargetBodyChange?.(targetBodyId);
    if (state.operation === 'shell') {
      const next = {
        ...state,
        value: { ...state.value, targetBodyId, openingFaceHashes: [] }
      } satisfies ModelingOperationFormState;
      onOpeningFaceSelectionChange?.([]);
      replaceState(next);
      return;
    }
    replaceState({
      ...state,
      value: { ...state.value, targetBodyId }
    } as ModelingOperationFormState);
  };

  const submission = () => buildModelingOperationSubmission(state, faceOptions);

  const runPreflight = async () => {
    if (!canCheck) {
      return;
    }
    const epoch = ++preflightEpoch.current;
    setPreflight({ status: 'pending' });
    try {
      const result = await onPreflight(submission());
      if (preflightEpoch.current === epoch) {
        setPreflight(result);
      }
    } catch (error) {
      if (preflightEpoch.current === epoch) {
        setPreflight({
          status: 'refused',
          reason:
            error instanceof Error ? error.message : 'Exact preflight failed.'
        });
      }
    }
  };

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (effectivePreflight.status === 'ready') {
      onSubmit(submission());
      return;
    }
    void runPreflight();
  };

  const buttonLabel =
    effectivePreflight.status === 'pending'
      ? 'Checking exact result…'
      : effectivePreflight.status === 'ready'
        ? `Create ${OPERATION_LABELS[operation].toLowerCase()}`
        : effectivePreflight.status === 'refused'
          ? 'Recheck exact result'
          : 'Check exact result';

  return (
    <form className="feature-form" onSubmit={handleSubmit}>
      <label className="field">
        <span>Name</span>
        <input
          value={state.value.name}
          onChange={(event) => setName(event.target.value)}
        />
      </label>
      <label className="field">
        <span>Target body</span>
        <select
          value={state.value.targetBodyId}
          onChange={(event) => setTarget(event.target.value as BodyId)}
        >
          {bodies.filter((body) => !body.consumed).length === 0 ? (
            <option value="">No live solid bodies</option>
          ) : null}
          {bodies
            .filter((body) => !body.consumed)
            .map((body) => (
              <option key={body.bodyId} value={body.bodyId}>
                {body.name}
              </option>
            ))}
        </select>
      </label>

      {state.operation === 'mirror' ? (
        <>
          <FieldGroup legend="Plane origin">
            {(['x', 'y', 'z'] as const).map((axis) => (
              <ExprInput
                key={axis}
                label={axis.toUpperCase()}
                value={state.value.origin[axis]}
                scope={scope}
                onChange={(value) =>
                  replaceState({
                    ...state,
                    value: {
                      ...state.value,
                      origin: { ...state.value.origin, [axis]: value }
                    }
                  })
                }
              />
            ))}
          </FieldGroup>
          <FieldGroup legend="Plane normal">
            {(['x', 'y', 'z'] as const).map((axis) => (
              <ExprInput
                key={axis}
                label={axis.toUpperCase()}
                value={state.value.normal[axis]}
                scope={scope}
                onChange={(value) =>
                  replaceState({
                    ...state,
                    value: {
                      ...state.value,
                      normal: { ...state.value.normal, [axis]: value }
                    }
                  })
                }
              />
            ))}
          </FieldGroup>
          <p className="muted">
            The original remains; Mirror creates a separate copy without fusion.
          </p>
        </>
      ) : null}

      {state.operation === 'shell' ? (
        <>
          <ExprInput
            label="Wall thickness"
            value={state.value.thickness}
            scope={scope}
            onChange={(thickness) =>
              replaceState({
                ...state,
                value: { ...state.value, thickness }
              })
            }
          />
          <fieldset className="field">
            <legend>Opening faces</legend>
            {onRequestOpeningFaceSelection ? (
              <button
                type="button"
                className="secondary edge-selection-action"
                onClick={onRequestOpeningFaceSelection}
              >
                Pick opening faces in viewport
              </button>
            ) : null}
            <div className="body-picker">
              {faceOptions.length === 0 ? (
                <p className="muted">No exact faces are available.</p>
              ) : null}
              {faceOptions.map((face) => {
                const selected = state.value.openingFaceHashes.includes(
                  face.hash
                );
                return (
                  <button
                    key={face.topologyId}
                    type="button"
                    className={`body-pick-row${selected ? ' selected' : ''}`}
                    aria-pressed={selected}
                    onClick={() => {
                      const selectedHashes = new Set(
                        state.value.openingFaceHashes
                      );
                      if (selected) {
                        selectedHashes.delete(face.hash);
                      } else {
                        selectedHashes.add(face.hash);
                      }
                      const openingFaceHashes = faceOptions
                        .filter((option) => selectedHashes.has(option.hash))
                        .map((option) => option.hash);
                      onOpeningFaceSelectionChange?.(openingFaceHashes);
                      replaceState({
                        ...state,
                        value: { ...state.value, openingFaceHashes }
                      });
                    }}
                  >
                    <span className="pick-order mono">
                      {selected
                        ? state.value.openingFaceHashes.indexOf(face.hash) + 1
                        : ''}
                    </span>
                    <span className="body-name">{face.label}</span>
                  </button>
                );
              })}
            </div>
          </fieldset>
          <p className="muted">
            Positive thickness offsets inward while retaining the source outer
            envelope.
          </p>
        </>
      ) : null}

      {state.operation === 'solid-offset' ? (
        <>
          <ExprInput
            label="Outward distance"
            value={state.value.distance}
            scope={scope}
            onChange={(distance) =>
              replaceState({
                ...state,
                value: { ...state.value, distance }
              })
            }
          />
          <p className="muted">
            Positive distance grows every face outward with sharp intersection
            joins.
          </p>
        </>
      ) : null}

      {validationReason ? (
        <p className="field-error" aria-live="polite">
          {validationReason}
        </p>
      ) : null}
      {preflightMessage(effectivePreflight)}

      <div className="form-actions">
        <button
          type="submit"
          className="primary"
          disabled={
            !canCheck ||
            effectivePreflight.status === 'pending' ||
            unsupportedReason !== undefined
          }
        >
          {buttonLabel}
        </button>
        {onCancel ? (
          <button type="button" className="secondary" onClick={onCancel}>
            Cancel
          </button>
        ) : null}
      </div>
    </form>
  );
}
