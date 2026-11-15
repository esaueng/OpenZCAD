/**
 * How long a first Escape on a sketch's last rung waits for the second that
 * leaves (I43). Long enough to read the prompt and press again; a press
 * after it arms again rather than leaving.
 */
export const SKETCH_EXIT_CONFIRM_MS = 3000;

/**
 * Inside a sketch Escape only steps back: it ends a chain, drops a pick,
 * disarms a tool and deselects. On the last rung, with nothing left to
 * step back from, one press used to leave the sketch, so the reflex second
 * Escape after placing a dimension dropped people into 3D. Now that press
 * arms the exit and says so, and only a second one within
 * `SKETCH_EXIT_CONFIRM_MS` leaves. Finish Sketch still leaves in one click.
 */
export function sketchExitEscape(
  armedAt: number | null,
  now: number
): { leave: boolean; armedAt: number | null } {
  return armedAt !== null && now - armedAt <= SKETCH_EXIT_CONFIRM_MS
    ? { leave: true, armedAt: null }
    : { leave: false, armedAt: now };
}
