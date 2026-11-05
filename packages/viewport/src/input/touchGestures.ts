/**
 * Touch gestures for the 3D viewport (L02 slice 2,
 * docs/plans/ipad-touch-plan-2026-11-05.md).
 *
 * A pure state machine: the host feeds it the touch pointers' down, move, up
 * and cancel samples (CSS pixels, milliseconds) and a clock tick, and it
 * returns what those fingers meant. It owns no DOM, timer or camera, so the
 * whole vocabulary is testable with synthetic sequences, and the host decides
 * what a drag does (orbit, or a handle it hit) and when a press is its own.
 *
 * | Fingers                         | Gesture                                |
 * | ------------------------------- | -------------------------------------- |
 * | one, lifted inside the slop     | `tap` (count 2 for a quick second tap) |
 * | one, held inside the slop       | `long-press`, then nothing until lift  |
 * | one, moved past the slop        | `drag` start / move / end              |
 * | two, moved past the slop        | `pinch`: centroid pan and scale        |
 * | two or three, lifted quickly    | `multi-tap`                            |
 *
 * Only a sequence's first finger can tap, press or drag. A second finger
 * turns a press that has not yet become anything into a two-finger gesture,
 * and ends a drag before the pinch takes over. Once a pinch or a long press
 * has happened, or a finger was claimed, the remaining fingers do nothing
 * until every one has lifted, so lifting one finger of a pinch never jerks
 * the model into an orbit.
 */

export interface TouchSample {
  pointerId: number;
  /** Client CSS pixels. */
  x: number;
  y: number;
  /** Milliseconds on one monotonic clock (`PointerEvent.timeStamp`). */
  time: number;
}

export type TouchPhase = 'start' | 'move' | 'end' | 'cancel';

export type TouchGesture =
  | { type: 'tap'; x: number; y: number; count: 1 | 2 }
  | { type: 'long-press'; x: number; y: number }
  /** One finger. `dx`/`dy` are the travel since the previous drag event. */
  | {
      type: 'drag';
      phase: TouchPhase;
      x: number;
      y: number;
      dx: number;
      dy: number;
    }
  /**
   * Two fingers. `x`/`y` is their midpoint, `dx`/`dy` its travel and `scale`
   * the ratio of finger spread, each since the previous pinch event: spread
   * apart is above 1.
   */
  | {
      type: 'pinch';
      phase: TouchPhase;
      x: number;
      y: number;
      dx: number;
      dy: number;
      scale: number;
    }
  | { type: 'multi-tap'; fingers: 2 | 3 };

export interface TouchGestureOptions {
  /**
   * Travel that turns a press into a drag. Larger than the mouse's 6 px
   * click threshold: a fingertip rolls several pixels on a deliberate tap.
   */
  slopPx: number;
  longPressMs: number;
  /** Longest gap between two taps' lifts that still makes a double tap. */
  doubleTapMs: number;
  /** Farthest a second tap may land from the first. */
  doubleTapSlopPx: number;
  /** Longest a two- or three-finger tap may last. */
  multiTapMs: number;
  /**
   * Finger spread below which the scale is not trusted: two touches that
   * close read as one contact, and a ratio of tiny distances jumps.
   */
  minPinchSpreadPx: number;
}

export const DEFAULT_TOUCH_GESTURE_OPTIONS: Readonly<TouchGestureOptions> = {
  slopPx: 10,
  longPressMs: 500,
  doubleTapMs: 300,
  doubleTapSlopPx: 24,
  multiTapMs: 300,
  minPinchSpreadPx: 8
};

type Mode =
  | 'idle'
  /** One finger down, inside the slop, before the long-press deadline. */
  | 'press'
  | 'drag'
  /** Two or more fingers, none past the slop yet: maybe a multi-tap. */
  | 'fingers'
  | 'pinch'
  /** Nothing more this sequence; wait for every finger to lift. */
  | 'settling';

interface Contact {
  x: number;
  y: number;
  startX: number;
  startY: number;
}

interface Spread {
  x: number;
  y: number;
  distance: number;
}

const distance = (ax: number, ay: number, bx: number, by: number) =>
  Math.hypot(ax - bx, ay - by);

export class TouchGestureRecognizer {
  private readonly options: TouchGestureOptions;
  private readonly contacts = new Map<number, Contact>();
  private mode: Mode = 'idle';
  private sequenceStart = 0;
  private longPressAt = 0;
  private maxFingers = 0;
  private multiTapAllowed = false;
  /** The first finger's id while it alone can tap, press or drag. */
  private primary: number | null = null;
  private lastDrag: { x: number; y: number } | null = null;
  private lastSpread: Spread | null = null;
  private startSpread: Spread | null = null;
  private lastTap: { x: number; y: number; time: number } | null = null;

  constructor(options: Partial<TouchGestureOptions> = {}) {
    this.options = { ...DEFAULT_TOUCH_GESTURE_OPTIONS, ...options };
  }

  /** Fingers currently on the glass. */
  get pointerCount(): number {
    return this.contacts.size;
  }

  /** When the host should call `tick` next, or null when nothing is due. */
  nextDeadline(): number | null {
    return this.mode === 'press' ? this.longPressAt : null;
  }

  down(sample: TouchSample): TouchGesture[] {
    const out = this.tick(sample.time);
    if (this.contacts.has(sample.pointerId)) return out;
    this.contacts.set(sample.pointerId, {
      x: sample.x,
      y: sample.y,
      startX: sample.x,
      startY: sample.y
    });
    this.maxFingers = Math.max(this.maxFingers, this.contacts.size);
    switch (this.mode) {
      case 'idle':
        this.mode = 'press';
        this.primary = sample.pointerId;
        this.sequenceStart = sample.time;
        this.longPressAt = sample.time + this.options.longPressMs;
        this.maxFingers = 1;
        this.multiTapAllowed = true;
        break;
      case 'press':
        this.enterFingers();
        break;
      case 'drag':
        out.push(this.dragEvent('end', 0, 0));
        this.multiTapAllowed = false;
        this.enterFingers();
        break;
      case 'fingers':
        if (this.contacts.size > 3) this.multiTapAllowed = false;
        this.startSpread = this.lastSpread = this.spread();
        break;
      case 'pinch':
        out.push(this.pinchEvent('end'));
        this.mode = 'settling';
        break;
      case 'settling':
        break;
    }
    return out;
  }

  move(sample: TouchSample): TouchGesture[] {
    const out = this.tick(sample.time);
    const contact = this.contacts.get(sample.pointerId);
    // A lift or a repeated sample where the finger already is moves nothing.
    if (!contact || (contact.x === sample.x && contact.y === sample.y)) {
      return out;
    }
    contact.x = sample.x;
    contact.y = sample.y;
    const { slopPx } = this.options;
    const pastSlop =
      distance(contact.x, contact.y, contact.startX, contact.startY) > slopPx;
    if (pastSlop) this.multiTapAllowed = false;
    switch (this.mode) {
      case 'press':
        if (pastSlop) {
          this.mode = 'drag';
          this.lastDrag = { x: contact.startX, y: contact.startY };
          out.push(
            this.dragEvent('start', 0, 0, contact.startX, contact.startY)
          );
          out.push(this.dragMove(contact));
        }
        break;
      case 'drag':
        if (sample.pointerId === this.primary) out.push(this.dragMove(contact));
        break;
      case 'fingers': {
        // Only an unbroken pair navigates. Three fingers are a tap or
        // nothing, and a pair one of whose fingers has lifted is ending.
        if (this.contacts.size !== 2 || this.maxFingers !== 2) break;
        const spread = this.spread();
        const start = this.startSpread!;
        if (
          distance(spread.x, spread.y, start.x, start.y) > slopPx ||
          Math.abs(spread.distance - start.distance) > slopPx
        ) {
          this.multiTapAllowed = false;
          this.mode = 'pinch';
          this.lastSpread = start;
          out.push(this.pinchEvent('start'));
          out.push(this.pinchMove());
        }
        break;
      }
      case 'pinch':
        out.push(this.pinchMove());
        break;
      default:
        break;
    }
    return out;
  }

  up(sample: TouchSample): TouchGesture[] {
    const out = this.move(sample);
    if (!this.contacts.has(sample.pointerId)) return out;
    this.contacts.delete(sample.pointerId);
    switch (this.mode) {
      case 'press':
        out.push(this.tap(sample));
        break;
      case 'drag':
        out.push(this.dragEvent('end', 0, 0));
        break;
      case 'fingers':
        if (
          this.contacts.size === 0 &&
          this.multiTapAllowed &&
          (this.maxFingers === 2 || this.maxFingers === 3) &&
          sample.time - this.sequenceStart <= this.options.multiTapMs
        ) {
          out.push({ type: 'multi-tap', fingers: this.maxFingers });
        }
        break;
      case 'pinch':
        out.push(this.pinchEvent('end'));
        this.mode = 'settling';
        break;
      default:
        break;
    }
    if (this.contacts.size === 0) this.finish();
    return out;
  }

  /** The browser took the pointer (a system gesture, a palm, a scroll). */
  cancel(sample: TouchSample): TouchGesture[] {
    if (!this.contacts.has(sample.pointerId)) return [];
    this.contacts.delete(sample.pointerId);
    const out = this.abandon();
    if (this.contacts.size === 0) this.finish();
    return out;
  }

  /**
   * The host took this finger for its own drag (a handle under it): the
   * sequence yields nothing more, and further fingers are ignored until all
   * have lifted. A drag already reported is cancelled.
   */
  claim(pointerId: number): TouchGesture[] {
    if (!this.contacts.has(pointerId)) return [];
    return this.abandon();
  }

  /** Reports a long press once its deadline has passed. */
  tick(now: number): TouchGesture[] {
    if (this.mode !== 'press' || now < this.longPressAt) return [];
    const contact = this.contacts.get(this.primary!)!;
    this.mode = 'settling';
    this.lastTap = null;
    return [{ type: 'long-press', x: contact.x, y: contact.y }];
  }

  /** Drops every finger, cancelling what was in progress. */
  reset(): TouchGesture[] {
    const out = this.abandon();
    this.contacts.clear();
    this.finish();
    this.lastTap = null;
    return out;
  }

  private abandon(): TouchGesture[] {
    const out: TouchGesture[] = [];
    if (this.mode === 'drag') out.push(this.dragEvent('cancel', 0, 0));
    if (this.mode === 'pinch') out.push(this.pinchEvent('cancel'));
    if (this.mode !== 'idle') this.mode = 'settling';
    this.multiTapAllowed = false;
    // A press that was taken away is not the first half of a double tap.
    this.lastTap = null;
    return out;
  }

  private finish() {
    this.mode = 'idle';
    this.primary = null;
    this.maxFingers = 0;
    this.lastDrag = null;
    this.lastSpread = null;
    this.startSpread = null;
  }

  private enterFingers() {
    this.mode = 'fingers';
    this.startSpread = this.lastSpread = this.spread();
  }

  private tap(sample: TouchSample): TouchGesture {
    const previous = this.lastTap;
    if (
      previous &&
      sample.time - previous.time <= this.options.doubleTapMs &&
      distance(sample.x, sample.y, previous.x, previous.y) <=
        this.options.doubleTapSlopPx
    ) {
      this.lastTap = null;
      return { type: 'tap', x: sample.x, y: sample.y, count: 2 };
    }
    this.lastTap = { x: sample.x, y: sample.y, time: sample.time };
    return { type: 'tap', x: sample.x, y: sample.y, count: 1 };
  }

  private dragMove(contact: Contact): TouchGesture {
    const last = this.lastDrag!;
    const event = this.dragEvent(
      'move',
      contact.x - last.x,
      contact.y - last.y,
      contact.x,
      contact.y
    );
    this.lastDrag = { x: contact.x, y: contact.y };
    return event;
  }

  private dragEvent(
    phase: TouchPhase,
    dx: number,
    dy: number,
    x = this.lastDrag?.x ?? 0,
    y = this.lastDrag?.y ?? 0
  ): TouchGesture {
    return { type: 'drag', phase, x, y, dx, dy };
  }

  private pinchMove(): TouchGesture {
    const last = this.lastSpread!;
    const next = this.spread();
    const { minPinchSpreadPx } = this.options;
    const scale =
      last.distance >= minPinchSpreadPx && next.distance >= minPinchSpreadPx
        ? next.distance / last.distance
        : 1;
    this.lastSpread = next;
    return {
      type: 'pinch',
      phase: 'move',
      x: next.x,
      y: next.y,
      dx: next.x - last.x,
      dy: next.y - last.y,
      scale
    };
  }

  private pinchEvent(phase: TouchPhase): TouchGesture {
    const at = this.lastSpread ?? { x: 0, y: 0 };
    return { type: 'pinch', phase, x: at.x, y: at.y, dx: 0, dy: 0, scale: 1 };
  }

  /** Midpoint and spread of the first two fingers down. */
  private spread(): Spread {
    const [a, b] = [...this.contacts.values()];
    if (!a) return { x: 0, y: 0, distance: 0 };
    if (!b) return { x: a.x, y: a.y, distance: 0 };
    return {
      x: (a.x + b.x) / 2,
      y: (a.y + b.y) / 2,
      distance: distance(a.x, a.y, b.x, b.y)
    };
  }
}
