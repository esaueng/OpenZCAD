import type * as THREE from 'three';

/**
 * How long the scene takes to recede behind a selection, or to come back
 * when the selection ends. Short enough to read as a response to the click,
 * long enough that the largest brightness change the viewport makes (every
 * body but the pick losing about a third of its brightness) is never a
 * one-frame pop.
 */
export const SELECTION_RECEDE_MS = 140;

/**
 * The longest step the first frame of an ease may take. The loop renders on
 * demand, so the frame an ease starts on can follow a long idle gap; counting
 * that gap would land most of the ease in its first frame — the pop it
 * exists to remove.
 */
const FIRST_STEP_MS = 1000 / 60;

interface BodyRecede {
  base: THREE.ColorRepresentation;
  /** Where the current ease started. */
  from: number;
  target: number;
  level: number;
  elapsedMs: number;
  durationMs: number;
}

/**
 * Smoothstep: no step at either end, so neither the first nor the last frame
 * of the ease is a visible jump, and the steepest frame moves 1.5× the
 * average rather than the 3× a cubic ease-out would front-load.
 */
function smoothstep(t: number): number {
  return t * t * (3 - 2 * t);
}

/**
 * How far each body has receded behind the selection: 0 is its own colour,
 * 1 the context dim (`recededBodyColor`).
 *
 * Which body is the selection is a state change and cuts, like every other
 * selection tint. Only the scene-wide recede turning on or off eases, over
 * {@link SELECTION_RECEDE_MS}, because it changes the brightness of the whole
 * viewport at once. Per body rather than one global level, so a body that
 * was the selection when the recede ends stays at its own colour instead of
 * dropping to the dim the others are easing up from.
 *
 * Levels are keyed by body id, not by mesh, so a body rebuilt while an ease
 * is in flight (a commit landing as the selection changes) picks up where its
 * old mesh was rather than starting over at either end.
 */
export class SelectionRecede {
  private readonly bodies = new Map<string, BodyRecede>();

  /**
   * Sets where a body is headed and returns the level to draw it at now.
   * `ease` eases a change of target over {@link SELECTION_RECEDE_MS};
   * otherwise it cuts. A body seen for the first time starts at its target.
   */
  set(
    bodyId: string,
    base: THREE.ColorRepresentation,
    target: number,
    ease: boolean
  ): number {
    const entry = this.bodies.get(bodyId);
    if (!entry) {
      this.bodies.set(bodyId, {
        base,
        from: target,
        target,
        level: target,
        elapsedMs: 0,
        durationMs: 0
      });
      return target;
    }
    entry.base = base;
    if (entry.target === target) {
      // Unchanged: an ease already on its way there carries on.
      return entry.level;
    }
    entry.target = target;
    entry.from = entry.level;
    entry.elapsedMs = 0;
    entry.durationMs = ease
      ? SELECTION_RECEDE_MS * Math.abs(target - entry.level)
      : 0;
    if (entry.durationMs === 0) {
      entry.level = target;
      entry.from = target;
    }
    return entry.level;
  }

  /** The level a body is drawn at now, if it has one. */
  level(bodyId: string): number | undefined {
    return this.bodies.get(bodyId)?.level;
  }

  /** Forgets bodies that are no longer drawn. */
  retain(bodyIds: ReadonlySet<string>): void {
    for (const id of this.bodies.keys()) {
      if (!bodyIds.has(id)) this.bodies.delete(id);
    }
  }

  /** True while any body is still easing. */
  get animating(): boolean {
    for (const entry of this.bodies.values()) {
      if (entry.level !== entry.target) return true;
    }
    return false;
  }

  /** Every body's base colour and current level. */
  *entries(): IterableIterator<
    [string, { base: THREE.ColorRepresentation; level: number }]
  > {
    for (const [bodyId, entry] of this.bodies)
      yield [bodyId, { base: entry.base, level: entry.level }];
  }

  /**
   * Advances every easing body by one frame of `dtMs` and hands each one that
   * moved to `apply`. Returns whether any is still easing, which is what
   * keeps the on-demand loop drawing frames — only while it does.
   *
   * `reducedMotion` is read every frame, so turning Reduce motion on (in the
   * app or the OS) while an ease is running lands every body on its target
   * this frame instead of animating the rest of the way.
   */
  step(
    dtMs: number,
    apply: (
      bodyId: string,
      base: THREE.ColorRepresentation,
      level: number
    ) => void,
    reducedMotion = false
  ): boolean {
    let moving = false;
    for (const [bodyId, entry] of this.bodies) {
      if (entry.level === entry.target) continue;
      if (reducedMotion) {
        entry.level = entry.target;
        entry.from = entry.target;
        entry.elapsedMs = 0;
        entry.durationMs = 0;
        apply(bodyId, entry.base, entry.level);
        continue;
      }
      const step = entry.elapsedMs === 0 ? Math.min(dtMs, FIRST_STEP_MS) : dtMs;
      if (!(step > 0)) {
        moving = true;
        continue;
      }
      entry.elapsedMs += step;
      const t = Math.min(entry.elapsedMs / entry.durationMs, 1);
      entry.level =
        t >= 1
          ? entry.target
          : entry.from + (entry.target - entry.from) * smoothstep(t);
      apply(bodyId, entry.base, entry.level);
      if (entry.level !== entry.target) moving = true;
    }
    return moving;
  }
}
