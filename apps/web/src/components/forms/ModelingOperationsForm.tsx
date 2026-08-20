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
  type ModelingOperationSubmission,
  type ModelingPathOption,
  type ModelingProfileOption
} from '../../lib/modelingOperations';

const OPERATION_LABELS: Record<ModelingOperationKind, string> = {
  mirror: 'Mirror',
  split: 'Split body',
  shell: 'Shell',
  'solid-offset': 'Solid offset',
  loft: 'Loft',
  sweep: 'Sweep',
  'helical-sweep': 'Helical sweep',
  draft: 'Draft',
  thicken: 'Thicken'
};

export interface ModelingOperationsFormProps {
  operation: ModelingOperationKind;
  scope: Record<string, number>;
  bodies: BodyOption[];
  faceOptions?: ModelingFaceOption[];
  profileOptions?: ModelingProfileOption[];
  pathOptions?: ModelingPathOption[];
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
  profiles: readonly ModelingProfileOption[],
  paths: readonly ModelingPathOption[],
  initial: ModelingOperationFormState | undefined
): ModelingOperationFormState {
  if (initial?.operation === operation) return initial;
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
    case 'split':
      return {
        operation,
        value: {
          name: 'Split',
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
        value: { name: 'Solid offset', targetBodyId, distance: '1' }
      };
    case 'loft':
      return {
        operation,
        value: {
          name: 'Loft',
          sectionIds: profiles.slice(0, 2).map((profile) => profile.id),
          mode: 'ruled'
        }
      };
    case 'sweep':
      return {
        operation,
        value: {
          name: 'Sweep',
          profileId: profiles[0]?.id ?? '',
          pathId: paths[0]?.id ?? '',
          mode: 'standard'
        }
      };
    case 'helical-sweep':
      return {
        operation,
        value: {
          name: 'Helical sweep',
          profileId: profiles[0]?.id ?? '',
          axisOrigin: { x: '0', y: '0', z: '0' },
          axisDirection: { x: '0', y: '0', z: '1' },
          radius: '10',
          pitch: '5',
          turns: '3'
        }
      };
    case 'draft':
      return {
        operation,
        value: {
          name: 'Draft',
          targetBodyId,
          faceHashes: [],
          pullDirection: { x: '0', y: '0', z: '1' },
          neutralPoint: { x: '0', y: '0', z: '0' },
          angleDeg: '3'
        }
      };
    case 'thicken':
      return {
        operation,
        value: {
          name: 'Thicken',
          targetBodyId,
          faceHash: null,
          thickness: '2'
        }
      };
  }
}

function FieldGroup({
  legend,
  children
}: {
  legend: string;
  children: ReactNode;
}) {
  return (
    <fieldset className="field">
      <legend>{legend}</legend>
      <div className="field-triple">{children}</div>
    </fieldset>
  );
}

function VectorFields({
  legend,
  value,
  scope,
  onChange
}: {
  legend: string;
  value: { x: string; y: string; z: string };
  scope: Record<string, number>;
  onChange(value: { x: string; y: string; z: string }): void;
}) {
  return (
    <FieldGroup legend={legend}>
      {(['x', 'y', 'z'] as const).map((axis) => (
        <ExprInput
          key={axis}
          label={axis.toUpperCase()}
          value={value[axis]}
          scope={scope}
          onChange={(component) => onChange({ ...value, [axis]: component })}
        />
      ))}
    </FieldGroup>
  );
}

function FacePicker({
  legend,
  options,
  selected,
  multiple,
  onChange,
  onRequest
}: {
  legend: string;
  options: readonly ModelingFaceOption[];
  selected: readonly number[];
  multiple: boolean;
  onChange(hashes: number[]): void;
  onRequest?: () => void;
}) {
  return (
    <fieldset className="field">
      <legend>{legend}</legend>
      {onRequest ? (
        <button
          type="button"
          className="secondary edge-selection-action"
          onClick={onRequest}
        >
          Pick faces in viewport
        </button>
      ) : null}
      <div className="body-picker">
        {options.length === 0 ? (
          <p className="muted">No exact faces are available.</p>
        ) : null}
        {options.map((face) => {
          const active = selected.includes(face.hash);
          return (
            <button
              key={face.topologyId}
              type="button"
              className={`body-pick-row${active ? ' selected' : ''}`}
              aria-pressed={active}
              onClick={() => {
                if (!multiple) {
                  onChange(active ? [] : [face.hash]);
                  return;
                }
                const next = new Set(selected);
                if (active) {
                  next.delete(face.hash);
                } else {
                  next.add(face.hash);
                }
                onChange(
                  options
                    .filter((option) => next.has(option.hash))
                    .map((option) => option.hash)
                );
              }}
            >
              <span className="pick-order mono">
                {active ? selected.indexOf(face.hash) + 1 : ''}
              </span>
              <span className="body-name">{face.label}</span>
            </button>
          );
        })}
      </div>
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
  profileOptions = [],
  pathOptions = [],
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
    initialState(operation, defaultTarget, profileOptions, pathOptions, initial)
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

  const replaceState = (next: ModelingOperationFormState) => {
    preflightEpoch.current += 1;
    setPreflight({ status: 'idle' });
    setState(next);
  };
  const setName = (name: string) =>
    replaceState({
      ...state,
      value: { ...state.value, name }
    } as ModelingOperationFormState);
  const setTarget = (targetBodyId: BodyId) => {
    onTargetBodyChange?.(targetBodyId);
    if (state.operation === 'shell') {
      onOpeningFaceSelectionChange?.([]);
      replaceState({
        ...state,
        value: { ...state.value, targetBodyId, openingFaceHashes: [] }
      });
      return;
    }
    if (state.operation === 'draft') {
      onOpeningFaceSelectionChange?.([]);
      replaceState({
        ...state,
        value: { ...state.value, targetBodyId, faceHashes: [] }
      });
      return;
    }
    if (state.operation === 'thicken') {
      onOpeningFaceSelectionChange?.([]);
      replaceState({
        ...state,
        value: { ...state.value, targetBodyId, faceHash: null }
      });
      return;
    }
    replaceState({
      ...state,
      value: { ...state.value, targetBodyId }
    } as ModelingOperationFormState);
  };
  const submission = () =>
    buildModelingOperationSubmission(
      state,
      faceOptions,
      profileOptions,
      pathOptions
    );
  const runPreflight = async () => {
    if (!canCheck) return;
    const epoch = ++preflightEpoch.current;
    setPreflight({ status: 'pending' });
    try {
      const result = await onPreflight(submission());
      if (preflightEpoch.current === epoch) setPreflight(result);
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
    if (effectivePreflight.status === 'ready') onSubmit(submission());
    else void runPreflight();
  };
  const buttonLabel =
    effectivePreflight.status === 'pending'
      ? 'Checking exact result…'
      : effectivePreflight.status === 'ready'
        ? `Create ${OPERATION_LABELS[operation].toLowerCase()}`
        : effectivePreflight.status === 'refused'
          ? 'Recheck exact result'
          : 'Check exact result';
  const profileOperation =
    state.operation === 'loft' ||
    state.operation === 'sweep' ||
    state.operation === 'helical-sweep';

  return (
    <form className="feature-form" onSubmit={handleSubmit}>
      <label className="field">
        <span>Name</span>
        <input
          value={state.value.name}
          onChange={(event) => setName(event.target.value)}
        />
      </label>
      {!profileOperation ? (
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
      ) : null}

      {state.operation === 'loft' ? (
        <>
          <label className="field">
            <span>Surface mode</span>
            <select
              value={state.value.mode}
              onChange={(event) =>
                replaceState({
                  ...state,
                  value: {
                    ...state.value,
                    mode: event.target.value as 'ruled' | 'smooth'
                  }
                })
              }
            >
              <option value="ruled">Ruled</option>
              <option value="smooth">Smooth</option>
            </select>
          </label>
          <fieldset className="field">
            <legend>Ordered profile sections</legend>
            {state.value.sectionIds.map((id, index) => (
              <div className="field-pair" key={`${index}:${id}`}>
                <select
                  aria-label={`Loft section ${index + 1}`}
                  value={id}
                  onChange={(event) => {
                    const sectionIds = [...state.value.sectionIds];
                    sectionIds[index] = event.target.value;
                    replaceState({
                      ...state,
                      value: { ...state.value, sectionIds }
                    });
                  }}
                >
                  {profileOptions.map((profile) => (
                    <option key={profile.id} value={profile.id}>
                      {index + 1}. {profile.label}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  className="secondary"
                  disabled={state.value.sectionIds.length <= 2}
                  onClick={() =>
                    replaceState({
                      ...state,
                      value: {
                        ...state.value,
                        sectionIds: state.value.sectionIds.filter(
                          (_, candidate) => candidate !== index
                        )
                      }
                    })
                  }
                >
                  Remove
                </button>
              </div>
            ))}
            <button
              type="button"
              className="secondary"
              disabled={state.value.sectionIds.length >= profileOptions.length}
              onClick={() => {
                const unused = profileOptions.find(
                  (profile) => !state.value.sectionIds.includes(profile.id)
                );
                if (unused) {
                  replaceState({
                    ...state,
                    value: {
                      ...state.value,
                      sectionIds: [...state.value.sectionIds, unused.id]
                    }
                  });
                }
              }}
            >
              Add section
            </button>
          </fieldset>
        </>
      ) : null}

      {state.operation === 'sweep' ? (
        <>
          <label className="field">
            <span>Profile</span>
            <select
              value={state.value.profileId}
              onChange={(event) =>
                replaceState({
                  ...state,
                  value: { ...state.value, profileId: event.target.value }
                })
              }
            >
              {profileOptions.map((profile) => (
                <option key={profile.id} value={profile.id}>
                  {profile.label}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Path sketch</span>
            <select
              value={state.value.pathId}
              onChange={(event) =>
                replaceState({
                  ...state,
                  value: { ...state.value, pathId: event.target.value }
                })
              }
            >
              {pathOptions.map((path) => (
                <option key={path.id} value={path.id}>
                  {path.label}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Surface mode</span>
            <select
              value={state.value.mode}
              onChange={(event) =>
                replaceState({
                  ...state,
                  value: {
                    ...state.value,
                    mode: event.target.value as 'standard' | 'smooth'
                  }
                })
              }
            >
              <option value="standard">Standard</option>
              <option value="smooth">Smooth</option>
            </select>
          </label>
        </>
      ) : null}

      {state.operation === 'helical-sweep' ? (
        <>
          <label className="field">
            <span>Profile</span>
            <select
              value={state.value.profileId}
              onChange={(event) =>
                replaceState({
                  ...state,
                  value: { ...state.value, profileId: event.target.value }
                })
              }
            >
              {profileOptions.map((profile) => (
                <option key={profile.id} value={profile.id}>
                  {profile.label}
                </option>
              ))}
            </select>
          </label>
          <VectorFields
            legend="Axis origin"
            value={state.value.axisOrigin}
            scope={scope}
            onChange={(axisOrigin) =>
              replaceState({
                ...state,
                value: { ...state.value, axisOrigin }
              })
            }
          />
          <VectorFields
            legend="Axis direction"
            value={state.value.axisDirection}
            scope={scope}
            onChange={(axisDirection) =>
              replaceState({
                ...state,
                value: { ...state.value, axisDirection }
              })
            }
          />
          {(['radius', 'pitch', 'turns'] as const).map((field) => (
            <ExprInput
              key={field}
              label={field[0]!.toUpperCase() + field.slice(1)}
              value={state.value[field]}
              scope={scope}
              onChange={(value) =>
                replaceState({
                  ...state,
                  value: { ...state.value, [field]: value }
                })
              }
            />
          ))}
        </>
      ) : null}

      {state.operation === 'mirror' || state.operation === 'split' ? (
        <>
          <VectorFields
            legend="Plane origin"
            value={state.value.origin}
            scope={scope}
            onChange={(origin) =>
              replaceState({ ...state, value: { ...state.value, origin } })
            }
          />
          <VectorFields
            legend="Plane normal"
            value={state.value.normal}
            scope={scope}
            onChange={(normal) =>
              replaceState({ ...state, value: { ...state.value, normal } })
            }
          />
          <p className="muted">
            {state.operation === 'mirror'
              ? 'The original remains; Mirror creates a separate copy without fusion.'
              : 'Split replaces the body with the two halves on either side of the plane.'}
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
          <FacePicker
            legend="Opening faces"
            options={faceOptions}
            selected={state.value.openingFaceHashes}
            multiple
            onChange={(openingFaceHashes) => {
              onOpeningFaceSelectionChange?.(openingFaceHashes);
              replaceState({
                ...state,
                value: { ...state.value, openingFaceHashes }
              });
            }}
            onRequest={onRequestOpeningFaceSelection}
          />
        </>
      ) : null}

      {state.operation === 'solid-offset' ? (
        <ExprInput
          label="Outward distance"
          value={state.value.distance}
          scope={scope}
          onChange={(distance) =>
            replaceState({ ...state, value: { ...state.value, distance } })
          }
        />
      ) : null}

      {state.operation === 'draft' ? (
        <>
          <FacePicker
            legend="Faces to draft"
            options={faceOptions}
            selected={state.value.faceHashes}
            multiple
            onChange={(faceHashes) => {
              onOpeningFaceSelectionChange?.(faceHashes);
              replaceState({
                ...state,
                value: { ...state.value, faceHashes }
              });
            }}
            onRequest={onRequestOpeningFaceSelection}
          />
          <VectorFields
            legend="Pull direction"
            value={state.value.pullDirection}
            scope={scope}
            onChange={(pullDirection) =>
              replaceState({
                ...state,
                value: { ...state.value, pullDirection }
              })
            }
          />
          <VectorFields
            legend="Neutral point"
            value={state.value.neutralPoint}
            scope={scope}
            onChange={(neutralPoint) =>
              replaceState({
                ...state,
                value: { ...state.value, neutralPoint }
              })
            }
          />
          <ExprInput
            label="Draft angle (degrees)"
            value={state.value.angleDeg}
            scope={scope}
            onChange={(angleDeg) =>
              replaceState({ ...state, value: { ...state.value, angleDeg } })
            }
          />
        </>
      ) : null}

      {state.operation === 'thicken' ? (
        <>
          <FacePicker
            legend="Face to thicken"
            options={faceOptions}
            selected={
              state.value.faceHash === null ? [] : [state.value.faceHash]
            }
            multiple={false}
            onChange={(hashes) => {
              onOpeningFaceSelectionChange?.(hashes);
              replaceState({
                ...state,
                value: { ...state.value, faceHash: hashes[0] ?? null }
              });
            }}
            onRequest={onRequestOpeningFaceSelection}
          />
          <ExprInput
            label="Signed thickness"
            value={state.value.thickness}
            scope={scope}
            onChange={(thickness) =>
              replaceState({
                ...state,
                value: { ...state.value, thickness }
              })
            }
          />
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
