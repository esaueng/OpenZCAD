import { useEffect, useState } from 'react';
import { Pause, Pin, Play, Plus, TriangleAlert, X } from 'lucide-react';
import { commandFactories } from '@openzcad/command-system';
import {
  ASSEMBLY_JOINT_DOFS,
  createId,
  type AssemblyComponent,
  type AssemblyDofLimit,
  type AssemblyDofUnit,
  type AssemblyJoint,
  type AssemblyPlayback,
  type ProjectDocument
} from '@openzcad/shared';
import {
  toggleComponentGrounded,
  toggleJointPlayback,
  type AssemblyExecute
} from '../../lib/assembly/assembleWorkspace';
import {
  assemblyRuntime,
  useAssemblyRuntime
} from '../../lib/assembly/assemblyRuntime';
import type { AssemblyViewModel } from '../../lib/assembly/assemblyView';
import {
  ANIMATE_MODES,
  ANIMATE_SPEEDS,
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
import { AssemblyNameField } from './AssemblyNameField';

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
  onCommit
}: {
  value: number;
  label: string;
  unit?: AssemblyDofUnit;
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
      {unit ? <span className="assembly-unit">{unitSymbol(unit)}</span> : null}
    </span>
  );
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
  joint
}: AssemblyDetailsProps & { joint: AssemblyJoint }) {
  const playback = useAssemblyRuntime((s) => s.playback);
  const prefs = useAnimatePrefs();
  const [savingPosition, setSavingPosition] = useState(false);
  const app = { document, execute, onStatus };
  const units = ASSEMBLY_JOINT_DOFS[joint.kind];
  const values = model.solution.values.get(joint.id) ?? joint.values;
  const unsolved = model.solution.unsolved.get(joint.id) ?? null;
  const playing = playback?.kind === 'joint' && playback.jointId === joint.id;
  const sweepReason = sweepUnavailableReason(joint);

  const preview = (dof: number, value: number) => {
    if (playback) assemblyRuntime.stop();
    const next = [...values];
    next[dof] = value;
    assemblyRuntime.setOverride(joint.id, next);
  };
  const commit = () => assemblyRuntime.commitOverrides();

  const setLimits = (limits: (AssemblyDofLimit | null)[]) =>
    execute(
      commandFactories.updateAssemblyJoint(
        { jointId: joint.id, limits },
        'Set joint limits'
      )
    );

  const currentValues = (): Record<string, number[]> =>
    Object.fromEntries(
      model.set.joints.map((j) => [
        j.id,
        [...(model.solution.values.get(j.id) ?? j.values)]
      ])
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

      {units.map((unit, dof) => {
        const value = values[dof] ?? 0;
        const range = sliderRange(unit, joint.limits[dof], value);
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
                step={unit === 'deg' ? 0.5 : 0.1}
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
                        ? defaultLimit(unit, value)
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
          <select
            className="assembly-select"
            aria-label="Playback"
            value={prefs.mode}
            onChange={(event) =>
              setAnimatePrefs({
                mode: event.currentTarget.value as AssemblyPlayback
              })
            }
          >
            {ANIMATE_MODES.map((option) => (
              <option key={option.mode} value={option.mode}>
                {option.label}
              </option>
            ))}
          </select>
          <select
            className="assembly-select"
            aria-label="Sweep time"
            value={prefs.sweepS}
            onChange={(event) =>
              setAnimatePrefs({ sweepS: Number(event.currentTarget.value) })
            }
          >
            {ANIMATE_SPEEDS.map((option) => (
              <option key={option.sweepS} value={option.sweepS}>
                {option.label}
              </option>
            ))}
          </select>
        </div>
      ) : null}
      {sweepReason && units.length > 0 ? (
        <p className="assembly-muted">{sweepReason}</p>
      ) : null}

      <div className="assembly-positions" role="group" aria-label="Positions">
        {model.set.positions.map((position) => (
          <span key={position.id} className="assembly-position-chip">
            <button
              type="button"
              className="assembly-position-apply"
              title={`Move the joints to ${position.name}`}
              onClick={() => {
                assemblyRuntime.stop();
                execute(
                  commandFactories.setAssemblyPose(
                    { values: position.values },
                    `Apply position ${position.name}`
                  )
                );
              }}
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
              <X size={11} aria-hidden="true" />
            </button>
          </span>
        ))}
        {savingPosition ? (
          <AssemblyNameField
            value={nextPositionName(model.set)}
            label="Position name"
            autoFocus
            commitUnchanged
            onDone={() => setSavingPosition(false)}
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
            onClick={() => setSavingPosition(true)}
          >
            <Plus size={12} aria-hidden="true" />
            Save position
          </button>
        )}
      </div>
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
    ? (document.derived.bodyRepresentations[bodyId]?.name ?? bodyId)
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
            if (
              execute(
                commandFactories.deleteAssemblyComponent({
                  componentId: component.id
                })
              )
            )
              assemblyRuntime.selectComponent(null);
          }}
        >
          Remove from assembly
        </button>
      </div>
    </div>
  );
}
