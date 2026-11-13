import { useEffect, useMemo, useRef, useState } from 'react';
import { Pause, Play, Repeat, Square } from 'lucide-react';
import {
  motionStudyDrivers,
  motionStudyValues,
  type AssemblyMotionStudy,
  type AssemblyPlayback,
  type AssemblySet
} from '@openzcad/shared';
import { playbackFrame } from '../../lib/assembly/assemblyPlayback';
import {
  assemblyRuntime,
  getAssemblyRuntime,
  useAssemblyRuntime
} from '../../lib/assembly/assemblyRuntime';
import { getAnimatePrefs } from '../../lib/assembly/assemblyUi';
import {
  formatStudyTime,
  jointSweepStudy
} from '../../lib/assembly/motionStudy';

export interface AssemblyPlayerProps {
  /**
   * The open document's assembly section; the player hides when it has
   * neither studies nor a joint with a range to play.
   */
  assembly: AssemblySet | undefined;
}

function effectivePlayback(
  study: AssemblyMotionStudy,
  loop: boolean
): AssemblyPlayback {
  if (!loop) return 'once';
  return study.playback === 'once' ? 'loop' : study.playback;
}

/**
 * AS07 View mode player: a floating island that plays the project's motion
 * studies (or, in a project without any, each joint's Animate sweep) for
 * someone who only looks — the owner in View, or a visitor on a
 * shared link (it renders in the same View mode overlay). It runs its own
 * clock and writes only the runtime's transient joint values, never a
 * command: nothing a viewer does here is saved, and the study's own
 * playback mode is only a default for the loop toggle.
 *
 * Showing poses: the first Play or scrub turns the runtime on
 * (`assemblyRuntime.setActive(true)`), so the viewport draws components at
 * their joint poses. It stays on while the player shows a pose — playing,
 * or paused anywhere, 0 included — so pausing never makes the parts jump.
 * Stop (the square), leaving View mode (unmount) or another owner turning
 * the runtime off ends it; the player only turns off what it turned on.
 */
export function AssemblyPlayer({ assembly }: AssemblyPlayerProps) {
  const studies = useMemo(() => {
    if (!assembly) return [];
    if (assembly.studies.length > 0) return assembly.studies;
    const { sweepS } = getAnimatePrefs();
    // Each joint's sweep covers what it can really travel: a joint coupled
    // to a limited one plays that narrower range, as Animate does.
    return assembly.joints.flatMap(
      (joint) => jointSweepStudy(joint, sweepS, assembly) ?? []
    );
  }, [assembly]);
  const [chosenId, setChosenId] = useState<string | null>(null);
  const study = studies.find((s) => s.id === chosenId) ?? studies[0];
  const [playing, setPlaying] = useState(false);
  const [t, setT] = useState(0);
  const [loop, setLoop] = useState<boolean | null>(null);
  const [showing, setShowing] = useState(false);
  const ownsActiveRef = useRef(false);
  const clockRef = useRef({ startedAtMs: 0, fromS: 0 });
  const active = useAssemblyRuntime((s) => s.active);
  const looping = loop ?? (study ? study.playback !== 'once' : true);

  // Someone else turned the runtime off (project switch, mode change).
  useEffect(() => {
    if (!active && showing) {
      ownsActiveRef.current = false;
      setShowing(false);
      setPlaying(false);
    }
  }, [active, showing]);

  // Leaving View mode drops the pose.
  useEffect(
    () => () => {
      if (ownsActiveRef.current) assemblyRuntime.setActive(false);
      ownsActiveRef.current = false;
    },
    []
  );

  useEffect(() => {
    if (!playing || !assembly || !study) return;
    const played: AssemblySet = {
      ...assembly,
      studies: [{ ...study, playback: effectivePlayback(study, looping) }]
    };
    const clock = clockRef.current;
    let frame = 0;
    const tick = (now: number) => {
      frame = 0;
      const next = playbackFrame(
        played,
        {
          kind: 'study',
          studyId: study.id,
          speed: 1,
          fromS: clock.fromS,
          startedAtMs: clock.startedAtMs
        },
        now
      );
      if (!next) {
        setPlaying(false);
        return;
      }
      assemblyRuntime.setOverrides(next.overrides, next.drivers);
      setT(next.studyTimeS ?? 0);
      if (next.done) {
        setPlaying(false);
        return;
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => {
      if (frame) cancelAnimationFrame(frame);
    };
  }, [playing, assembly, study, looping]);

  if (!assembly || !study) return null;
  const set = assembly;
  const current = study;
  const duration = current.durationS;
  const shownT = Math.min(t, duration);

  function show() {
    if (!getAssemblyRuntime().active) {
      assemblyRuntime.setActive(true);
      ownsActiveRef.current = true;
    }
    setShowing(true);
  }

  function restartClock(fromS: number) {
    clockRef.current = { startedAtMs: performance.now(), fromS };
  }

  function play() {
    show();
    const from = !looping && shownT >= duration - 1e-6 ? 0 : shownT;
    restartClock(from);
    setPlaying(true);
  }

  function seek(at: number) {
    show();
    setPlaying(false);
    const clamped = Math.min(duration, Math.max(0, at));
    setT(clamped);
    assemblyRuntime.setOverrides(
      motionStudyValues(set, current, clamped),
      motionStudyDrivers(current)
    );
  }

  function stop() {
    setPlaying(false);
    setT(0);
    setShowing(false);
    if (ownsActiveRef.current) assemblyRuntime.setActive(false);
    else assemblyRuntime.clearOverrides();
    ownsActiveRef.current = false;
  }

  function choose(studyId: string) {
    const next = studies.find((s) => s.id === studyId);
    if (!next || next.id === current.id) return;
    setChosenId(studyId);
    setPlaying(false);
    setLoop(null);
    setT(0);
    if (showing)
      assemblyRuntime.setOverrides(
        motionStudyValues(set, next, 0),
        motionStudyDrivers(next)
      );
  }

  function toggleLoop() {
    setLoop(!looping);
    if (playing) restartClock(shownT);
  }

  return (
    <div className="assembly-player" role="group" aria-label="Motion player">
      {studies.length > 1 ? (
        <select
          className="assembly-player-study"
          aria-label="Motion study"
          value={current.id}
          onChange={(event) => choose(event.target.value)}
        >
          {studies.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
      ) : (
        <span className="assembly-player-name">{current.name}</span>
      )}
      <button
        type="button"
        className="assembly-player-play"
        aria-label={playing ? 'Pause' : 'Play'}
        title={playing ? 'Pause' : 'Play'}
        onClick={() => (playing ? setPlaying(false) : play())}
      >
        {playing ? (
          <Pause size={14} aria-hidden="true" />
        ) : (
          <Play size={14} aria-hidden="true" />
        )}
      </button>
      <input
        type="range"
        className="assembly-player-slider"
        aria-label="Position"
        min={0}
        max={duration}
        step={0.01}
        value={shownT}
        onChange={(event) => seek(Number(event.target.value))}
      />
      <span className="assembly-player-time">
        {formatStudyTime(shownT)} / {formatStudyTime(duration)} s
      </span>
      <button
        type="button"
        className="assembly-player-toggle"
        aria-label="Loop"
        aria-pressed={looping}
        title={looping ? 'Loop is on' : 'Loop is off: play once'}
        onClick={toggleLoop}
      >
        <Repeat size={13} aria-hidden="true" />
      </button>
      {showing && (
        <button
          type="button"
          className="assembly-player-toggle"
          aria-label="Stop"
          title="Stop playing and return to the model"
          onClick={stop}
        >
          <Square size={12} aria-hidden="true" />
        </button>
      )}
    </div>
  );
}
