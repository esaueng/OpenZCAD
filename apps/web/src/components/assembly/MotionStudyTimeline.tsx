import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent
} from 'react';
import { Pause, Play, Plus, SkipBack, X } from 'lucide-react';
import { commandFactories, type AnyCommand } from '@openzcad/command-system';
import {
  evaluateTrack,
  motionStudyValues,
  type AssemblyEasing,
  type AssemblyMotionStudy,
  type AssemblyPlayback,
  type AssemblySet
} from '@openzcad/shared';
import {
  assemblyRuntime,
  getAssemblyRuntime,
  useAssemblyRuntime
} from '../../lib/assembly/assemblyRuntime';
import {
  addTrack,
  currentJointValue,
  deleteKey,
  dofName,
  dofUnit,
  formatDofValue,
  formatStudyTime,
  keyIndexAt,
  keyValueY,
  moveKey,
  nextKeyTime,
  previousKeyTime,
  removeTrack,
  rulerTicks,
  setKeyAt,
  setStudyDuration,
  studyError,
  trackCurvePoints,
  untrackedMotions,
  updateKey
} from '../../lib/assembly/motionStudy';

export interface MotionStudyTimelineProps {
  /** The open document's assembly section. */
  assembly: AssemblySet | undefined;
  /** Runs one undoable command; false when it was refused. */
  execute(command: AnyCommand): boolean;
  /** After the timeline closed the study (it deselects it itself). */
  onClose?(): void;
  /** Plays and scrubs, but offers no edits. */
  readOnly?: boolean;
  /**
   * Floats as an island across the stage's bottom lane (between the docks)
   * instead of filling the container the layout gives it.
   */
  floating?: boolean;
}

const PLAYBACK_MODES: { mode: AssemblyPlayback; label: string }[] = [
  { mode: 'once', label: 'Once' },
  { mode: 'loop', label: 'Loop' },
  { mode: 'ping-pong', label: 'Back and forth' }
];

const SPEEDS = [0.5, 1, 2] as const;

const EASINGS: { easing: AssemblyEasing; label: string }[] = [
  { easing: 'linear', label: 'Linear' },
  { easing: 'ease', label: 'Ease in-out' }
];

interface KeySelection {
  trackIndex: number;
  keyIndex: number;
}

interface KeyDrag extends KeySelection {
  pointerId: number;
  startX: number;
  lane: HTMLElement;
  moved: boolean;
  draft: AssemblyMotionStudy | null;
}

/** Seconds under a client x over a lane or the ruler. */
function timeAt(element: HTMLElement, clientX: number, durationS: number) {
  const rect = element.getBoundingClientRect();
  if (!(rect.width > 0)) return 0;
  const u = (clientX - rect.left) / rect.width;
  return Math.min(durationS, Math.max(0, u * durationS));
}

function percent(t: number, durationS: number): string {
  return `${(100 * Math.min(1, Math.max(0, t / durationS))).toFixed(3)}%`;
}

function capture(element: HTMLElement, pointerId: number) {
  try {
    element.setPointerCapture?.(pointerId);
  } catch {
    // Synthetic pointers (tests, some pens) have nothing to capture.
  }
}

/** Shows the study's pose at `t` with the clock stopped. */
function showAt(set: AssemblySet, study: AssemblyMotionStudy, t: number) {
  assemblyRuntime.setStudyTime(t);
  assemblyRuntime.setOverrides(motionStudyValues(set, study, t));
}

/**
 * AS07 motion study timeline: the bottom dock the Assemble workspace shows
 * while a study is selected. Transport, a ruler, and one row per joint
 * motion with its value curve and keys. Every edit is one
 * `assembly.study.set` command; playing and scrubbing only move the
 * runtime's transient values and are never saved. Its shortcuts (Space,
 * K, [ and ], Delete) act only while focus is inside it.
 */
export function MotionStudyTimeline({
  assembly,
  execute,
  onClose,
  readOnly = false,
  floating = false
}: MotionStudyTimelineProps) {
  const selectedStudyId = useAssemblyRuntime((s) => s.selectedStudyId);
  const studyTimeS = useAssemblyRuntime((s) => s.studyTimeS);
  const playback = useAssemblyRuntime((s) => s.playback);
  const saved = assembly?.studies.find((s) => s.id === selectedStudyId);

  const [speed, setSpeed] = useState<number>(1);
  const [selection, setSelection] = useState<KeySelection | null>(null);
  const [selectedTrack, setSelectedTrack] = useState<number | null>(null);
  const [draft, setDraft] = useState<AssemblyMotionStudy | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const dragRef = useRef<KeyDrag | null>(null);
  const scrubRef = useRef<number | null>(null);

  const setRef = useRef(assembly);
  setRef.current = assembly;

  const playing =
    playback?.kind === 'study' && playback.studyId === selectedStudyId;
  const studyKey = useMemo(() => (saved ? JSON.stringify(saved) : ''), [saved]);

  // Paused, the parts show the study at the playhead: on open, after every
  // edit, and when playback ends. Keyed on the study's content, so a pose
  // committed from the viewport is not overwritten until the study changes.
  useEffect(() => {
    const set = setRef.current;
    if (!set || !saved || playing) return;
    const t = Math.min(getAssemblyRuntime().studyTimeS, saved.durationS);
    showAt(set, saved, t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [studyKey, playing]);

  // A study removed under the timeline (undo, another tab) closes it.
  useEffect(() => {
    if (selectedStudyId && assembly && !saved) {
      assemblyRuntime.stop();
      assemblyRuntime.selectStudy(null);
    }
  }, [selectedStudyId, assembly, saved]);

  // Leaving drops playback and the transient pose: parts return to their
  // saved values.
  useEffect(() => () => assemblyRuntime.stop(), []);

  // A selection that no longer exists (key deleted elsewhere) clears.
  useEffect(() => {
    if (
      selection &&
      !saved?.tracks[selection.trackIndex]?.keys[selection.keyIndex]
    )
      setSelection(null);
    if (selectedTrack !== null && !saved?.tracks[selectedTrack])
      setSelectedTrack(null);
  }, [saved, selection, selectedTrack]);

  if (!assembly || !saved) return null;
  const set = assembly;
  const base: AssemblyMotionStudy = saved;
  const study = draft ?? saved;
  const duration = study.durationS;
  const t = Math.min(studyTimeS, duration);
  const ticks = rulerTicks(duration);
  const jointById = new Map(set.joints.map((j) => [j.id, j]));
  const untracked = untrackedMotions(set, saved);

  function commit(
    next: AssemblyMotionStudy | null,
    label: string,
    refusal: string
  ): boolean {
    if (readOnly) return false;
    if (!next) {
      setNote(refusal);
      return false;
    }
    const error = studyError(set, next);
    if (error) {
      setNote(error);
      return false;
    }
    setNote(null);
    return execute(commandFactories.setAssemblyStudy({ study: next }, label));
  }

  function pause() {
    const at = Math.min(getAssemblyRuntime().studyTimeS, base.durationS);
    assemblyRuntime.stop();
    showAt(set, base, at);
  }

  function play() {
    let from = Math.min(getAssemblyRuntime().studyTimeS, base.durationS);
    if (base.playback === 'once' && from >= base.durationS - 1e-6) from = 0;
    assemblyRuntime.startStudy(base.id, speed, from);
  }

  function togglePlay() {
    if (playing) pause();
    else play();
  }

  function toStart() {
    if (playing) assemblyRuntime.startStudy(base.id, speed, 0);
    else showAt(set, base, 0);
  }

  function seek(at: number) {
    // Any motion (this study, or an Animate sweep) yields to the scrub.
    if (getAssemblyRuntime().playback) assemblyRuntime.stop();
    showAt(set, base, Math.min(base.durationS, Math.max(0, at)));
  }

  function changeSpeed(next: number) {
    setSpeed(next);
    if (playing)
      assemblyRuntime.startStudy(
        base.id,
        next,
        Math.min(getAssemblyRuntime().studyTimeS, base.durationS)
      );
  }

  function keyAtPlayhead() {
    if (readOnly) return;
    const runtime = getAssemblyRuntime();
    const at = Math.min(runtime.studyTimeS, base.durationS);
    const targets = selection
      ? [selection.trackIndex]
      : selectedTrack !== null
        ? [selectedTrack]
        : base.tracks.map((_, index) => index);
    if (targets.length === 0) {
      setNote('Add a joint track first.');
      return;
    }
    let next: AssemblyMotionStudy | null = base;
    for (const index of targets) {
      const track = next.tracks[index];
      if (!track) continue;
      const joint = jointById.get(track.jointId);
      // What the part shows now: a pose dragged in the viewport, else the
      // study's own value there.
      const value = joint
        ? currentJointValue(joint, track.dof, runtime.overrides)
        : evaluateTrack(track, at);
      next = setKeyAt(next, index, at, value);
      if (!next) break;
    }
    const keyed = next;
    if (
      commit(
        keyed,
        'Key at playhead',
        'This track holds as many keys as it can.'
      )
    ) {
      const only = targets.length === 1 ? targets[0] : undefined;
      const track = only === undefined ? undefined : keyed?.tracks[only];
      setSelection(
        track && only !== undefined
          ? { trackIndex: only, keyIndex: keyIndexAt(track, at) }
          : null
      );
    }
  }

  function removeSelectedKey() {
    if (readOnly || !selection) return;
    if (
      commit(
        deleteKey(base, selection.trackIndex, selection.keyIndex),
        'Delete key',
        'A track keeps at least one key. Remove the track instead.'
      )
    )
      setSelection(null);
  }

  function jumpKey(direction: -1 | 1) {
    const scope = selection?.trackIndex ?? selectedTrack ?? undefined;
    const at = getAssemblyRuntime().studyTimeS;
    const target =
      direction > 0
        ? nextKeyTime(base, at, scope)
        : previousKeyTime(base, at, scope);
    if (target !== null) seek(target);
  }

  function onKeyDown(event: ReactKeyboardEvent<HTMLElement>) {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const target = event.target as HTMLElement;
    if (target.closest('input, textarea, select, [contenteditable="true"]'))
      return;
    let handled = true;
    if (event.key === ' ') {
      // Buttons other than keys keep Space for their own activation.
      if (
        target.tagName === 'BUTTON' &&
        !target.classList.contains('motion-key')
      )
        return;
      togglePlay();
    } else if (event.key === 'k' || event.key === 'K') keyAtPlayhead();
    else if (event.key === '[') jumpKey(-1);
    else if (event.key === ']') jumpKey(1);
    else if (event.key === 'Delete' || event.key === 'Backspace') {
      if (!selection) return;
      removeSelectedKey();
    } else if (event.key === 'Escape' && addOpen) setAddOpen(false);
    else handled = false;
    if (handled) {
      event.preventDefault();
      event.stopPropagation();
    }
  }

  function onScrubDown(event: ReactPointerEvent<HTMLElement>) {
    if (event.button !== 0) return;
    const element = event.currentTarget;
    scrubRef.current = event.pointerId;
    capture(element, event.pointerId);
    seek(timeAt(element, event.clientX, base.durationS));
  }

  function onScrubMove(event: ReactPointerEvent<HTMLElement>) {
    if (scrubRef.current !== event.pointerId) return;
    seek(timeAt(event.currentTarget, event.clientX, base.durationS));
  }

  function onScrubUp(event: ReactPointerEvent<HTMLElement>) {
    if (scrubRef.current === event.pointerId) scrubRef.current = null;
  }

  function onKeyPointerDown(
    event: ReactPointerEvent<HTMLButtonElement>,
    trackIndex: number,
    keyIndex: number
  ) {
    event.stopPropagation();
    if (event.button !== 0) return;
    setSelection({ trackIndex, keyIndex });
    setSelectedTrack(trackIndex);
    if (readOnly) return;
    const lane = event.currentTarget.parentElement;
    if (!lane) return;
    capture(event.currentTarget, event.pointerId);
    dragRef.current = {
      trackIndex,
      keyIndex,
      pointerId: event.pointerId,
      startX: event.clientX,
      lane,
      moved: false,
      draft: null
    };
  }

  function onKeyPointerMove(event: ReactPointerEvent<HTMLButtonElement>) {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (!drag.moved && Math.abs(event.clientX - drag.startX) < 3) return;
    drag.moved = true;
    const moved = moveKey(
      base,
      drag.trackIndex,
      drag.keyIndex,
      timeAt(drag.lane, event.clientX, base.durationS)
    );
    if (!moved) return;
    drag.draft = moved.study;
    setDraft(moved.study);
  }

  function onKeyPointerUp(event: ReactPointerEvent<HTMLButtonElement>) {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    dragRef.current = null;
    setDraft(null);
    if (drag.moved && drag.draft)
      commit(drag.draft, 'Move key', 'That key cannot move there.');
  }

  function close() {
    assemblyRuntime.stop();
    assemblyRuntime.selectStudy(null);
    onClose?.();
  }

  const selectedKey = selection
    ? study.tracks[selection.trackIndex]?.keys[selection.keyIndex]
    : undefined;
  const selectedKeyTrack = selection
    ? study.tracks[selection.trackIndex]
    : undefined;
  const selectedKeyJoint = selectedKeyTrack
    ? jointById.get(selectedKeyTrack.jointId)
    : undefined;

  return (
    <section
      className={
        floating
          ? 'motion-timeline motion-timeline-floating'
          : 'motion-timeline'
      }
      aria-label={`Motion study ${saved.name}`}
      tabIndex={0}
      onKeyDown={onKeyDown}
    >
      <div className="motion-timeline-transport">
        <button
          type="button"
          className="motion-icon-button"
          aria-label="Back to start"
          title="Back to start"
          onClick={toStart}
        >
          <SkipBack size={14} aria-hidden="true" />
        </button>
        <button
          type="button"
          className="motion-play"
          aria-label={playing ? 'Pause' : 'Play'}
          title={playing ? 'Pause (Space)' : 'Play (Space)'}
          onClick={togglePlay}
        >
          {playing ? (
            <Pause size={14} aria-hidden="true" />
          ) : (
            <Play size={14} aria-hidden="true" />
          )}
        </button>
        <span className="motion-time" aria-label="Playhead">
          {formatStudyTime(t)} / {formatStudyTime(duration)} s
        </span>
        <select
          className="assembly-select motion-select"
          aria-label="Playback"
          value={saved.playback}
          disabled={readOnly}
          onChange={(event) => {
            const mode = event.currentTarget.value as AssemblyPlayback;
            if (saved.playback !== mode)
              commit(
                { ...saved, playback: mode },
                'Change motion playback',
                ''
              );
          }}
        >
          {PLAYBACK_MODES.map(({ mode, label }) => (
            <option key={mode} value={mode}>
              {label}
            </option>
          ))}
        </select>
        <select
          className="assembly-select motion-select"
          aria-label="Speed"
          value={speed}
          onChange={(event) => changeSpeed(Number(event.currentTarget.value))}
        >
          {SPEEDS.map((value) => (
            <option key={value} value={value}>
              {value}× speed
            </option>
          ))}
        </select>
        <label className="motion-field">
          <span>Duration</span>
          <NumberField
            key={`duration-${saved.durationS}`}
            value={saved.durationS}
            unit="s"
            disabled={readOnly}
            ariaLabel="Duration in seconds"
            onCommit={(value) => {
              const next = setStudyDuration(saved, value);
              if (
                commit(
                  next,
                  'Change motion duration',
                  'Use a duration above 0 s and up to an hour that leaves room for every key.'
                ) &&
                getAssemblyRuntime().studyTimeS > value
              )
                seek(value);
            }}
          />
        </label>
        <button
          type="button"
          className="motion-text-button"
          disabled={readOnly || saved.tracks.length === 0}
          title={
            selection || selectedTrack !== null
              ? 'Key the selected track at the playhead (K)'
              : 'Key every track at the playhead (K)'
          }
          onClick={keyAtPlayhead}
        >
          Key at playhead (K)
        </button>
        {note && (
          <span className="motion-timeline-note" role="status">
            {note}
          </span>
        )}
        <button
          type="button"
          className="motion-icon-button motion-timeline-close"
          aria-label="Close motion study"
          title="Close motion study"
          onClick={close}
        >
          <X size={14} aria-hidden="true" />
        </button>
      </div>

      <div className="motion-timeline-grid">
        <div className="motion-track-label motion-ruler-label">
          {saved.name}
        </div>
        <div
          className="motion-ruler"
          data-testid="motion-ruler"
          onPointerDown={onScrubDown}
          onPointerMove={onScrubMove}
          onPointerUp={onScrubUp}
          onPointerCancel={onScrubUp}
        >
          {ticks.map((tick) => (
            <span
              key={tick.t}
              className={
                tick.label ? 'motion-tick motion-tick-major' : 'motion-tick'
              }
              style={{ left: percent(tick.t, duration) }}
            >
              {tick.label && (
                <span className="motion-tick-label">{tick.label}</span>
              )}
            </span>
          ))}
          <span
            className="motion-playhead"
            style={{ left: percent(t, duration) }}
          />
        </div>

        {study.tracks.map((track, trackIndex) => {
          const joint = jointById.get(track.jointId);
          const kind = joint?.kind ?? 'revolute';
          const unit = dofUnit(kind, track.dof);
          const name = joint
            ? joint.values.length > 1
              ? `${joint.name} · ${dofName(kind, track.dof)}`
              : joint.name
            : 'Missing joint';
          const rowSelected = selectedTrack === trackIndex;
          return (
            <div
              key={`${track.jointId}/${track.dof}`}
              className="motion-track"
              role="group"
              aria-label={`Track ${name}`}
            >
              <div
                className={
                  rowSelected
                    ? 'motion-track-label motion-track-label-selected'
                    : 'motion-track-label'
                }
              >
                <button
                  type="button"
                  className="motion-track-name"
                  aria-pressed={rowSelected}
                  title="Select this track (K keys it alone)"
                  onClick={() => {
                    setSelection(null);
                    setSelectedTrack(rowSelected ? null : trackIndex);
                  }}
                >
                  {name}
                </button>
                <span className="motion-track-value">
                  {formatDofValue(evaluateTrack(track, t), unit)}
                </span>
                {!readOnly && (
                  <button
                    type="button"
                    className="motion-track-remove"
                    aria-label={`Remove track ${name}`}
                    title="Remove track"
                    onClick={() => {
                      if (
                        commit(
                          removeTrack(saved, trackIndex),
                          'Remove motion track',
                          ''
                        )
                      ) {
                        setSelection(null);
                        setSelectedTrack(null);
                      }
                    }}
                  >
                    <X size={11} aria-hidden="true" />
                  </button>
                )}
              </div>
              <div
                className="motion-lane"
                data-testid={`motion-lane-${trackIndex}`}
                onPointerDown={onScrubDown}
                onPointerMove={onScrubMove}
                onPointerUp={onScrubUp}
                onPointerCancel={onScrubUp}
              >
                <svg
                  className="motion-curve"
                  viewBox="0 0 1000 100"
                  preserveAspectRatio="none"
                  aria-hidden="true"
                >
                  <polyline points={trackCurvePoints(track, duration)} />
                </svg>
                {track.keys.map((key, keyIndex) => {
                  const selected =
                    selection?.trackIndex === trackIndex &&
                    selection.keyIndex === keyIndex;
                  return (
                    <button
                      key={keyIndex}
                      type="button"
                      className={
                        selected
                          ? 'motion-key motion-key-selected'
                          : 'motion-key'
                      }
                      style={{
                        left: percent(key.t, duration),
                        top: `${keyValueY(track, key.value)}%`
                      }}
                      aria-pressed={selected}
                      aria-label={`Key at ${formatStudyTime(key.t)} s, ${formatDofValue(key.value, unit)}`}
                      onPointerDown={(event) =>
                        onKeyPointerDown(event, trackIndex, keyIndex)
                      }
                      onPointerMove={onKeyPointerMove}
                      onPointerUp={onKeyPointerUp}
                      onPointerCancel={onKeyPointerUp}
                      onClick={() => {
                        setSelection({ trackIndex, keyIndex });
                        setSelectedTrack(trackIndex);
                      }}
                    />
                  );
                })}
                <span
                  className="motion-playhead"
                  style={{ left: percent(t, duration) }}
                />
              </div>
            </div>
          );
        })}

        {study.tracks.length === 0 && (
          <p className="motion-timeline-empty">
            No tracks yet. Add a joint track to animate it.
          </p>
        )}

        {!readOnly && (
          <div className="motion-track-add">
            <button
              type="button"
              className="motion-text-button"
              aria-haspopup="menu"
              aria-expanded={addOpen}
              disabled={untracked.length === 0}
              title={
                untracked.length === 0
                  ? 'Every joint motion already has a track'
                  : 'Animate another joint motion'
              }
              onClick={() => setAddOpen((open) => !open)}
            >
              <Plus size={12} aria-hidden="true" />
              Add joint track
            </button>
            {addOpen && untracked.length > 0 && (
              <div
                className="motion-track-menu"
                role="menu"
                aria-label="Joint motions"
              >
                {untracked.map(({ joint, dof }) => (
                  <button
                    key={`${joint.id}/${dof}`}
                    type="button"
                    role="menuitem"
                    className="motion-track-menu-item"
                    onClick={() => {
                      setAddOpen(false);
                      const value = currentJointValue(
                        joint,
                        dof,
                        getAssemblyRuntime().overrides
                      );
                      if (
                        commit(
                          addTrack(set, saved, joint.id, dof, value),
                          'Add motion track',
                          'This study cannot take another track.'
                        )
                      )
                        setSelectedTrack(saved.tracks.length);
                    }}
                  >
                    {joint.values.length > 1
                      ? `${joint.name} · ${dofName(joint.kind, dof)}`
                      : joint.name}
                    <span className="motion-track-menu-unit">
                      {dofUnit(joint.kind, dof) === 'deg' ? '°' : 'mm'}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {selection && selectedKey && selectedKeyTrack && (
        <div
          className="motion-key-editor"
          role="group"
          aria-label="Selected key"
        >
          <span className="motion-key-editor-title">
            Key · {selectedKeyJoint?.name ?? 'Missing joint'}
          </span>
          <label className="motion-field">
            <span>Time</span>
            <NumberField
              key={`t-${selection.trackIndex}-${selection.keyIndex}-${selectedKey.t}`}
              value={selectedKey.t}
              unit="s"
              disabled={readOnly}
              ariaLabel="Key time in seconds"
              onCommit={(value) => {
                const moved = moveKey(
                  saved,
                  selection.trackIndex,
                  selection.keyIndex,
                  value
                );
                commit(
                  moved?.study ?? null,
                  'Move key',
                  'Use a time in the study.'
                );
              }}
            />
          </label>
          <label className="motion-field">
            <span>Value</span>
            <NumberField
              key={`v-${selection.trackIndex}-${selection.keyIndex}-${selectedKey.value}`}
              value={selectedKey.value}
              unit={
                dofUnit(
                  selectedKeyJoint?.kind ?? 'revolute',
                  selectedKeyTrack.dof
                ) === 'deg'
                  ? '°'
                  : 'mm'
              }
              disabled={readOnly}
              ariaLabel="Key value"
              onCommit={(value) =>
                commit(
                  updateKey(saved, selection.trackIndex, selection.keyIndex, {
                    value
                  }),
                  'Change key value',
                  'Use a finite value.'
                )
              }
            />
          </label>
          <div
            className="motion-segmented"
            role="radiogroup"
            aria-label="Easing into this key"
          >
            {EASINGS.map(({ easing, label }) => (
              <button
                key={easing}
                type="button"
                role="radio"
                aria-checked={selectedKey.easing === easing}
                className="motion-segment"
                disabled={readOnly}
                onClick={() =>
                  selectedKey.easing !== easing &&
                  commit(
                    updateKey(saved, selection.trackIndex, selection.keyIndex, {
                      easing
                    }),
                    'Change key easing',
                    ''
                  )
                }
              >
                {label}
              </button>
            ))}
          </div>
          <button
            type="button"
            className="motion-text-button"
            disabled={readOnly || selectedKeyTrack.keys.length <= 1}
            title={
              selectedKeyTrack.keys.length <= 1
                ? 'A track keeps at least one key'
                : 'Delete key (Delete)'
            }
            onClick={removeSelectedKey}
          >
            Delete key
          </button>
        </div>
      )}
    </section>
  );
}

interface NumberFieldProps {
  value: number;
  unit: string;
  disabled?: boolean;
  ariaLabel: string;
  onCommit(value: number): void;
}

/** A number typed freely and committed on Enter or blur; Escape reverts. */
function NumberField({
  value,
  unit,
  disabled,
  ariaLabel,
  onCommit
}: NumberFieldProps) {
  const initial = String(Math.round(value * 1000) / 1000);
  const [text, setText] = useState(initial);
  // What was last committed or reverted: a field that blurs after Enter or
  // Escape (or as it is replaced) must not commit again.
  const settledRef = useRef(initial);
  function commitText() {
    if (text === settledRef.current) return;
    settledRef.current = text;
    const parsed = Number(text.trim());
    if (text.trim() === '' || !Number.isFinite(parsed)) {
      settledRef.current = initial;
      setText(initial);
      return;
    }
    if (String(parsed) !== initial) onCommit(parsed);
  }
  return (
    <span className="motion-number">
      <input
        type="text"
        inputMode="decimal"
        className="motion-number-input"
        aria-label={ariaLabel}
        value={text}
        disabled={disabled}
        onChange={(event) => setText(event.target.value)}
        onBlur={commitText}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            commitText();
          } else if (event.key === 'Escape') {
            event.preventDefault();
            settledRef.current = text;
            setText(initial);
          }
        }}
      />
      <span className="motion-number-unit">{unit}</span>
    </span>
  );
}
