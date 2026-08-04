/**
 * Glyph outline → closed loops of exact line / quadratic / cubic segments.
 *
 * `glyph.path.commands` are font-unit, y-up coordinates (it is `getPath()`
 * that flips y for screen space, not the raw command list). Every point is
 * produced once by the glyph's transform closure and then shared by reference
 * with the neighbouring segment, so a loop's joints are bit-identical doubles
 * on both sides. Recomputing a joint from two code paths is the one thing that
 * reliably breaks `makeWire`, which welds at 1e-7.
 */
import { makeLoop, point } from './loops';
import type { GlyphTransform } from './layout';
import type { Glyph, PathCommand } from 'opentype.js';
import type { TextLoop, TextPoint, TextSegment } from './types';

/**
 * How far apart a contour's last point and its first point may be before a
 * closing line is inserted instead of snapping, as a fraction of the em size.
 * Font contours close exactly; this only guards against damaged outlines.
 */
const CLOSE_SNAP_RATIO = 1e-9;

function samePoint(a: TextPoint, b: TextPoint): boolean {
  return a.x === b.x && a.y === b.y;
}

function distance(a: TextPoint, b: TextPoint): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** Rewrites a segment's end point without touching anything else. */
function retarget(segment: TextSegment, end: TextPoint): TextSegment {
  if (segment.kind === 'line') {
    return { kind: 'line', a: segment.a, b: end };
  }
  if (segment.kind === 'quadratic') {
    return {
      kind: 'quadratic',
      a: segment.a,
      control: segment.control,
      b: end
    };
  }
  return {
    kind: 'cubic',
    a: segment.a,
    control1: segment.control1,
    control2: segment.control2,
    b: end
  };
}

/**
 * A curve is degenerate only when it truly collapses. A quadratic whose
 * endpoints coincide but whose control point does not is a cusp with real
 * enclosed area, and dropping it would change the glyph.
 */
function isDegenerate(segment: TextSegment): boolean {
  if (segment.kind === 'line') {
    return samePoint(segment.a, segment.b);
  }
  if (segment.kind === 'quadratic') {
    return (
      samePoint(segment.a, segment.b) && samePoint(segment.a, segment.control)
    );
  }
  return (
    samePoint(segment.a, segment.b) &&
    samePoint(segment.a, segment.control1) &&
    samePoint(segment.a, segment.control2)
  );
}

class ContourBuilder {
  private readonly loops: TextLoop[] = [];
  private segments: TextSegment[] = [];
  private start: TextPoint | null = null;
  private current: TextPoint | null = null;

  constructor(private readonly snapTolerance: number) {}

  moveTo(next: TextPoint): void {
    this.close();
    this.start = next;
    this.current = next;
  }

  add(segment: TextSegment): void {
    if (isDegenerate(segment)) {
      return;
    }
    this.segments.push(segment);
    this.current = segment.b;
  }

  get pen(): TextPoint | null {
    return this.current;
  }

  close(): void {
    const start = this.start;
    const current = this.current;
    if (!start || !current) {
      this.reset();
      return;
    }
    if (this.segments.length === 0) {
      this.reset();
      return;
    }
    if (!samePoint(current, start)) {
      const last = this.segments[this.segments.length - 1]!;
      if (distance(current, start) <= this.snapTolerance) {
        // Snap: the closing joint becomes the very same object as the
        // opening one, so the loop closes on identical doubles.
        this.segments[this.segments.length - 1] = retarget(last, start);
      } else {
        this.segments.push({ kind: 'line', a: current, b: start });
      }
    } else if (current !== start) {
      // Numerically identical but a different object — collapse to one
      // object so downstream identity checks and hashing stay stable.
      const last = this.segments[this.segments.length - 1]!;
      this.segments[this.segments.length - 1] = retarget(last, start);
    }
    if (this.segments.length > 0) {
      this.loops.push(makeLoop(this.segments));
    }
    this.reset();
  }

  private reset(): void {
    this.segments = [];
    this.start = null;
    this.current = null;
  }

  finish(): TextLoop[] {
    this.close();
    return this.loops;
  }
}

/**
 * Extracts one glyph's closed loops in sketch-plane coordinates.
 *
 * Loops keep the orientation the font gave them; normalization to outer-CCW /
 * hole-CW happens after nesting is known, in `nesting.ts`.
 */
export function glyphLoops(
  glyph: Glyph,
  transform: GlyphTransform,
  emSize: number
): TextLoop[] {
  const builder = new ContourBuilder(emSize * CLOSE_SNAP_RATIO);
  const at = (gx: number, gy: number): TextPoint => {
    const mapped = transform(gx, gy);
    return point(mapped.x, mapped.y);
  };
  const commands: readonly PathCommand[] = glyph.path.commands;
  for (const command of commands) {
    switch (command.type) {
      case 'M':
        builder.moveTo(at(command.x, command.y));
        break;
      case 'L': {
        const from = builder.pen;
        if (from) {
          builder.add({ kind: 'line', a: from, b: at(command.x, command.y) });
        }
        break;
      }
      case 'Q': {
        const from = builder.pen;
        if (from) {
          builder.add({
            kind: 'quadratic',
            a: from,
            control: at(command.x1, command.y1),
            b: at(command.x, command.y)
          });
        }
        break;
      }
      case 'C': {
        const from = builder.pen;
        if (from) {
          builder.add({
            kind: 'cubic',
            a: from,
            control1: at(command.x1, command.y1),
            control2: at(command.x2, command.y2),
            b: at(command.x, command.y)
          });
        }
        break;
      }
      case 'Z':
        builder.close();
        break;
    }
  }
  return builder.finish();
}
