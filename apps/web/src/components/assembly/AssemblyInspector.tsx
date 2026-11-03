import { useEffect, useState, type ReactNode } from 'react';
import { Pause, Play, TriangleAlert, X } from 'lucide-react';
import { commandFactories } from '@openzcad/command-system';
import {
  ASSEMBLY_JOINT_DOFS,
  createId,
  type AssemblyComponent,
  type AssemblyDofLimit,
  type AssemblyDofUnit,
  type AssemblyJoint,
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
  dofCountLabel,
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
import { JointKindIcon } from './JointKindIcon';
import { useAssemblyModel } from './useAssemblyModel';

export interface AssemblyInspectorProps {
  document: ProjectDocument;
  execute: AssemblyExecute;
  onStatus(message: string): void;
}

/**
 * Assemble's Inspector (AS02/AS06): the selected joint's values, limits,
 * Animate and named positions, or the selected component's grounding. Null
 * while nothing is selected, so the lane is given back to the viewport.
 */
export function AssemblyInspector(props: AssemblyInspectorProps) {
  const model = useAssemblyModel(props.document);
  const selectedJointId = useAssemblyRuntime((s) => s.selectedJointId);
  const selectedComponentId = useAssemblyRuntime((s) => s.selectedComponentId);
  if (!model) return null;
  const joint = model.set.joints.find((j) => j.id === selectedJointId);
  if (joint) return <JointInspector {...props} model={model} joint={joint} />;
  const component = model.set.components.find(
    (c) => c.id === selectedComponentId
  );
  if (component)
    return (
      <ComponentInspector {...props} model={model} component={component} />
    );
  return null;
}

/** Whether the Inspector has something to show (for the app's lane). */
export function assemblyInspectorOpen(
  document: ProjectDocument,
  selection: { jointId: string | null; componentId: string | null }
): boolean {
  const set = document.assembly;
  if (!set) return false;
  return (
    set.joints.some((j) => j.id === selection.jointId) ||
    set.components.some((c) => c.id === selection.componentId)
  );
}

function InspectorFrame({
  eyebrow,
  label,
  children
}: {
  eyebrow: string;
  label: string;
  children: ReactNode;
}) {
  return (
    <aside className="inspector assembly-inspector" aria-label={label}>
      <header className="panel-header">
        <div className="panel-title-row">
          <span className="panel-eyebrow">{eyebrow}</span>
          <button
            type="button"
            className="assembly-icon-button"
            aria-label="Close"
            title="Close (Esc)"
            onClick={() => {
              assemblyRuntime.selectJoint(null);
              assemblyRuntime.selectComponent(null);
            }}
          >
            <X size={14} aria-hidden="true" />
          </button>
        </div>
      </header>
      <div className="assembly-inspector-body">{children}</div>
    </aside>
  );
}

function NumberField({
  value,
  label,
  unit,
  onCommit
}: {
  value: number;
  label: string;
  unit: AssemblyDofUnit;
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
      <span className="assembly-unit">{unitSymbol(unit)}</span>
    </span>
  );
}

function JointInspector({
  document,
  execute,
  onStatus,
  model,
  joint
}: AssemblyInspectorProps & {
  model: AssemblyViewModel;
  joint: AssemblyJoint;
}) {
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
    <InspectorFrame eyebrow="Joint" label={`Joint ${joint.name}`}>
      <AssemblyNameField
        value={joint.name}
        label="Joint name"
        className="assembly-name-field assembly-title-field"
        onCommit={(name) =>
          execute(
            commandFactories.updateAssemblyJoint(
              { jointId: joint.id, name },
              'Rename joint'
            )
          )
        }
      />
      <div className="assembly-kind-row">
        <span className="assembly-kind-chip">
          <JointKindIcon kind={joint.kind} size={12} />
          {JOINT_KIND_META[joint.kind].label}
        </span>
        <span className="assembly-muted">{dofCountLabel(units.length)}</span>
      </div>
      {unsolved ? (
        <p className="assembly-banner" role="status">
          <TriangleAlert size={14} aria-hidden="true" />
          <span>Not solved: {unsolvedReasonText(unsolved)}.</span>
        </p>
      ) : null}

      {units.length > 0 ? (
        <section className="assembly-field-group" aria-label="Values">
          <h3 className="assembly-section-title">Values</h3>
          {units.map((unit, dof) => {
            const value = values[dof] ?? 0;
            const range = sliderRange(unit, joint.limits[dof], value);
            const label = dofLabel(joint.kind, dof);
            return (
              <div className="assembly-dof" key={dof}>
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
            );
          })}
        </section>
      ) : null}

      {units.length > 0 ? (
        <section className="assembly-field-group" aria-label="Limits">
          <h3 className="assembly-section-title">Limits</h3>
          {units.map((unit, dof) => {
            const limit = joint.limits[dof] ?? null;
            const label = dofLabel(joint.kind, dof);
            const withLimit = (next: AssemblyDofLimit | null) =>
              setLimits(
                units.map((_, i) =>
                  i === dof ? next : (joint.limits[i] ?? null)
                )
              );
            return (
              <div className="assembly-limit" key={dof}>
                <label className="assembly-check">
                  <input
                    type="checkbox"
                    checked={limit !== null}
                    onChange={(event) =>
                      withLimit(
                        event.currentTarget.checked
                          ? defaultLimit(unit, values[dof] ?? 0)
                          : null
                      )
                    }
                  />
                  <span>Limit {label.toLowerCase()}</span>
                </label>
                {limit ? (
                  <span className="assembly-limit-range">
                    <NumberField
                      value={limit.min}
                      unit={unit}
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
                ) : null}
              </div>
            );
          })}
        </section>
      ) : null}

      {units.length > 0 ? (
        <section className="assembly-field-group" aria-label="Animate">
          <h3 className="assembly-section-title">Animate</h3>
          <div
            className="assembly-segmented"
            role="group"
            aria-label="Playback"
          >
            {ANIMATE_MODES.map((option) => (
              <button
                key={option.mode}
                type="button"
                aria-pressed={prefs.mode === option.mode}
                className={`assembly-segment${prefs.mode === option.mode ? ' is-active' : ''}`}
                onClick={() => setAnimatePrefs({ mode: option.mode })}
              >
                {option.label}
              </button>
            ))}
          </div>
          <div
            className="assembly-segmented"
            role="group"
            aria-label="Sweep time"
          >
            {ANIMATE_SPEEDS.map((option) => (
              <button
                key={option.sweepS}
                type="button"
                aria-pressed={prefs.sweepS === option.sweepS}
                className={`assembly-segment${prefs.sweepS === option.sweepS ? ' is-active' : ''}`}
                onClick={() => setAnimatePrefs({ sweepS: option.sweepS })}
              >
                {option.label}
              </button>
            ))}
          </div>
          <button
            type="button"
            className="primary assembly-play"
            disabled={!playing && (sweepReason !== null || unsolved !== null)}
            onClick={() => {
              if (playing) {
                assemblyRuntime.stop();
                return;
              }
              // A changed mode or speed applies from the next press.
              toggleJointPlayback(app, joint.id);
            }}
          >
            {playing ? (
              <Pause size={13} aria-hidden="true" />
            ) : (
              <Play size={13} aria-hidden="true" />
            )}
            {playing ? 'Pause' : 'Play'}
          </button>
          {sweepReason ? <p className="assembly-muted">{sweepReason}</p> : null}
        </section>
      ) : null}

      <section className="assembly-field-group" aria-label="Named positions">
        <h3 className="assembly-section-title">Named positions</h3>
        {model.set.positions.length > 0 ? (
          <ul className="assembly-list">
            {model.set.positions.map((position) => (
              <li key={position.id} className="assembly-row">
                <span className="assembly-row-main is-static">
                  <span className="assembly-row-name">{position.name}</span>
                </span>
                <button
                  type="button"
                  className="assembly-row-text-action"
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
                  Apply
                </button>
                <button
                  type="button"
                  className="assembly-row-action"
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
              </li>
            ))}
          </ul>
        ) : null}
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
            className="secondary"
            onClick={() => setSavingPosition(true)}
          >
            Save current position…
          </button>
        )}
      </section>
      <p className="assembly-note">
        Dragging and playback never add history steps.
      </p>
    </InspectorFrame>
  );
}

function ComponentInspector({
  document,
  execute,
  onStatus,
  model,
  component
}: AssemblyInspectorProps & {
  model: AssemblyViewModel;
  component: AssemblyComponent;
}) {
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
      ? 'Grounded · stays where it is'
      : role === 'driven'
        ? `Driven${via ? ` by ${via}` : ''}`
        : 'Free · keeps its placement';
  return (
    <InspectorFrame eyebrow="Component" label={`Component ${component.name}`}>
      <AssemblyNameField
        value={component.name}
        label="Component name"
        className="assembly-name-field assembly-title-field"
        onCommit={(name) =>
          execute(
            commandFactories.updateAssemblyComponent(
              { componentId: component.id, name },
              'Rename component'
            )
          )
        }
      />
      <label className="assembly-check">
        <input
          type="checkbox"
          checked={component.grounded}
          onChange={() => toggleComponentGrounded(app, component.id)}
        />
        <span>Grounded</span>
      </label>
      <dl className="assembly-facts">
        <dt>Role</dt>
        <dd>{roleText}</dd>
        <dt>Body</dt>
        <dd>
          {bodyName ?? (
            <span className="assembly-row-flag">
              <TriangleAlert size={12} aria-hidden="true" />
              Body deleted
            </span>
          )}
        </dd>
      </dl>
    </InspectorFrame>
  );
}
