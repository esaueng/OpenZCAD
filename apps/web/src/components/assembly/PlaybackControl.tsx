import type { AssemblyPlayback } from '@openzcad/shared';
import { ANIMATE_MODES, ANIMATE_SPEEDS } from '../../lib/assembly/assemblyUi';

export interface PlaybackControlProps {
  mode: AssemblyPlayback;
  onModeChange(mode: AssemblyPlayback): void;
  /** Seconds for one sweep; the speed select shows only with a handler. */
  sweepS?: number;
  onSweepChange?(sweepS: number): void;
  disabled?: boolean;
}

/**
 * How motion plays, set the same way everywhere it can be set (review I57):
 * a joint's details, Set up motion and a study's timeline all show one
 * "Playback" select (once, loop, back and forth) and, where a sweep has a
 * duration, one "Speed" select with the same named speeds.
 */
export function PlaybackControl({
  mode,
  onModeChange,
  sweepS,
  onSweepChange,
  disabled = false
}: PlaybackControlProps) {
  return (
    <>
      <select
        className="assembly-select"
        aria-label="Playback"
        value={mode}
        disabled={disabled}
        onChange={(event) =>
          onModeChange(event.currentTarget.value as AssemblyPlayback)
        }
      >
        {ANIMATE_MODES.map((option) => (
          <option key={option.mode} value={option.mode}>
            {option.label}
          </option>
        ))}
      </select>
      {onSweepChange && sweepS !== undefined ? (
        <select
          className="assembly-select"
          aria-label="Speed"
          value={sweepS}
          disabled={disabled}
          onChange={(event) => onSweepChange(Number(event.currentTarget.value))}
        >
          {ANIMATE_SPEEDS.map((option) => (
            <option key={option.sweepS} value={option.sweepS}>
              {option.label}
            </option>
          ))}
        </select>
      ) : null}
    </>
  );
}
