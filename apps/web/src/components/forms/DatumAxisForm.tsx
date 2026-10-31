import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Trash2 } from 'lucide-react';
import type { AnyCommand } from '@openzcad/command-system';
import type {
  BodyId,
  DatumAxisEdgeSource,
  DatumAxisFaceSource,
  EdgeVertexPointSource,
  FacePlaneSource,
  FeatureId,
  FeatureNode,
  ProjectDocument,
  UnitSystem
} from '@openzcad/shared';
import { affectedFeatureTargets } from '../../lib/affectedFeatureTargets';
import { CARD_EYEBROWS } from '../../lib/cardEyebrows';
import { commandOutcomeMessage } from '../../lib/commandOutcome';
import {
  DATUM_AXIS_MODE_LABELS,
  buildDatumAxisDefinition,
  datumAxisCommand,
  datumAxisEdgeFromPick,
  datumAxisEdgeLabel,
  datumAxisFaceFromPick,
  datumAxisFaceLabel,
  datumAxisFormStateFromFeature,
  datumAxisFormValidation,
  newDatumAxisFormState,
  nextDatumAxisName,
  type DatumAxisFormState,
  type DatumAxisMode,
  type DatumAxisSubmission
} from '../../lib/datumAxes';
import {
  datumFaceSourceFromPick,
  datumSourceKey,
  datumSourceOptions,
  datumVertexFromEdgePick,
  datumVertexKey,
  datumVertexOption,
  faceSourceOption,
  requireResolvedDatums,
  type DatumPointDraft,
  type DatumPointOption,
  type DatumSourceOption
} from '../../lib/datumPlanes';
import type {
  ExactPreflightResult,
  ExactPreflightState
} from '../../lib/modelingOperations';
import { CardHeader } from '../CardHeader';
import { ExprInput } from '../ExprInput';
import { PanelOverflow } from '../PanelOverflow';
import type { DatumPlaneCardApp } from './DatumPlaneForm';

/** One viewport pick, as every slot of the Axis card could read it. */
export interface DatumAxisPick {
  /** Identity of the pick, so the card acts on each new one once. */
  key: string;
  edge: DatumAxisEdgeSource | { reason: string } | null;
  vertex: EdgeVertexPointSource | { reason: string } | null;
  revolution: DatumAxisFaceSource | { reason: string } | null;
  plane: FacePlaneSource | null;
}

export interface DatumAxisFormProps {
  initial: DatumAxisFormState;
  /** Principal planes, earlier datum planes and any offered face. */
  planes: readonly DatumSourceOption[];
  scope: Record<string, number>;
  units?: UnitSystem;
  editing?: boolean;
  /** Labels for an edited axis's own edge or face, which no pick restates. */
  labels?: { edge?: string; face?: string };
  /** The current viewport pick, read according to the mode. */
  pick?: DatumAxisPick | null;
  /** Vertices to offer from the start: those an edited axis already uses. */
  vertexOptions?: readonly DatumPointOption[];
  /** Labels the card shows for picked sources. */
  describe?: {
    edge(source: DatumAxisEdgeSource): string;
    face(source: DatumAxisFaceSource): string;
    vertex(source: EdgeVertexPointSource): DatumPointOption;
    plane(source: FacePlaneSource): DatumSourceOption;
  };
  unsupportedReason?: string;
  onPreflight(submission: DatumAxisSubmission): Promise<ExactPreflightResult>;
  onSubmit(submission: DatumAxisSubmission): void;
  onCancel(): void;
  onDraftChange?(): void;
}

const MODES: readonly DatumAxisMode[] = [
  'two-point',
  'edge',
  'cylinder',
  'plane-intersection'
];

/**
 * The Axis card (R01): an axis through two points, along a straight edge,
 * along a cylinder's or cone's axis, or where two planes meet, with Reverse
 * direction. Nothing reaches the document until Done, and Done first proves
 * the exact build resolves the axis.
 */
export function DatumAxisForm({
  initial,
  planes,
  scope,
  units,
  editing = false,
  labels = {},
  pick = null,
  vertexOptions = [],
  describe,
  unsupportedReason,
  onPreflight,
  onSubmit,
  onCancel,
  onDraftChange
}: DatumAxisFormProps) {
  const [state, setState] = useState(initial);
  const [preflight, setPreflight] = useState<ExactPreflightState>({
    status: 'idle'
  });
  const epoch = useRef(0);
  useEffect(
    () => () => {
      epoch.current += 1;
    },
    []
  );
  const [pickedVertices, setPickedVertices] = useState<DatumPointOption[]>([]);
  const [pickedPlanes, setPickedPlanes] = useState<DatumSourceOption[]>([]);
  const [edgeLabel, setEdgeLabel] = useState(labels.edge ?? null);
  const [faceLabel, setFaceLabel] = useState(labels.face ?? null);
  const [pickNote, setPickNote] = useState<string | null>(null);
  const replace = (next: DatumAxisFormState) => {
    epoch.current += 1;
    setPreflight({ status: 'idle' });
    onDraftChange?.();
    setState(next);
  };
  // Each new viewport pick fills the slot the current mode is asking for.
  const seenPick = useRef<string | null>(pick?.key ?? null);
  useEffect(() => {
    if (!pick || pick.key === seenPick.current) return;
    seenPick.current = pick.key;
    setPickNote(null);
    const refuse = (value: object | null): string | null =>
      value && 'reason' in value && typeof value.reason === 'string'
        ? value.reason
        : null;
    switch (state.mode) {
      case 'edge': {
        if (!pick.edge || 'reason' in pick.edge) {
          setPickNote(refuse(pick.edge) ?? 'Pick a straight edge.');
          return;
        }
        setEdgeLabel(describe?.edge(pick.edge) ?? 'Picked edge');
        replace({ ...state, edge: pick.edge });
        return;
      }
      case 'cylinder': {
        if (!pick.revolution || 'reason' in pick.revolution) {
          setPickNote(
            refuse(pick.revolution) ?? 'Pick a cylindrical or conical face.'
          );
          return;
        }
        setFaceLabel(describe?.face(pick.revolution) ?? 'Picked face');
        replace({ ...state, face: pick.revolution });
        return;
      }
      case 'two-point': {
        if (!pick.vertex || 'reason' in pick.vertex) {
          setPickNote(
            refuse(pick.vertex) ?? 'Pick an edge near its end for a point.'
          );
          return;
        }
        const option = describe?.vertex(pick.vertex) ?? {
          key: datumVertexKey(pick.vertex),
          label: 'Picked vertex',
          source: pick.vertex
        };
        setPickedVertices((current) =>
          current.some((vertex) => vertex.key === option.key)
            ? current
            : [...current, option]
        );
        const index = state.points.findIndex((point) => point === null);
        if (index < 0) return;
        const points = [...state.points] as DatumAxisFormState['points'];
        points[index] = { type: 'vertex', source: pick.vertex };
        replace({ ...state, points });
        return;
      }
      case 'plane-intersection': {
        if (!pick.plane) {
          setPickNote('Pick a flat face to offer it as a plane.');
          return;
        }
        const option = describe?.plane(pick.plane) ?? {
          key: datumSourceKey(pick.plane),
          label: 'Picked face',
          source: pick.plane
        };
        setPickedPlanes((current) =>
          current.some((plane) => plane.key === option.key)
            ? current
            : [...current, option]
        );
        replace(
          state.sourceA && !state.sourceB
            ? { ...state, sourceB: option.source }
            : { ...state, sourceA: option.source }
        );
        return;
      }
    }
    // Only a new pick acts; the state it reads is this render's.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pick?.key]);

  const vertices = [
    ...vertexOptions,
    ...pickedVertices.filter(
      (vertex) => !vertexOptions.some((option) => option.key === vertex.key)
    )
  ];
  const options = [
    ...planes,
    ...pickedPlanes.filter(
      (plane) => !planes.some((option) => option.key === plane.key)
    )
  ];
  const validation = datumAxisFormValidation(state, scope, units);
  const blocked = unsupportedReason !== undefined;
  const canCheck = validation === null && !blocked;

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canCheck || preflight.status === 'pending') return;
    const current = ++epoch.current;
    const submission: DatumAxisSubmission = {
      name: state.name.trim(),
      definition: buildDatumAxisDefinition(state)
    };
    setPreflight({ status: 'pending' });
    try {
      const result = await onPreflight(submission);
      if (epoch.current !== current) return;
      setPreflight(result);
      if (result.status === 'ready') onSubmit(submission);
    } catch (error) {
      if (epoch.current !== current) return;
      setPreflight({
        status: 'refused',
        reason:
          error instanceof Error
            ? error.message
            : 'The axis could not be checked.'
      });
    }
  };

  const planeSlot = (role: 'sourceA' | 'sourceB', label: string) => {
    const selected = state[role];
    return (
      <label className="field">
        <span>{label}</span>
        <select
          value={selected ? datumSourceKey(selected) : ''}
          aria-label={label}
          onChange={(event) => {
            const option = options.find(
              (candidate) => candidate.key === event.target.value
            );
            replace({ ...state, [role]: option?.source ?? null });
          }}
        >
          <option value="">Choose a plane…</option>
          {options.map((option) => (
            <option key={option.key} value={option.key}>
              {option.label}
            </option>
          ))}
        </select>
      </label>
    );
  };

  const pointSlot = (index: 0 | 1, label: string) => {
    const draft = state.points[index];
    const key =
      draft?.type === 'vertex'
        ? datumVertexKey(draft.source)
        : draft
          ? 'typed'
          : '';
    const setPoint = (next: DatumPointDraft | null) => {
      const points = [...state.points] as DatumAxisFormState['points'];
      points[index] = next;
      replace({ ...state, points });
    };
    const ownVertex =
      draft?.type === 'vertex' && !vertices.some((vertex) => vertex.key === key)
        ? [{ key, label: 'Vertex', source: draft.source }]
        : [];
    return (
      <>
        <label className="field">
          <span>{label}</span>
          <select
            value={key}
            aria-label={label}
            aria-description="Pick an edge near its end in the viewport, or type a position"
            onChange={(event) => {
              const value = event.target.value;
              const vertex = [...ownVertex, ...vertices].find(
                (candidate) => candidate.key === value
              );
              setPoint(
                value === 'typed'
                  ? draft?.type === 'typed'
                    ? draft
                    : { type: 'typed', x: '0', y: '0', z: '0' }
                  : vertex
                    ? { type: 'vertex', source: vertex.source }
                    : null
              );
            }}
          >
            <option value="">Choose a point…</option>
            {[...ownVertex, ...vertices].map((vertex) => (
              <option key={vertex.key} value={vertex.key}>
                {vertex.label}
              </option>
            ))}
            <option value="typed">Type a position</option>
          </select>
        </label>
        {draft?.type === 'typed'
          ? (['x', 'y', 'z'] as const).map((axis) => (
              <ExprInput
                key={axis}
                label={`${label} ${axis.toUpperCase()}`}
                value={draft[axis]}
                scope={scope}
                {...(units
                  ? {
                      quantity: { documentUnits: units, dimension: 'length' }
                    }
                  : {})}
                onChange={(value) => setPoint({ ...draft, [axis]: value })}
              />
            ))
          : null}
      </>
    );
  };

  const buttonLabel =
    preflight.status === 'pending'
      ? 'Checking the axis…'
      : editing
        ? 'Apply'
        : 'Done';

  return (
    <form className="feature-form" onSubmit={(event) => void submit(event)}>
      <label className="field">
        <span>Name</span>
        <input
          value={state.name}
          onChange={(event) => replace({ ...state, name: event.target.value })}
        />
      </label>
      <div className="plane-chips" role="group" aria-label="Axis type">
        {MODES.map((mode) => (
          <button
            key={mode}
            type="button"
            className="plane-chip"
            aria-pressed={state.mode === mode}
            onClick={() => {
              setPickNote(null);
              replace({ ...state, mode });
            }}
          >
            {DATUM_AXIS_MODE_LABELS[mode]}
          </button>
        ))}
      </div>
      {state.mode === 'two-point' ? (
        <>
          {pointSlot(0, 'From point')}
          {pointSlot(1, 'To point')}
        </>
      ) : state.mode === 'edge' ? (
        <p className="muted" aria-live="polite">
          {state.edge
            ? `Along ${edgeLabel ?? 'the picked edge'}`
            : 'Pick a straight edge in the viewport.'}
        </p>
      ) : state.mode === 'cylinder' ? (
        <p className="muted" aria-live="polite">
          {state.face
            ? `Axis of ${faceLabel ?? 'the picked face'}`
            : 'Pick a cylindrical or conical face in the viewport.'}
        </p>
      ) : (
        <>
          {planeSlot('sourceA', 'Plane A')}
          {planeSlot('sourceB', 'Plane B')}
        </>
      )}
      {pickNote ? (
        <p className="muted" aria-live="polite">
          {pickNote}
        </p>
      ) : null}
      <label className="field-check">
        <input
          type="checkbox"
          checked={state.reverseDirection}
          onChange={(event) =>
            replace({ ...state, reverseDirection: event.target.checked })
          }
        />
        <span>Reverse direction</span>
      </label>
      {validation ? (
        <p
          className={validation.kind === 'missing' ? 'muted' : 'field-error'}
          aria-live="polite"
        >
          {validation.reason}
        </p>
      ) : null}
      <div className="form-footer">
        <div className="form-actions">
          <button
            type="button"
            className="secondary"
            onClick={onCancel}
            aria-keyshortcuts="Escape"
          >
            Cancel
            <kbd className="kbd-inline kbd-quiet" aria-hidden="true">
              Esc
            </kbd>
          </button>
          <button
            type="submit"
            className="primary"
            disabled={!canCheck || preflight.status === 'pending'}
            aria-keyshortcuts="Enter"
          >
            {buttonLabel}
            <kbd className="kbd-inline" aria-hidden="true">
              ↵
            </kbd>
          </button>
        </div>
        {blocked ? (
          <p className="field-error" role="alert">
            {unsupportedReason}
          </p>
        ) : preflight.status === 'pending' ? (
          <p className="muted" role="status" aria-live="polite">
            Checking that the axis resolves…
          </p>
        ) : preflight.status === 'refused' ? (
          <p className="field-error" role="alert">
            {`${editing ? 'Not applied' : 'Not created'} — ${preflight.reason.replace(/^Feature "[^"]*":\s*/, '')}`}
          </p>
        ) : null}
      </div>
    </form>
  );
}

export interface DatumAxisWorkspaceCardProps {
  document: ProjectDocument;
  /** The feature the workspace reopened; a datum axis makes this an edit. */
  editFeature: FeatureNode | null;
  scope: Record<string, number>;
  /** The current viewport pick: an edge, a face, or nothing. */
  selection: { kind: string; bodyId: BodyId; hash?: number } | null;
  /** Where the current pick was clicked, in world space, if known. */
  pickPoint?: { x: number; y: number; z: number } | null;
  editDisabledReason: string | null;
  exactGeometryReady: boolean;
  /** The Plane card's workspace wiring, which the Axis card shares. */
  app: DatumPlaneCardApp;
}

/** Reads one viewport pick as every slot of the Axis card could use it. */
function axisPick(
  document: ProjectDocument,
  selection: DatumAxisWorkspaceCardProps['selection'],
  pickPoint: DatumAxisWorkspaceCardProps['pickPoint']
): DatumAxisPick | null {
  if (!selection || (selection.kind !== 'edge' && selection.kind !== 'face'))
    return null;
  const key = `${selection.kind}:${selection.bodyId}:${selection.hash}:${pickPoint ? `${pickPoint.x},${pickPoint.y},${pickPoint.z}` : ''}`;
  if (selection.kind === 'edge') {
    return {
      key,
      edge: datumAxisEdgeFromPick(document, selection),
      vertex: datumVertexFromEdgePick(document, selection, pickPoint ?? null),
      revolution: null,
      plane: null
    };
  }
  const plane = ((): FacePlaneSource | null => {
    try {
      return datumFaceSourceFromPick(document, 'the axis', {
        ...selection,
        kind: 'face',
        topologyId: ''
      });
    } catch {
      return null;
    }
  })();
  return {
    key,
    edge: null,
    vertex: null,
    revolution: datumAxisFaceFromPick(document, selection),
    plane
  };
}

/**
 * The Axis card as the workspace mounts it, header and all. Done rebuilds
 * the candidate, proves the axis resolved, and commits exactly the command
 * it checked.
 */
export function DatumAxisWorkspaceCard({
  document,
  editFeature,
  scope,
  selection,
  pickPoint = null,
  editDisabledReason,
  exactGeometryReady,
  app
}: DatumAxisWorkspaceCardProps) {
  const editing =
    editFeature?.data.featureKind === 'datum-axis' ? editFeature : null;
  const approved = useRef<{
    signature: string;
    command: AnyCommand;
    featureId: FeatureId;
    baseVersion: number;
  } | null>(null);
  const open = useRef(true);
  const showing = useRef<FeatureId | null>(null);
  const draft = useRef(0);
  showing.current = editing?.featureId ?? null;
  useEffect(() => {
    open.current = true;
    return () => {
      open.current = false;
    };
  }, []);
  const [initial] = useState(() =>
    editing
      ? datumAxisFormStateFromFeature(editing)
      : newDatumAxisFormState(nextDatumAxisName(document))
  );
  const ownFaces = [initial.sourceA, initial.sourceB].flatMap((source) =>
    source?.type === 'face' ? [faceSourceOption(document, source)] : []
  );
  const planes = datumSourceOptions(
    document,
    editing?.featureId ?? null,
    ownFaces
  );
  const ownVertices = initial.points.flatMap((point) =>
    point?.type === 'vertex' ? [datumVertexOption(document, point.source)] : []
  );
  const current = () => app.managerRef.current?.document ?? null;
  const preflight = async (
    submission: DatumAxisSubmission
  ): Promise<ExactPreflightResult> => {
    approved.current = null;
    const base = current();
    if (!base || !app.ensureCanEdit('add this axis')) {
      return {
        status: 'refused',
        reason: editDisabledReason ?? 'Project editing is unavailable.'
      };
    }
    try {
      const named = editing
        ? submission
        : { ...submission, name: app.newFeatureName(submission.name) };
      const { command, featureId } = datumAxisCommand(named, editing);
      command.validate(base);
      const derived = await app.geometry.syncOnce(command.apply(base));
      requireResolvedDatums(base, derived, featureId, named.name, 'datum-axis');
      const latest = current();
      if (
        !latest ||
        latest.projectId !== base.projectId ||
        latest.version !== base.version
      ) {
        throw new Error(
          'The model changed while the axis was being checked. Try again.'
        );
      }
      approved.current = {
        signature: JSON.stringify(submission),
        command,
        featureId,
        baseVersion: base.version
      };
      return { status: 'ready' };
    } catch (error) {
      return {
        status: 'refused',
        reason:
          error instanceof Error
            ? error.message
            : 'The axis could not be checked.'
      };
    }
  };
  const submit = (submission: DatumAxisSubmission) => {
    const checked = approved.current;
    const base = current();
    if (
      !checked ||
      !base ||
      checked.signature !== JSON.stringify(submission) ||
      checked.baseVersion !== base.version
    ) {
      app.setStatus('The model changed after the axis was checked. Try again.');
      return;
    }
    const session = app.editCardSessionRef.current;
    const submittedDraft = draft.current;
    const label = checked.command.label;
    void app.validatedFeature.runTransaction([checked.command], {
      label,
      // An edit turns every revolve, pattern and Move about the axis; a
      // refusal from any of them refuses the edit.
      targets: editing ? affectedFeatureTargets(base, editing.featureId) : [],
      validateDerived: (derived) =>
        requireResolvedDatums(
          base,
          derived,
          checked.featureId,
          submission.name,
          'datum-axis'
        ),
      successMessage: commandOutcomeMessage(label),
      cancelled: () =>
        draft.current !== submittedDraft ||
        (editing
          ? !app.editSessionIsCurrent(editing, session)
          : !open.current || showing.current !== null),
      onSuccess: () =>
        editing
          ? app.finishFeatureEdit(editing, session)
          : app.finishFeatureCreation()
    });
  };
  const unsupportedReason =
    editDisabledReason ??
    (exactGeometryReady ? undefined : 'Waiting for exact geometry.');
  const labels = {
    ...(initial.edge
      ? { edge: datumAxisEdgeLabel(document, initial.edge) }
      : {}),
    ...(initial.face
      ? { face: datumAxisFaceLabel(document, initial.face) }
      : {})
  };
  return (
    <section
      className="inspector"
      aria-label="Feature inspector"
      onKeyDown={(event) => {
        if (event.key !== 'Escape') return;
        event.stopPropagation();
        app.cancelPanel();
      }}
    >
      <CardHeader
        title={editing?.name ?? 'Axis'}
        eyebrow={editing ? CARD_EYEBROWS.edit : CARD_EYEBROWS.create}
        actions={
          editing ? (
            <PanelOverflow>
              <button
                type="button"
                className="panel-overflow-item danger"
                title="Delete feature (Del)"
                onClick={() => {
                  if (app.validateSelectionEdit())
                    app.handleDeleteFeature(editing.featureId, editing.name);
                }}
              >
                <Trash2 size={13} aria-hidden="true" />
                Delete feature
              </button>
            </PanelOverflow>
          ) : null
        }
        closeTitle="Close"
        closeLabel="Close panel"
        onClose={app.closeFeaturePanel}
      />
      <div className="panel-body">
        <DatumAxisForm
          key={editing?.featureId ?? 'new'}
          initial={initial}
          planes={planes}
          scope={scope}
          units={document.units}
          editing={editing !== null}
          labels={labels}
          pick={axisPick(document, selection, pickPoint)}
          vertexOptions={ownVertices}
          describe={{
            edge: (source) => datumAxisEdgeLabel(document, source),
            face: (source) => datumAxisFaceLabel(document, source),
            vertex: (source) =>
              datumVertexOption(document, source, 'Picked vertex'),
            plane: (source) => faceSourceOption(document, source, 'Picked face')
          }}
          {...(unsupportedReason !== undefined ? { unsupportedReason } : {})}
          onPreflight={preflight}
          onSubmit={submit}
          onCancel={app.cancelPanel}
          onDraftChange={() => {
            draft.current += 1;
          }}
        />
      </div>
    </section>
  );
}
