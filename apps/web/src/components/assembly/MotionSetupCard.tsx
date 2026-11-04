import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { ArrowDownUp, Link2, X } from 'lucide-react';
import { assemblyComponentBodies } from '@openzcad/document-core';
import {
  solveAssembly,
  type AssemblyDofLimit,
  type AssemblyPlayback,
  type ProjectDocument
} from '@openzcad/shared';
import {
  createMotionFromSetup,
  type AssemblyExecute
} from '../../lib/assembly/assembleWorkspace';
import {
  assemblyRuntime,
  useAssemblyRuntime,
  type AssemblyMotionSetupState
} from '../../lib/assembly/assemblyRuntime';
import { ANIMATE_MODES } from '../../lib/assembly/assemblyUi';
import { MOTION_SETUP_PREVIEW_JOINT_ID } from '../../lib/assembly/assemblyView';
import {
  defaultMotionRange,
  defaultMotionSetup,
  MOTION_SETUP_AXES,
  MOTION_SETUP_SWEEPS,
  motionSetupAxisLabel,
  motionSetupJoint,
  type MotionSetupBounds,
  type MotionSetupContext,
  type MotionSetupDraft,
  type MotionSetupMove
} from '../../lib/assembly/motionSetup';
import { JointKindIcon } from './JointKindIcon';
import { isLiveBody } from './useAssemblyModel';

export interface MotionSetupCardProps {
  document: ProjectDocument;
  execute: AssemblyExecute;
  onStatus(message: string): void;
  /** Body boxes in modelled coordinates: centre the axis, size the slide. */
  bounds?: MotionSetupBounds;
}

/** The saved assembly as Set up motion reads it (no transient values). */
export function motionSetupContext(
  document: ProjectDocument,
  bounds?: MotionSetupBounds
): MotionSetupContext | null {
  const set = document.assembly;
  if (!set) return null;
  const bodies = assemblyComponentBodies(document, (bodyId) =>
    isLiveBody(document, bodyId)
  );
  return {
    set,
    solution: solveAssembly(set),
    bodyOf: (componentId) => bodies.get(componentId) ?? null,
    ...(bounds ? { bounds } : {})
  };
}

/** Opens Set up motion with defaults read from the assembly. */
export function openMotionSetup(
  document: ProjectDocument,
  options: { bounds?: MotionSetupBounds; reducedMotion?: boolean } = {}
): boolean {
  const context = motionSetupContext(document, options.bounds);
  if (!context || context.set.components.length < 2) return false;
  assemblyRuntime.openMotionSetup(
    defaultMotionSetup(context),
    !options.reducedMotion
  );
  return true;
}

const MOVES: readonly {
  move: MotionSetupMove;
  label: string;
  hint: string;
}[] = [
  { move: 'slide', label: 'Slide', hint: 'Lift out, push in' },
  { move: 'turn', label: 'Turn', hint: 'Swing about an axis' }
];

/**
 * Set up motion (AS02/AS06): one card that makes a part move without picking
 * joint geometry — what stays, what moves, slide or turn along X, Y or Z,
 * how far, and how it cycles — previewing the exact motion in the viewport
 * while the card is open. Create saves an ordinary joint with its range and
 * plays it; geometry-picked joints stay in the Joint tool.
 */
export function MotionSetupCard(props: MotionSetupCardProps) {
  const setup = useAssemblyRuntime((s) => s.motionSetup);
  if (!setup) return null;
  return <MotionSetupForm {...props} setup={setup} />;
}

function MotionSetupForm({
  document,
  execute,
  onStatus,
  bounds,
  setup
}: MotionSetupCardProps & { setup: AssemblyMotionSetupState }) {
  const { draft } = setup;
  const context = useMemo(
    () => motionSetupContext(document, bounds),
    [document, bounds]
  );
  // Until the range is typed by hand, changing the move or axis resizes it.
  const [rangeEdited, setRangeEdited] = useState(false);
  const result = useMemo(
    () =>
      context
        ? motionSetupJoint(context, draft, MOTION_SETUP_PREVIEW_JOINT_ID)
        : { error: 'This project has no assembly.' },
    [context, draft]
  );
  const preview = 'joint' in result ? result.joint : null;
  useEffect(() => {
    assemblyRuntime.setMotionSetupPreview(preview);
  }, [preview]);

  if (!context) return null;
  const { set } = context;
  const unit = draft.move === 'slide' ? 'mm' : '°';
  const base = set.components.find((c) => c.id === draft.baseId);

  const update = (partial: Partial<MotionSetupDraft>) => {
    const next = { ...draft, ...partial };
    const resize =
      !rangeEdited &&
      (partial.move !== undefined ||
        partial.axis !== undefined ||
        partial.baseId !== undefined);
    // A turn and a slide have different units: a new move starts afresh.
    const moveChanged =
      partial.move !== undefined && partial.move !== draft.move;
    if (moveChanged) setRangeEdited(false);
    assemblyRuntime.updateMotionSetup(
      resize || moveChanged
        ? { ...partial, range: defaultMotionRange(context, next) }
        : partial
    );
  };
  const setRange = (range: AssemblyDofLimit) => {
    setRangeEdited(true);
    assemblyRuntime.updateMotionSetup({ range });
  };
  const create = () =>
    createMotionFromSetup({ document, execute, onStatus }, context, draft);

  return (
    <section className="assembly-joint-tool" aria-label="Set up motion">
      <header className="assembly-joint-tool-header">
        <h2 className="assembly-panel-title">Set up motion</h2>
        <button
          type="button"
          className="assembly-icon-button"
          aria-label="Close Set up motion"
          title="Cancel (Esc)"
          onClick={() => assemblyRuntime.closeMotionSetup()}
        >
          <X size={14} aria-hidden="true" />
        </button>
      </header>
      <ol className="assembly-steps">
        <SetupStep index={1} title="Stays put">
          <select
            className="assembly-select"
            aria-label="Part that stays put"
            value={draft.baseId ?? ''}
            onChange={(event) => {
              const baseId = event.currentTarget.value;
              update({
                baseId,
                ...(baseId === draft.movingId
                  ? {
                      movingId:
                        set.components.find((c) => c.id !== baseId)?.id ?? null
                    }
                  : {})
              });
            }}
          >
            {set.components.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
          {base && !base.grounded && 'joint' in result && result.groundBase ? (
            <span className="assembly-muted">
              Not fixed yet — Create fixes it in place.
            </span>
          ) : null}
        </SetupStep>
        <SetupStep index={2} title="Moves">
          <select
            className="assembly-select"
            aria-label="Part that moves"
            value={draft.movingId ?? ''}
            onChange={(event) =>
              update({ movingId: event.currentTarget.value })
            }
          >
            {set.components
              .filter((c) => c.id !== draft.baseId)
              .map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
          </select>
        </SetupStep>
        <SetupStep index={3} title="Motion">
          <div
            className="assembly-kind-grid"
            role="group"
            aria-label="Motion type"
          >
            {MOVES.map((option) => (
              <button
                key={option.move}
                type="button"
                className={`assembly-kind-option${
                  draft.move === option.move ? ' is-active' : ''
                }`}
                aria-pressed={draft.move === option.move}
                onClick={() => update({ move: option.move })}
              >
                <JointKindIcon
                  kind={option.move === 'slide' ? 'slider' : 'revolute'}
                />
                <span className="assembly-kind-text">
                  <span className="assembly-kind-label">{option.label}</span>
                  <span className="assembly-kind-hint">{option.hint}</span>
                </span>
              </button>
            ))}
          </div>
          <div className="assembly-setup-axis">
            <span
              className="assembly-segmented"
              role="group"
              aria-label={draft.move === 'slide' ? 'Slide along' : 'Turn about'}
            >
              {MOTION_SETUP_AXES.map((axis) => (
                <button
                  key={axis}
                  type="button"
                  className={draft.axis === axis ? 'is-active' : undefined}
                  aria-pressed={draft.axis === axis}
                  aria-label={`${motionSetupAxisLabel(axis)} axis`}
                  onClick={() => update({ axis })}
                >
                  {motionSetupAxisLabel(axis)}
                </button>
              ))}
            </span>
            <button
              type="button"
              className="secondary"
              aria-pressed={draft.reverse}
              title="Run the motion the other way"
              onClick={() => update({ reverse: !draft.reverse })}
            >
              <ArrowDownUp size={13} aria-hidden="true" />
              Reverse
            </button>
          </div>
          <span className="assembly-muted">
            {draft.move === 'slide'
              ? 'Along the world axis, through the part’s centre.'
              : 'About the world axis, through the part’s centre.'}
          </span>
        </SetupStep>
        <SetupStep index={4} title="Range">
          <span className="assembly-limit-range">
            <SetupNumber
              label={draft.move === 'slide' ? 'Slide from' : 'Turn from'}
              value={draft.range.min}
              onChange={(min) =>
                setRange({ min, max: Math.max(min, draft.range.max) })
              }
            />
            <span className="assembly-muted">to</span>
            <SetupNumber
              label={draft.move === 'slide' ? 'Slide to' : 'Turn to'}
              value={draft.range.max}
              onChange={(max) =>
                setRange({ min: Math.min(max, draft.range.min), max })
              }
            />
            <span className="assembly-unit">{unit}</span>
          </span>
          <span className="assembly-muted">
            0 is where it sits now.
            {draft.move === 'slide' && !rangeEdited
              ? ' Sized to clear the base.'
              : ''}
          </span>
        </SetupStep>
        <SetupStep index={5} title="Cycle">
          <span className="assembly-setup-cycle">
            <select
              className="assembly-select"
              aria-label="Cycle"
              value={draft.mode}
              onChange={(event) =>
                update({ mode: event.currentTarget.value as AssemblyPlayback })
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
              aria-label="Speed"
              value={draft.sweepS}
              onChange={(event) =>
                update({ sweepS: Number(event.currentTarget.value) })
              }
            >
              {MOTION_SETUP_SWEEPS.map((option) => (
                <option key={option.sweepS} value={option.sweepS}>
                  {option.label} · {option.sweepS} s
                </option>
              ))}
            </select>
          </span>
        </SetupStep>
      </ol>

      <label className="assembly-check">
        <input
          type="checkbox"
          checked={setup.previewing}
          onChange={(event) =>
            assemblyRuntime.updateMotionSetup({}, event.currentTarget.checked)
          }
        />
        <span>Preview motion</span>
      </label>

      {'error' in result ? (
        <p className="form-error" role="alert">
          {result.error}
        </p>
      ) : null}

      <div className="assembly-actions">
        <button
          type="button"
          className="assembly-link-button assembly-setup-pick"
          title="Join on picked holes, faces or edges (J)"
          onClick={() => assemblyRuntime.openJointTool()}
        >
          <Link2 size={12} aria-hidden="true" />
          Pick on the model
        </button>
        <button
          type="button"
          className="secondary"
          onClick={() => assemblyRuntime.closeMotionSetup()}
        >
          Cancel
        </button>
        <button
          type="button"
          className="primary"
          disabled={'error' in result}
          onClick={create}
        >
          Create and play
        </button>
      </div>
    </section>
  );
}

function SetupStep({
  index,
  title,
  children
}: {
  index: number;
  title: string;
  children: ReactNode;
}) {
  return (
    <li className="assembly-step is-done">
      <span className="assembly-step-index">{index}</span>
      <span className="assembly-step-text assembly-setup-field">
        <span className="assembly-step-title">{title}</span>
        {children}
      </span>
    </li>
  );
}

function SetupNumber({
  label,
  value,
  onChange
}: {
  label: string;
  value: number;
  onChange(value: number): void;
}) {
  const [draft, setDraft] = useState(String(value));
  const [shown, setShown] = useState(value);
  // A new value from outside (a reset) replaces what is typed.
  if (shown !== value) {
    setShown(value);
    setDraft(String(value));
  }
  const commit = () => {
    const parsed = Number(draft.trim());
    if (draft.trim() !== '' && Number.isFinite(parsed) && parsed !== value)
      onChange(parsed);
    else setDraft(String(value));
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
    </span>
  );
}
