import { useEffect, useMemo, useState } from 'react';
import {
  Link2,
  Pause,
  Pin,
  Play,
  Plus,
  Trash2,
  TriangleAlert,
  X
} from 'lucide-react';
import { commandFactories } from '@openzcad/command-system';
import {
  ownEntry,
  ASSEMBLY_JOINT_DOFS,
  coupledJointLimits,
  couplingsOfJoint,
  createId,
  type AssemblyComponent,
  type AssemblyCoupling,
  type AssemblyDofLimit,
  type AssemblyDofUnit,
  type AssemblyJoint,
  type AssemblySet,
  type ProjectDocument,
  type UnitSystem
} from '@openzcad/shared';
import {
  removeAssemblyComponent,
  toggleComponentGrounded,
  toggleJointPlayback,
  type AssemblyExecute
} from '../../lib/assembly/assembleWorkspace';
import {
  assemblyRuntime,
  useAssemblyRuntime
} from '../../lib/assembly/assemblyRuntime';
import type { AssemblyViewModel } from '../../lib/assembly/assemblyView';
import { gearCouplingMismatch } from '../../lib/assembly/gearCouplingCheck';
import {
  assemblyLengthScale,
  defaultLimit,
  dofLabel,
  JOINT_KIND_META,
  nextPositionName,
  setAnimatePrefs,
  sliderRange,
  sweepUnavailableReason,
  unitSymbol,
  unsolvedReasonText,
  useAnimatePrefs
} from '../../lib/assembly/assemblyUi';
import { formatStudyTime } from '../../lib/assembly/motionStudy';
import { AssemblyNameField } from './AssemblyNameField';
import { PlaybackControl } from './PlaybackControl';
import { gearMeshCardContext } from './gearMeshEntry';

export interface AssemblyDetailsProps {
  document: ProjectDocument;
  execute: AssemblyExecute;
  onStatus(message: string): void;
  model: AssemblyViewModel;
}

function NumberField({
  value,
  label,
  unit,
  lengthUnit,
  onCommit
}: {
  value: number;
  label: string;
  unit?: AssemblyDofUnit;
  lengthUnit?: UnitSystem;
  onCommit(value: number): void;
}) {
  const shown = Number((Math.round(value * 1000) / 1000).toString());
  const [draft, setDraft] = useState(String(shown));
  useEffect(() => setDraft(String(shown)), [shown]);
  const commit = () => {
    const parsed = Number(draft.trim());
    if (draft.trim() !== '' && Number.isFinite(parsed) && parsed !== shown)
      onCommit(parsed);
    else setDraft(String(shown));
  };
  return (
    <span className="assembly-number">
      <input
        type="text"
        inputMode="decimal"
        aria-label={label}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            commit();
          }
        }}
      />
      {unit ? (
        <span className="assembly-unit">{unitSymbol(unit, lengthUnit)}</span>
      ) : null}
    </span>
  );
}

/**
 * A coupling in a few words: "0.5 turns per turn, the other way" for two
 * turns, "12.57 mm per turn" when one side slides (a rack and its pinion).
 */
export function couplingSummary(
  set: Pick<AssemblySet, 'joints'>,
  coupling: AssemblyCoupling,
  lengthUnit: UnitSystem = 'mm'
): string {
  const length = unitSymbol('mm', lengthUnit);
  const unitOf = (end: AssemblyCoupling['driver']) => {
    const found = set.joints.find((j) => j.id === end.jointId);
    return found ? ASSEMBLY_JOINT_DOFS[found.kind][end.dof] : undefined;
  };
  const from = unitOf(coupling.driver);
  const to = unitOf(coupling.driven);
  const size = Math.abs(coupling.ratio);
  const number = (value: number) => String(Number(value.toFixed(4)));
  if (from === 'deg' && to === 'deg')
    return `${number(size)} turns per turn, ${
      coupling.ratio < 0 ? 'the other way' : 'the same way'
    }`;
  if (from === 'deg' && to === 'mm')
    return `${number(size * 360)} ${length} per turn`;
  if (from === 'mm' && to === 'deg')
    return `${number(360 / size)} ${length} per turn`;
  return `ratio ${number(size)}`;
}

/**
 * A selected joint, opened under its row (AS02/AS06): one line per value
 * (slider and number), its limits, Animate and saved positions. Dragging
 * and playback move parts without adding history; a released value or a
 * limit is one undo step.
 */
export function JointDetails({
  document,
  execute,
  onStatus,
  model,
  joint,
  onDelete
}: AssemblyDetailsProps & {
  joint: AssemblyJoint;
  /** Deletes this joint (the panel announces it, with Undo). */
  onDelete?(): void;
}) {
  const playback = useAssemblyRuntime((s) => s.playback);
  const studyId = useAssemblyRuntime((s) => s.selectedStudyId);
  const studyTimeS = useAssemblyRuntime((s) => s.studyTimeS);
  const study = studyId
    ? model.set.studies.find((candidate) => candidate.id === studyId)
    : undefined;
  const prefs = useAnimatePrefs();
  const app = { document, execute, onStatus };
  const lengthUnit = document.units;
  const lengthScale = assemblyLengthScale(lengthUnit);
  const units = ASSEMBLY_JOINT_DOFS[joint.kind];
  const values = model.solution.values.get(joint.id) ?? joint.values;
  const unsolved = model.solution.unsolved.get(joint.id) ?? null;
  const playing = playback?.kind === 'joint' && playback.jointId === joint.id;
  const couplings = couplingsOfJoint(model.set, joint.id);
  // Read the gears only for a joint that is coupled.
  const coupled = couplings.length > 0;
  const gears = useMemo(
    () => (coupled ? gearMeshCardContext(document) : null),
    [coupled, document]
  );
  // What it can really travel: its own limits and those of its mates.
  const sweepReason = sweepUnavailableReason({
    kind: joint.kind,
    limits: coupledJointLimits(model.set, joint)
  });

  const preview = (dof: number, value: number) => {
    if (playback) assemblyRuntime.stop();
    const next = [...values];
    next[dof] = value;
    assemblyRuntime.setOverride(joint.id, next, dof);
  };
  const commit = () => assemblyRuntime.commitOverrides();

  const setLimits = (limits: (AssemblyDofLimit | null)[]) =>
    execute(
      commandFactories.updateAssemblyJoint(
        { jointId: joint.id, limits },
        'Set joint limits'
      )
    );

  return (
    <div
      id={`assembly-details-${joint.id}`}
      className="assembly-details"
      aria-label={`${joint.name} details`}
    >
      <p className="assembly-details-kind">
        {JOINT_KIND_META[joint.kind].label} ·{' '}
        {JOINT_KIND_META[joint.kind].hint.toLowerCase()}. Drag the moving part
        in the view, or set a value here.
      </p>
      {unsolved ? (
        <p className="assembly-banner" role="status">
          <TriangleAlert size={14} aria-hidden="true" />
          <span>Can’t move: {unsolvedReasonText(unsolved)}.</span>
        </p>
      ) : null}
      {study ? (
        // With a study open, a value set here becomes a key at the playhead
        // (the timeline's pose sink), not the rest pose: never silently.
        <p className="assembly-recording" role="note">
          <span className="motion-recording-dot" aria-hidden="true" />
          <span>
            Recording into {study.name}: a value set here is keyed at{' '}
            {formatStudyTime(Math.min(studyTimeS, study.durationS))} s. Close
            the animation to change where the joint rests.
          </span>
        </p>
      ) : null}

      {units.map((unit, dof) => {
        const value = values[dof] ?? 0;
        const range = sliderRange(unit, joint.limits[dof], value, lengthUnit);
        const label = dofLabel(joint.kind, dof);
        const limit = joint.limits[dof] ?? null;
        const withLimit = (next: AssemblyDofLimit | null) =>
          setLimits(
            units.map((_, i) => (i === dof ? next : (joint.limits[i] ?? null)))
          );
        return (
          <div className="assembly-dof-block" key={dof}>
            <div className="assembly-dof">
              <span className="assembly-dof-label">{label}</span>
              <input
                type="range"
                className="assembly-slider"
                aria-label={`${label} slider`}
                min={range.min}
                max={range.max}
                step={unit === 'deg' ? 0.5 : lengthScale.step}
                value={value}
                disabled={unsolved !== null}
                onChange={(event) =>
                  preview(dof, Number(event.currentTarget.value))
                }
                onPointerUp={commit}
                onKeyUp={commit}
                onBlur={commit}
              />
              <NumberField
                value={value}
                unit={unit}
                lengthUnit={lengthUnit}
                label={label}
                onCommit={(next) => {
                  preview(dof, next);
                  commit();
                }}
              />
            </div>
            <div className="assembly-limit">
              <label className="assembly-check">
                <input
                  type="checkbox"
                  checked={limit !== null}
                  onChange={(event) =>
                    withLimit(
                      event.currentTarget.checked
                        ? defaultLimit(unit, value, lengthUnit)
                        : null
                    )
                  }
                />
                <span>Limit</span>
              </label>
              {limit ? (
                <span className="assembly-limit-range">
                  <NumberField
                    value={limit.min}
                    label={`${label} minimum`}
                    onCommit={(min) =>
                      min <= limit.max
                        ? withLimit({ min, max: limit.max })
                        : onStatus(
                            'The minimum must be at or below the maximum.'
                          )
                    }
                  />
                  <span className="assembly-muted">to</span>
                  <NumberField
                    value={limit.max}
                    unit={unit}
                    lengthUnit={lengthUnit}
                    label={`${label} maximum`}
                    onCommit={(max) =>
                      max >= limit.min
                        ? withLimit({ min: limit.min, max })
                        : onStatus(
                            'The maximum must be at or above the minimum.'
                          )
                    }
                  />
                </span>
              ) : (
                <span className="assembly-muted">Moves freely</span>
              )}
            </div>
          </div>
        );
      })}

      {couplings.map((coupling) => {
        const stale = gears ? gearCouplingMismatch(gears, coupling) : null;
        return stale ? (
          <p className="assembly-banner" role="status" key={coupling.id}>
            <TriangleAlert size={14} aria-hidden="true" />
            <span>{stale}</span>
          </p>
        ) : null;
      })}

      {couplings.map((coupling) => {
        const otherId =
          coupling.driver.jointId === joint.id
            ? coupling.driven.jointId
            : coupling.driver.jointId;
        const other = model.set.joints.find((j) => j.id === otherId);
        return (
          <p className="assembly-coupling" key={coupling.id}>
            <Link2 size={13} aria-hidden="true" />
            <span>
              {coupling.name}: moves with {other?.name ?? 'another joint'} ·{' '}
              {couplingSummary(model.set, coupling, lengthUnit)}
            </span>
            <button
              type="button"
              className="assembly-link-button"
              aria-label={`Remove ${coupling.name}`}
              title="The joints stay; they stop moving together"
              onClick={() =>
                execute(
                  commandFactories.deleteAssemblyCoupling({
                    couplingId: coupling.id
                  })
                )
              }
            >
              Remove
            </button>
          </p>
        );
      })}

      {units.length > 0 ? (
        <div className="assembly-animate" role="group" aria-label="Animate">
          <button
            type="button"
            className="primary assembly-play"
            disabled={!playing && (sweepReason !== null || unsolved !== null)}
            title={sweepReason ?? undefined}
            onClick={() =>
              playing
                ? assemblyRuntime.stop()
                : toggleJointPlayback(app, joint.id)
            }
          >
            {playing ? (
              <Pause size={13} aria-hidden="true" />
            ) : (
              <Play size={13} aria-hidden="true" />
            )}
            {playing ? 'Pause' : 'Play'}
          </button>
          <PlaybackControl
            mode={prefs.mode}
            onModeChange={(mode) => setAnimatePrefs({ mode })}
            sweepS={prefs.sweepS}
            onSweepChange={(sweepS) => setAnimatePrefs({ sweepS })}
          />
        </div>
      ) : null}
      {sweepReason && units.length > 0 ? (
        <p className="assembly-muted">{sweepReason}</p>
      ) : null}

      {onDelete ? (
        <div className="assembly-detail-actions">
          <button
            type="button"
            className="assembly-link-button is-danger"
            title="Delete this joint (Delete). Undo brings it back."
            onClick={onDelete}
          >
            <Trash2 size={12} aria-hidden="true" />
            Delete joint
          </button>
        </div>
      ) : null}
    </div>
  );
}

/** A selected part, opened under its row: fixed or not, and how it moves. */
export function ComponentDetails({
  document,
  execute,
  onStatus,
  model,
  component
}: AssemblyDetailsProps & { component: AssemblyComponent }) {
  const app = { document, execute, onStatus };
  const role = model.solution.roles.get(component.id) ?? 'free';
  const link = model.solution.links.get(component.id);
  const via = link
    ? model.set.joints.find((j) => j.id === link.jointId)?.name
    : undefined;
  const bodyId = model.bodyByComponent.get(component.id) ?? null;
  const bodyName = bodyId
    ? (ownEntry(document.derived.bodyRepresentations, bodyId)?.name ?? bodyId)
    : null;
  const roleText =
    role === 'grounded'
      ? 'Fixed — stays where you modelled it.'
      : role === 'driven'
        ? `Moves with ${via ?? 'its joint'}. Drag it in the view to try.`
        : 'Not joined yet — press J to connect it to another part.';
  return (
    <div
      id={`assembly-details-${component.id}`}
      className="assembly-details"
      aria-label={`${component.name} details`}
    >
      <p className="assembly-details-kind">{roleText}</p>
      {bodyName === null ? (
        <p className="assembly-banner" role="status">
          <TriangleAlert size={14} aria-hidden="true" />
          <span>Its body was deleted in Build.</span>
        </p>
      ) : bodyName !== component.name ? (
        <p className="assembly-muted">Body: {bodyName}</p>
      ) : null}
      <div className="assembly-detail-actions">
        <button
          type="button"
          className={`assembly-pin${component.grounded ? ' is-on' : ''}`}
          aria-pressed={component.grounded}
          onClick={() => toggleComponentGrounded(app, component.id)}
        >
          <Pin size={13} aria-hidden="true" />
          {component.grounded ? 'Fixed' : 'Fix in place'}
        </button>
        <button
          type="button"
          className="assembly-link-button is-danger"
          onClick={() => {
            if (removeAssemblyComponent(app, component.id))
              assemblyRuntime.selectComponent(null);
          }}
        >
          Remove from assembly
        </button>
      </div>
    </div>
  );
}

/**
 * Saved positions (AS06): where every joint is, saved under a name to come
 * back to. They belong to the whole assembly, not to one joint, so they sit
 * in their own section. A chip applies its position; a double-click renames
 * it; × deletes it. Each is one undoable command.
 */
export function AssemblyPositions({
  execute,
  model
}: Pick<AssemblyDetailsProps, 'execute' | 'model'>) {
  const [saving, setSaving] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);
  const currentValues = (): Record<string, number[]> =>
    Object.fromEntries(
      model.set.joints.map((j) => [
        j.id,
        [...(model.solution.values.get(j.id) ?? j.values)]
      ])
    );
  return (
    <div className="assembly-positions" role="group" aria-label="Positions">
      {model.set.positions.map((position) =>
        renaming === position.id ? (
          <AssemblyNameField
            key={position.id}
            value={position.name}
            label={`Rename ${position.name}`}
            autoFocus
            onDone={() => setRenaming(null)}
            onCommit={(name) =>
              execute(
                // Saving under the same id replaces it: a rename keeps the
                // values and the chip's place.
                commandFactories.saveAssemblyPosition({
                  positionId: position.id,
                  name,
                  values: position.values
                })
              )
            }
          />
        ) : (
          <span key={position.id} className="assembly-position-chip">
            <button
              type="button"
              className="assembly-position-apply"
              title={`Move the joints to ${position.name} · double-click to rename`}
              onClick={(event) => {
                if (event.detail > 1) return;
                assemblyRuntime.stop();
                execute(
                  commandFactories.setAssemblyPose(
                    { values: position.values },
                    `Apply position ${position.name}`
                  )
                );
              }}
              onDoubleClick={() => setRenaming(position.id)}
            >
              {position.name}
            </button>
            <button
              type="button"
              className="assembly-position-delete"
              aria-label={`Delete ${position.name}`}
              title="Delete"
              onClick={() =>
                execute(
                  commandFactories.deleteAssemblyPosition({
                    positionId: position.id
                  })
                )
              }
            >
              <X size={12} aria-hidden="true" />
            </button>
          </span>
        )
      )}
      {saving ? (
        <AssemblyNameField
          value={nextPositionName(model.set)}
          label="Position name"
          autoFocus
          commitUnchanged
          onDone={() => setSaving(false)}
          onCommit={(name) =>
            execute(
              commandFactories.saveAssemblyPosition({
                positionId: createId<'AssemblyPosition'>('pos'),
                name,
                values: currentValues()
              })
            )
          }
        />
      ) : (
        <button
          type="button"
          className="assembly-link-button"
          title="Save where every joint is now, to come back to"
          onClick={() => setSaving(true)}
        >
          <Plus size={12} aria-hidden="true" />
          Save position
        </button>
      )}
    </div>
  );
}
