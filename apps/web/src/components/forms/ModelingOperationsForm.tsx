import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode
} from 'react';
import type { BodyId } from '@openzcad/shared';
import { ExprInput } from '../ExprInput';
import { previewExpression } from '../../lib/model';
import type { BodyOption } from './FeatureForms';
import { holePositionLabels } from '../../lib/holePositionAxes';
import { isPickListRow } from './pickListRow';
import type { FormFacePick } from '../../lib/holeFacePick';
import {
  buildModelingOperationSubmission,
  modelingFormValidation,
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
  hole: 'Hole',
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
  /** The form reopens an existing feature; the submit reads Apply, not Create. */
  editing?: boolean;
  /**
   * The latest face the user clicked in the viewport while this form was
   * open. A new object per click: shell and draft toggle the face in their
   * list, hole and thicken replace their single face.
   */
  viewportFacePick?: FormFacePick | null;
  unsupportedReason?: string;
  onPreflight(
    submission: ModelingOperationSubmission
  ): Promise<ExactPreflightResult>;
  onSubmit(submission: ModelingOperationSubmission): void;
  onCancel?: () => void;
  onTargetBodyChange?: (bodyId: BodyId) => void;
  onOpeningFaceSelectionChange?: (hashes: number[]) => void;
  onRequestOpeningFaceSelection?: () => void;
  /**
   * The Hole card's values as numbers, on every change, so the viewport can
   * draw the bore before it exists; null once nothing can be placed (no
   * face, an unresolved expression) and when the card closes.
   */
  onHoleDraftChange?: (draft: HoleDraft | null) => void;
  /**
   * What the viewport has to say about the drawn bore: why there is none,
   * or that it misses the body. Shown under the position it is about.
   */
  holePreviewNotice?: string | null;
}

/** A Hole card's values, resolved: what the viewport ghost is drawn from. */
export interface HoleDraft {
  targetBodyId: BodyId;
  faceHash: number;
  u: number;
  v: number;
  diameter: number;
  /**
   * The widest cutting tool: the counterbore or countersink diameter when
   * the style has one; null when that does not resolve.
   */
  outerDiameter: number | null;
  depth: number | 'through';
}

function holeDraftFor(
  state: ModelingOperationFormState,
  scope: Record<string, number>
): HoleDraft | null {
  if (
    state.operation !== 'hole' ||
    state.value.faceHash === null ||
    !state.value.targetBodyId
  ) {
    return null;
  }
  const number = (text: string): number | null => {
    const preview = previewExpression(text, scope);
    return preview.ok && preview.value !== undefined ? preview.value : null;
  };
  const u = number(state.value.position.u);
  const v = number(state.value.position.v);
  const diameter = number(state.value.diameter);
  const depth =
    state.value.depthMode === 'through'
      ? ('through' as const)
      : number(state.value.depth);
  // A size that cannot drill is the form's own refusal, said above the
  // buttons; the viewport then draws nothing rather than a second message.
  if (
    u === null ||
    v === null ||
    diameter === null ||
    !(diameter > 0) ||
    depth === null ||
    (depth !== 'through' && !(depth > 0))
  ) {
    return null;
  }
  const styleDiameter =
    state.value.style === 'counterbore'
      ? number(state.value.counterboreDiameter)
      : state.value.style === 'countersink'
        ? number(state.value.countersinkDiameter)
        : diameter;
  return {
    targetBodyId: state.value.targetBodyId,
    faceHash: state.value.faceHash,
    u,
    v,
    diameter,
    outerDiameter:
      styleDiameter === null ? null : Math.max(diameter, styleDiameter),
    depth
  };
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
          mode: 'ruled',
          endPoint: null
        }
      };
    case 'sweep':
      return {
        operation,
        value: {
          name: 'Sweep',
          profileId: profiles[0]?.id ?? '',
          pathId: paths[0]?.id ?? '',
          mode: 'standard',
          guideId: ''
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
    case 'hole':
      return {
        operation,
        value: {
          name: 'Hole',
          targetBodyId,
          faceHash: null,
          style: 'simple',
          diameter: '6',
          depthMode: 'through',
          depth: '10',
          counterboreDiameter: '11',
          counterboreDepth: '3',
          countersinkDiameter: '12',
          countersinkAngleDeg: '90',
          position: { u: '0', v: '0' }
        }
      };
  }
}

function FieldGroup({
  legend,
  children,
  message
}: {
  legend: string;
  children: ReactNode;
  /** Below the fields, across the group: a refusal about these values. */
  message?: ReactNode;
}) {
  return (
    <fieldset className="field">
      <legend>{legend}</legend>
      <div className="field-triple">{children}</div>
      {message}
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

/** The state on a new target body with every face field cleared. */
function withTargetBody(
  state: ModelingOperationFormState,
  targetBodyId: BodyId
): ModelingOperationFormState {
  switch (state.operation) {
    case 'shell':
      return {
        ...state,
        value: { ...state.value, targetBodyId, openingFaceHashes: [] }
      };
    case 'draft':
      return {
        ...state,
        value: { ...state.value, targetBodyId, faceHashes: [] }
      };
    case 'hole':
      return {
        ...state,
        value: { ...state.value, targetBodyId, faceHash: null }
      };
    case 'thicken':
      return {
        ...state,
        value: { ...state.value, targetBodyId, faceHash: null }
      };
    default:
      return state;
  }
}

/**
 * The principal planes as one-click choices, named as the sketch plane
 * picker names them. Mirror and Split used to offer six number fields and
 * nothing else; the numbers stay for the rare custom plane.
 */
const PRINCIPAL_PLANES: readonly {
  label: string;
  normal: { x: string; y: string; z: string };
}[] = [
  { label: 'Top (XY)', normal: { x: '0', y: '0', z: '1' } },
  { label: 'Front (XZ)', normal: { x: '0', y: '1', z: '0' } },
  { label: 'Right (YZ)', normal: { x: '1', y: '0', z: '0' } }
];

function PlaneChips({
  normal,
  onChoose
}: {
  normal: { x: string; y: string; z: string };
  onChoose(normal: { x: string; y: string; z: string }): void;
}) {
  return (
    <div className="field">
      <span>Plane</span>
      <div className="plane-chips" role="group" aria-label="Principal planes">
        {PRINCIPAL_PLANES.map((plane) => {
          const active =
            Number(normal.x) === Number(plane.normal.x) &&
            Number(normal.y) === Number(plane.normal.y) &&
            Number(normal.z) === Number(plane.normal.z);
          return (
            <button
              key={plane.label}
              type="button"
              className="plane-chip"
              aria-pressed={active}
              onClick={() => onChoose({ ...plane.normal })}
            >
              {plane.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function toggleHash(hashes: readonly number[], hash: number): number[] {
  return hashes.includes(hash)
    ? hashes.filter((candidate) => candidate !== hash)
    : [...hashes, hash];
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
      <div className="pick-list">
        {options.length === 0 ? (
          <p className="muted">No exact faces are available.</p>
        ) : null}
        {options.map((face) => {
          const active = selected.includes(face.hash);
          return (
            <button
              key={face.topologyId}
              type="button"
              className={`pick-row${active ? ' selected' : ''}`}
              aria-pressed={active}
              title={face.detail}
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

/** "Not created — the hole misses the body." rather than kernel jargon. */
function refusalSentence(reason: string, editing: boolean): string {
  const plain = reason.replace(/^Feature "[^"]*":\s*/, '');
  return `${editing ? 'Not applied' : 'Not created'} — ${plain}`;
}

/**
 * A refusal about where a hole sits, shown under its U and V fields. The
 * builder's own sentences: the bore misses the body, or points out of it.
 */
function holePositionRefusal(
  state: ModelingOperationFormState,
  preflight: ExactPreflightState
): string | null {
  return state.operation === 'hole' &&
    preflight.status === 'refused' &&
    /misses the body|points away from the body/i.test(preflight.reason)
    ? preflight.reason
    : null;
}

function preflightMessage(
  state: ExactPreflightState,
  editing: boolean
): ReactNode {
  switch (state.status) {
    case 'idle':
    case 'ready':
      return null;
    case 'pending':
      return (
        <p className="muted" role="status" aria-live="polite">
          Checking the exact kernel result…
        </p>
      );
    case 'refused':
      return (
        <p className="field-error" role="alert">
          {refusalSentence(state.reason, editing)}
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
  editing = false,
  initial,
  viewportFacePick,
  unsupportedReason,
  onPreflight,
  onSubmit,
  onCancel,
  onTargetBodyChange,
  onOpeningFaceSelectionChange,
  onRequestOpeningFaceSelection,
  onHoleDraftChange,
  holePreviewNotice = null
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
  // A check still running when the card closes must not create the feature
  // after the user cancelled it: leaving retires its epoch.
  useEffect(
    () => () => {
      preflightEpoch.current += 1;
    },
    []
  );
  const checkedSubmission = useRef<string | null>(null);
  // Keyed on the resolved numbers, so typing a character that leaves the
  // value unchanged does not redraw the ghost.
  const holeDraft = holeDraftFor(state, scope);
  const holeDraftKey = holeDraft ? JSON.stringify(holeDraft) : null;
  const holeDraftCallback = useRef(onHoleDraftChange);
  holeDraftCallback.current = onHoleDraftChange;
  useEffect(() => {
    holeDraftCallback.current?.(
      holeDraftKey ? (JSON.parse(holeDraftKey) as HoleDraft) : null
    );
  }, [holeDraftKey]);
  useEffect(() => () => holeDraftCallback.current?.(null), []);
  const consumedFacePick = useRef<FormFacePick | null>(null);
  const pickTarget =
    state.operation === 'hole' ||
    state.operation === 'shell' ||
    state.operation === 'draft' ||
    state.operation === 'thicken'
      ? state.value.targetBodyId
      : null;
  useEffect(() => {
    if (!viewportFacePick || consumedFacePick.current === viewportFacePick)
      return;
    consumedFacePick.current = viewportFacePick;
    // A pick on another live body arrives together with a new `initialTarget`:
    // the workspace retargeted the form, so the form follows and starts its
    // face fields over on that body instead of dropping the pick.
    const retargeted =
      pickTarget !== viewportFacePick.bodyId &&
      initialTarget === viewportFacePick.bodyId;
    if (
      (pickTarget !== viewportFacePick.bodyId && !retargeted) ||
      !faceOptions.some((face) => face.hash === viewportFacePick.hash)
    )
      return;
    // A pick changes the exact command even if an earlier preflight is still running.
    preflightEpoch.current += 1;
    setPreflight({ status: 'idle' });
    setState((previous): ModelingOperationFormState => {
      const { bodyId, hash } = viewportFacePick;
      const current = retargeted ? withTargetBody(previous, bodyId) : previous;
      switch (current.operation) {
        case 'shell':
          return current.value.targetBodyId === bodyId
            ? {
                ...current,
                value: {
                  ...current.value,
                  openingFaceHashes: toggleHash(
                    current.value.openingFaceHashes,
                    hash
                  )
                }
              }
            : current;
        case 'draft':
          return current.value.targetBodyId === bodyId
            ? {
                ...current,
                value: {
                  ...current.value,
                  faceHashes: toggleHash(current.value.faceHashes, hash)
                }
              }
            : current;
        case 'hole':
          return current.value.targetBodyId === bodyId
            ? { ...current, value: { ...current.value, faceHash: hash } }
            : current;
        case 'thicken':
          return current.value.targetBodyId === bodyId
            ? { ...current, value: { ...current.value, faceHash: hash } }
            : current;
        default:
          return current;
      }
    });
  }, [viewportFacePick, pickTarget, initialTarget, faceOptions]);
  const effectivePreflight: ExactPreflightState = unsupportedReason
    ? { status: 'refused', reason: unsupportedReason }
    : preflight;
  const validation = modelingFormValidation(state, scope);
  const canCheck = validation === null && unsupportedReason === undefined;

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
    if (state.operation === 'hole') {
      onOpeningFaceSelectionChange?.([]);
      replaceState({
        ...state,
        value: { ...state.value, targetBodyId, faceHash: null }
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
  /**
   * Create is one press: it checks the exact result and, when that builds,
   * creates the feature with the values it checked. It used to stop half-way
   * ("Check exact result", then "Exact preflight passed. Review the values,
   * then create the feature.", then a second press) with nothing new to
   * review in between — the check draws no preview.
   */
  const runPreflight = async () => {
    if (!canCheck) return;
    const epoch = ++preflightEpoch.current;
    setPreflight({ status: 'pending' });
    try {
      const candidate = submission();
      const result = await onPreflight(candidate);
      if (preflightEpoch.current === epoch) {
        checkedSubmission.current =
          result.status === 'ready' ? JSON.stringify(candidate) : null;
        setPreflight(result);
        if (result.status === 'ready') {
          onSubmit(candidate);
        }
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
    if (!canCheck) return;
    if (effectivePreflight.status !== 'ready') {
      void runPreflight();
      return;
    }
    try {
      const candidate = submission();
      if (checkedSubmission.current !== JSON.stringify(candidate)) {
        throw new Error(
          'The selected references changed. Recheck the exact result.'
        );
      }
      onSubmit(candidate);
    } catch (error) {
      setPreflight({
        status: 'refused',
        reason:
          error instanceof Error
            ? error.message
            : 'Selected references are unavailable.'
      });
    }
  };
  const buttonLabel =
    effectivePreflight.status === 'pending'
      ? 'Checking exact result…'
      : `${editing ? 'Apply' : 'Create'} ${OPERATION_LABELS[operation].toLowerCase()}`;
  const positionRefusal = holePositionRefusal(state, effectivePreflight);
  const selectedFace =
    state.operation === 'hole'
      ? faceOptions.find((face) => face.hash === state.value.faceHash)
      : undefined;
  const positionLabels = holePositionLabels(selectedFace?.normal);
  const profileOperation =
    state.operation === 'loft' ||
    state.operation === 'sweep' ||
    state.operation === 'helical-sweep';

  return (
    <form
      className="feature-form"
      onSubmit={handleSubmit}
      onKeyDown={(event) => {
        // Enter on a face row submits (see `isPickListRow`).
        if (event.key === 'Enter' && isPickListRow(event.target)) {
          event.preventDefault();
          event.currentTarget.requestSubmit();
        }
      }}
    >
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
          <label className="field">
            <input
              type="checkbox"
              checked={state.value.endPoint !== null}
              onChange={(event) =>
                replaceState({
                  ...state,
                  value: {
                    ...state.value,
                    endPoint: event.target.checked
                      ? { x: '0', y: '0', z: '0' }
                      : null
                  }
                })
              }
            />
            <span>Close the last section to an apex point</span>
          </label>
          {state.value.endPoint === null ? null : (
            <>
              <VectorFields
                legend="Apex point"
                value={state.value.endPoint}
                scope={scope}
                onChange={(endPoint) =>
                  replaceState({
                    ...state,
                    value: { ...state.value, endPoint }
                  })
                }
              />
              <p className="muted">
                {state.value.mode === 'smooth'
                  ? 'An apex point needs Ruled mode: smooth section surfaces do not close against an apex.'
                  : 'The apex closes the end of the run, and has to stand off the last section\u2019s plane. To point the other end instead, reverse the section order.'}
              </p>
            </>
          )}
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
            <span>Guide rail</span>
            <select
              value={state.value.guideId}
              onChange={(event) =>
                replaceState({
                  ...state,
                  value: { ...state.value, guideId: event.target.value }
                })
              }
            >
              <option value="">None — follow the path</option>
              {pathOptions
                .filter((path) => path.id !== state.value.pathId)
                .map((path) => (
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
          {state.value.guideId === '' ? null : (
            <p className="muted">
              {state.value.mode === 'smooth'
                ? 'A guide rail needs Standard surface mode: the guided sweep takes no surface-mode control, so a Smooth sweep would be rebuilt at a surfacing nobody asked for.'
                : 'The profile turns to keep facing the rail instead of holding a rotation-minimizing frame. Both the path and the rail must be one curve — a line, or an arc of at most a quarter turn.'}
            </p>
          )}
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
          <PlaneChips
            normal={state.value.normal}
            onChoose={(normal) =>
              replaceState({ ...state, value: { ...state.value, normal } })
            }
          />
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

      {state.operation === 'hole' ? (
        <>
          <FacePicker
            legend="Entry face"
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
          <label className="field">
            <span>Style</span>
            <select
              value={state.value.style}
              onChange={(event) =>
                replaceState({
                  ...state,
                  value: {
                    ...state.value,
                    style: event.target.value as
                      'simple' | 'counterbore' | 'countersink'
                  }
                })
              }
            >
              <option value="simple">Simple</option>
              <option value="counterbore">Counterbore</option>
              <option value="countersink">Countersink</option>
            </select>
          </label>
          <ExprInput
            label="Diameter"
            value={state.value.diameter}
            scope={scope}
            onChange={(diameter) =>
              replaceState({ ...state, value: { ...state.value, diameter } })
            }
          />
          <label className="field">
            <span>Depth</span>
            <select
              value={state.value.depthMode}
              onChange={(event) =>
                replaceState({
                  ...state,
                  value: {
                    ...state.value,
                    depthMode: event.target.value as 'blind' | 'through'
                  }
                })
              }
            >
              <option value="through">Through all</option>
              <option value="blind">Blind</option>
            </select>
          </label>
          {state.value.depthMode === 'blind' ? (
            <ExprInput
              label="Blind depth"
              value={state.value.depth}
              scope={scope}
              onChange={(depth) =>
                replaceState({ ...state, value: { ...state.value, depth } })
              }
            />
          ) : null}
          {state.value.style === 'counterbore' ? (
            <>
              <ExprInput
                label="Counterbore diameter"
                value={state.value.counterboreDiameter}
                scope={scope}
                onChange={(counterboreDiameter) =>
                  replaceState({
                    ...state,
                    value: { ...state.value, counterboreDiameter }
                  })
                }
              />
              <ExprInput
                label="Counterbore depth"
                value={state.value.counterboreDepth}
                scope={scope}
                onChange={(counterboreDepth) =>
                  replaceState({
                    ...state,
                    value: { ...state.value, counterboreDepth }
                  })
                }
              />
            </>
          ) : null}
          {state.value.style === 'countersink' ? (
            <>
              <ExprInput
                label="Countersink diameter"
                value={state.value.countersinkDiameter}
                scope={scope}
                onChange={(countersinkDiameter) =>
                  replaceState({
                    ...state,
                    value: { ...state.value, countersinkDiameter }
                  })
                }
              />
              <ExprInput
                label="Countersink angle (deg)"
                value={state.value.countersinkAngleDeg}
                scope={scope}
                onChange={(countersinkAngleDeg) =>
                  replaceState({
                    ...state,
                    value: { ...state.value, countersinkAngleDeg }
                  })
                }
              />
            </>
          ) : null}
          <FieldGroup
            legend="Position on face (from centre)"
            message={
              positionRefusal ? (
                // The refusal belongs to the position it is about, not to a
                // line below the buttons.
                <p className="field-error" role="alert">
                  {refusalSentence(positionRefusal, editing)}
                </p>
              ) : holePreviewNotice ? (
                // Before Create: why the viewport draws no bore, or that the
                // one it draws misses. Advisory; the exact check decides.
                <p className="field-error" aria-live="polite">
                  {holePreviewNotice}
                </p>
              ) : null
            }
          >
            {(['u', 'v'] as const).map((axis) => (
              <ExprInput
                key={axis}
                // The face's frame decides which world axis U and V run
                // along; "U" alone sent a −40 off the plate's short side.
                label={positionLabels[axis]}
                value={state.value.position[axis]}
                scope={scope}
                onChange={(component) =>
                  replaceState({
                    ...state,
                    value: {
                      ...state.value,
                      position: { ...state.value.position, [axis]: component }
                    }
                  })
                }
              />
            ))}
          </FieldGroup>
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

      {validation ? (
        // Something still to choose is a next step, not a mistake: it reads
        // as a hint until the user has typed a value that does not resolve.
        <p
          className={validation.kind === 'missing' ? 'muted' : 'field-error'}
          aria-live="polite"
        >
          {validation.reason}
        </p>
      ) : null}
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
      {/* Below the actions on purpose: it appears in answer to the button,
          and above it the button moved under the pointer that pressed it. */}
      {positionRefusal ? null : preflightMessage(effectivePreflight, editing)}
    </form>
  );
}
