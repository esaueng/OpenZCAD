import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Trash2 } from 'lucide-react';
import type { AnyCommand, CommandManager } from '@openzcad/command-system';
import type {
  BodyId,
  FacePlaneSource,
  FeatureId,
  FeatureNode,
  ProjectDocument,
  UnitSystem
} from '@openzcad/shared';
import { affectedFeatureTargets } from '../../lib/affectedFeatureTargets';
import { CARD_EYEBROWS } from '../../lib/cardEyebrows';
import { commandOutcomeMessage } from '../../lib/commandOutcome';
import type { EditCardSession } from '../../lib/editCardLifecycle';
import { faceSketchAttachment } from '../../lib/faceSketchAttachment';
import type { useValidatedFeatureCommit } from '../../hooks/useValidatedFeatureCommit';
import { CardHeader } from '../CardHeader';
import { PanelOverflow } from '../PanelOverflow';
import { ExprInput } from '../ExprInput';
import {
  buildDatumPlaneDefinition,
  datumFormStateFromFeature,
  datumPlaneCommand,
  datumFormValidation,
  datumSourceKey,
  datumSourceOptions,
  faceSourceOption,
  newDatumPlaneFormState,
  nextDatumPlaneName,
  requireResolvedDatums,
  type DatumPlaneFormState,
  type DatumPlaneSubmission,
  type DatumSourceOption
} from '../../lib/datumPlanes';
import type {
  ExactPreflightResult,
  ExactPreflightState
} from '../../lib/modelingOperations';

export interface DatumPlaneFormProps {
  initial: DatumPlaneFormState;
  /** Principal planes, earlier datums and any offered face, in that order. */
  sources: readonly DatumSourceOption[];
  scope: Record<string, number>;
  /** The document's units: the offset is a length and may carry a suffix. */
  units?: UnitSystem;
  /** The card reopens an existing datum; its button reads Apply. */
  editing?: boolean;
  /**
   * A face source to offer from the current viewport pick, or why the pick
   * cannot be one (not planar, no lineage). Null with no face picked.
   */
  pickedFace?: { option: DatumSourceOption } | { reason: string } | null;
  unsupportedReason?: string;
  onPreflight(submission: DatumPlaneSubmission): Promise<ExactPreflightResult>;
  onSubmit(submission: DatumPlaneSubmission): void;
  onCancel(): void;
}

/**
 * The Plane card (R01): an Offset Plane from one source or a Midplane between
 * two parallel ones, with Flip normal. Nothing reaches the document until
 * Done, and Done first proves the exact build resolves the plane.
 */
export function DatumPlaneForm({
  initial,
  sources,
  scope,
  units,
  editing = false,
  pickedFace = null,
  unsupportedReason,
  onPreflight,
  onSubmit,
  onCancel
}: DatumPlaneFormProps) {
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
  // Every face picked while the card is open stays on offer, numbered in
  // pick order, so a midplane can take two faces picked one after the other.
  const [pickedFaces, setPickedFaces] = useState<DatumSourceOption[]>(() =>
    pickedFace && 'option' in pickedFace
      ? [{ ...pickedFace.option, label: `${pickedFace.option.label} 1` }]
      : []
  );
  const latestPick =
    pickedFace && 'option' in pickedFace ? pickedFace.option : null;
  const seenPick = useRef(latestPick?.key ?? null);
  useEffect(() => {
    if (!latestPick || latestPick.key === seenPick.current) return;
    seenPick.current = latestPick.key;
    const known = pickedFaces.find((face) => face.key === latestPick.key);
    const option = known ?? {
      ...latestPick,
      label: `${latestPick.label} ${pickedFaces.length + 1}`
    };
    if (!known) setPickedFaces((faces) => [...faces, option]);
    // A pick fills the slot the card is asking for: the offset source, or a
    // midplane's empty B once A is set (else A).
    epoch.current += 1;
    setPreflight({ status: 'idle' });
    setState((current) =>
      current.mode === 'midplane' && current.sourceA && !current.sourceB
        ? { ...current, sourceB: option.source }
        : { ...current, sourceA: option.source }
    );
    // Only a new pick acts; the list and state it reads are this render's.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [latestPick?.key]);
  const options = [
    ...sources,
    ...pickedFaces.filter(
      (face) => !sources.some((option) => option.key === face.key)
    )
  ];
  const replace = (next: DatumPlaneFormState) => {
    epoch.current += 1;
    setPreflight({ status: 'idle' });
    setState(next);
  };
  const validation = datumFormValidation(state, scope, units);
  const blocked = unsupportedReason !== undefined;
  const canCheck = validation === null && !blocked;

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canCheck || preflight.status === 'pending') return;
    const current = ++epoch.current;
    const submission: DatumPlaneSubmission = {
      name: state.name.trim(),
      definition: buildDatumPlaneDefinition(state)
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
            : 'The plane could not be checked.'
      });
    }
  };

  const slot = (role: 'sourceA' | 'sourceB', label: string, hint: string) => {
    const selected = state[role];
    const key = selected ? datumSourceKey(selected) : '';
    return (
      <label className="field">
        <span>{label}</span>
        <select
          value={key}
          aria-label={label}
          aria-description={hint}
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

  const buttonLabel =
    preflight.status === 'pending'
      ? 'Checking the plane…'
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
      <div className="plane-chips" role="group" aria-label="Plane type">
        {(
          [
            ['offset', 'Offset plane'],
            ['midplane', 'Midplane']
          ] as const
        ).map(([mode, text]) => (
          <button
            key={mode}
            type="button"
            className="plane-chip"
            aria-pressed={state.mode === mode}
            onClick={() => replace({ ...state, mode })}
          >
            {text}
          </button>
        ))}
      </div>
      {state.mode === 'offset' ? (
        <>
          {slot('sourceA', 'Offset from', 'The plane or face to offset')}
          <ExprInput
            label="Offset"
            value={state.offset}
            scope={scope}
            optional
            {...(units
              ? { quantity: { documentUnits: units, dimension: 'length' } }
              : {})}
            onChange={(offset) => replace({ ...state, offset })}
          />
        </>
      ) : (
        <>
          {slot('sourceA', 'Plane A', 'The first of two parallel planes')}
          {slot('sourceB', 'Plane B', 'The second of two parallel planes')}
        </>
      )}
      {pickedFace && 'reason' in pickedFace ? (
        <p className="muted">{pickedFace.reason}</p>
      ) : pickedFace ? null : (
        <p className="muted">
          Pick a flat face in the viewport to offer it as a source.
        </p>
      )}
      <label className="field-check">
        <input
          type="checkbox"
          checked={state.reverseNormal}
          onChange={(event) =>
            replace({ ...state, reverseNormal: event.target.checked })
          }
        />
        <span>Flip normal</span>
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
            type="submit"
            className="primary"
            disabled={!canCheck || preflight.status === 'pending'}
            aria-keyshortcuts="Enter"
          >
            {buttonLabel}
          </button>
          <button type="button" className="secondary" onClick={onCancel}>
            Cancel
          </button>
        </div>
        {blocked ? (
          <p className="field-error" role="alert">
            {unsupportedReason}
          </p>
        ) : preflight.status === 'pending' ? (
          <p className="muted" role="status" aria-live="polite">
            Checking that the plane resolves…
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

export interface DatumPlaneCardProps {
  document: ProjectDocument;
  /** The datum the card reopens, or null to create one. */
  editing: FeatureNode | null;
  scope: Record<string, number>;
  /** The flat face picked in the viewport, or why the pick cannot be one. */
  pickedFace: FacePlaneSource | { reason: string } | null;
  unsupportedReason?: string;
  onPreflight: DatumPlaneFormProps['onPreflight'];
  onSubmit: DatumPlaneFormProps['onSubmit'];
  onCancel(): void;
}

/**
 * The workspace's Plane card: the form, seeded from the document. A new
 * plane starts on the picked face when there is one, else on Top (XY); an
 * edited one offers only datums earlier than itself.
 */
export function DatumPlaneCard({
  document,
  editing,
  scope,
  pickedFace,
  unsupportedReason,
  onPreflight,
  onSubmit,
  onCancel
}: DatumPlaneCardProps) {
  const picked: DatumPlaneFormProps['pickedFace'] =
    pickedFace && 'reason' in pickedFace
      ? { reason: pickedFace.reason }
      : pickedFace
        ? { option: faceSourceOption(document, pickedFace, 'Picked face') }
        : null;
  const [initial] = useState(() => {
    if (editing) return datumFormStateFromFeature(editing);
    const sources = datumSourceOptions(document, null);
    return newDatumPlaneFormState(
      nextDatumPlaneName(document),
      picked && 'option' in picked
        ? picked.option.source
        : (sources[0]?.source ?? null)
    );
  });
  // An edited datum on a face keeps that face on offer even when nothing is
  // picked now: the select must be able to show what the datum is built on.
  const ownFaces = editing
    ? [initial.sourceA, initial.sourceB].flatMap((source) =>
        source?.type === 'face' ? [faceSourceOption(document, source)] : []
      )
    : [];
  const sources = datumSourceOptions(
    document,
    editing?.featureId ?? null,
    ownFaces
  );
  return (
    <DatumPlaneForm
      initial={initial}
      sources={sources}
      scope={scope}
      units={document.units}
      editing={editing !== null}
      pickedFace={picked}
      {...(unsupportedReason !== undefined ? { unsupportedReason } : {})}
      onPreflight={onPreflight}
      onSubmit={onSubmit}
      onCancel={onCancel}
    />
  );
}

/**
 * What the workspace lends the Plane card, passed by reference: the card's
 * preflight, commit and chrome live here, in its lazy chunk, because every
 * byte of wiring written out in App.tsx is a byte of the entry chunk.
 */
export interface DatumPlaneCardApp {
  managerRef: { readonly current: CommandManager | null };
  geometry: {
    syncOnce(document: ProjectDocument): Promise<ProjectDocument['derived']>;
  };
  validatedFeature: Pick<
    ReturnType<typeof useValidatedFeatureCommit>,
    'runTransaction'
  >;
  ensureCanEdit(action?: string): boolean;
  newFeatureName(name: string): string;
  setStatus(message: string): void;
  editCardSessionRef: { readonly current: EditCardSession | null };
  editSessionIsCurrent(
    feature: FeatureNode,
    session: EditCardSession | null
  ): boolean;
  finishFeatureEdit(
    feature: FeatureNode,
    session: EditCardSession | null
  ): void;
  finishFeatureCreation(): void;
  validateSelectionEdit(): boolean;
  handleDeleteFeature(featureId: FeatureId, name: string): void;
  cancelPanel(): void;
  closeFeaturePanel(): void;
}

export interface DatumPlaneWorkspaceCardProps {
  document: ProjectDocument;
  /** The feature the workspace reopened; a datum plane makes this an edit. */
  editFeature: FeatureNode | null;
  scope: Record<string, number>;
  /** The current viewport pick; a planar face is offered as a source. */
  selection: { kind: string; bodyId: BodyId; hash?: number } | null;
  /** Why the card cannot commit right now, if it cannot. */
  editDisabledReason: string | null;
  exactGeometryReady: boolean;
  app: DatumPlaneCardApp;
}

/**
 * The Plane card as the workspace mounts it, header and all. Done rebuilds
 * the candidate, proves the datum's frame resolved, and commits exactly the
 * command it checked.
 */
export function DatumPlaneWorkspaceCard({
  document,
  editFeature,
  scope,
  selection,
  editDisabledReason,
  exactGeometryReady,
  app
}: DatumPlaneWorkspaceCardProps) {
  const editing =
    editFeature?.data.featureKind === 'datum-plane' ? editFeature : null;
  const approved = useRef<{
    signature: string;
    command: AnyCommand;
    featureId: FeatureId;
    baseVersion: number;
  } | null>(null);
  // A creation committed after Cancel or Esc closed the card would land a
  // plane the user withdrew: the commit asks whether the card is still up.
  const open = useRef(true);
  useEffect(() => {
    open.current = true;
    return () => {
      open.current = false;
    };
  }, []);
  let pickedFace: DatumPlaneCardProps['pickedFace'] = null;
  if (selection?.kind === 'face') {
    const attachment = faceSketchAttachment({
      bodyId: selection.bodyId,
      pickedHash: selection.hash,
      face: document.derived.bodyRepresentations[
        selection.bodyId
      ]?.topology?.faces.find((face) => face.hash === selection.hash)
    });
    const ref = attachment.ok ? attachment.planeRef : null;
    pickedFace = !attachment.ok
      ? { reason: attachment.reason }
      : ref?.type === 'face' && ref.faceReference && ref.sourceCentroid
        ? (ref as FacePlaneSource)
        : {
            reason:
              'This face has no identity a rebuild can find again, so a plane cannot follow it.'
          };
  }
  const current = () => app.managerRef.current?.document ?? null;
  const preflight = async (
    submission: DatumPlaneSubmission
  ): Promise<ExactPreflightResult> => {
    approved.current = null;
    const base = current();
    if (!base || !app.ensureCanEdit('add this plane')) {
      return {
        status: 'refused',
        reason: editDisabledReason ?? 'Project editing is unavailable.'
      };
    }
    try {
      const named = editing
        ? submission
        : { ...submission, name: app.newFeatureName(submission.name) };
      const { command, featureId } = datumPlaneCommand(named, editing);
      command.validate(base);
      const derived = await app.geometry.syncOnce(command.apply(base));
      requireResolvedDatums(base, derived, featureId, named.name);
      const latest = current();
      if (
        !latest ||
        latest.projectId !== base.projectId ||
        latest.version !== base.version
      ) {
        throw new Error(
          'The model changed while the plane was being checked. Try again.'
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
            : 'The plane could not be checked.'
      };
    }
  };
  const submit = (submission: DatumPlaneSubmission) => {
    const checked = approved.current;
    const base = current();
    if (
      !checked ||
      !base ||
      checked.signature !== JSON.stringify(submission) ||
      checked.baseVersion !== base.version
    ) {
      app.setStatus(
        'The model changed after the plane was checked. Try again.'
      );
      return;
    }
    const session = app.editCardSessionRef.current;
    const label = checked.command.label;
    void app.validatedFeature.runTransaction([checked.command], {
      label,
      // An edit moves every sketch, Split and Mirror built on the datum; a
      // refusal from any of them refuses the edit.
      targets: editing ? affectedFeatureTargets(base, editing.featureId) : [],
      validateDerived: (derived) =>
        requireResolvedDatums(
          base,
          derived,
          checked.featureId,
          submission.name
        ),
      successMessage: commandOutcomeMessage(label),
      cancelled: () =>
        editing ? !app.editSessionIsCurrent(editing, session) : !open.current,
      onSuccess: () =>
        editing
          ? app.finishFeatureEdit(editing, session)
          : app.finishFeatureCreation()
    });
  };
  const unsupportedReason =
    editDisabledReason ??
    (exactGeometryReady ? undefined : 'Waiting for exact geometry.');
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
        title={editing?.name ?? 'Plane'}
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
        <DatumPlaneCard
          key={editing?.featureId ?? 'new'}
          document={document}
          editing={editing}
          scope={scope}
          pickedFace={pickedFace}
          {...(unsupportedReason !== undefined ? { unsupportedReason } : {})}
          onPreflight={preflight}
          onSubmit={submit}
          onCancel={app.cancelPanel}
        />
      </div>
    </section>
  );
}
