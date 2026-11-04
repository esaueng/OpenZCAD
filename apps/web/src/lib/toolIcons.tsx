import type { ReactNode } from 'react';

/**
 * Glyphs for the modeling operations the icon set has no word for, drawn on
 * its 24px grid with its 2px round stroke so they sit among the stock icons
 * unnoticed. Each draws the operation's result rather than a metaphor: an
 * extrude is a profile with its rise, a shell an open cup, a pattern its
 * copies. None reuses another surface's glyph — the viewer's grid and
 * section, a panel's layers, the sketch's spline — since two buttons with one
 * picture read as one command.
 */
function glyph(children: ReactNode) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={16}
      height={16}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

const DASH = '2 3';

/** A ball: its outline and equator, so it reads as round, not as the web. */
export const sphereGlyph = glyph(
  <>
    <circle cx="12" cy="12" r="9" />
    <path d="M3 12c0 1.7 4 3 9 3s9-1.3 9-3" />
    <path d="M3 12c0-1.7 4-3 9-3s9 1.3 9 3" strokeDasharray={DASH} />
  </>
);

/** A plane in perspective, the way a datum plane is drawn in the view. */
export const planeGlyph = glyph(
  <path d="M7 6h14l-4 12H3z" strokeDasharray="3 2.5" />
);

/** A flat profile lying down, and its rise. */
export const extrudeGlyph = glyph(
  <>
    <path d="M3 19l4-3h14l-4 3z" />
    <path d="M12 14V3" />
    <path d="m8.5 6.5 3.5-3.5 3.5 3.5" />
  </>
);

/** A profile beside its axis, turning about it. */
export const revolveGlyph = glyph(
  <>
    <path d="M12 2v20" strokeDasharray={DASH} />
    <path d="M14 7h4v6h-4" />
    <path d="M19.5 16.5c-1.4 1.5-4.4 2.5-7.5 2.5-4.4 0-8-1.6-8-3.5 0-1 1-2 2.7-2.6" />
    <path d="m4.8 11.2 2 1.8-2.4 1.3" />
  </>
);

/** Two different sections joined by a skin. */
export const loftGlyph = glyph(
  <>
    <ellipse cx="12" cy="18.5" rx="8" ry="2.5" />
    <path d="M9 3h6v4H9z" />
    <path d="M4 18.5 9 7" />
    <path d="M20 18.5 15 7" />
  </>
);

/** A profile carried along a path. */
export const sweepGlyph = glyph(
  <>
    <circle cx="6" cy="18" r="3" />
    <path d="M8.6 16.5C11 11 14.5 7.5 21 5" />
    <path d="M14 18.5c2-2 4-6 7-8" strokeDasharray={DASH} />
  </>
);

/** A coil about its axis. */
export const helicalSweepGlyph = glyph(
  <>
    <path d="M6 4c0 1.4 12 1.6 12 3.3S6 9.3 6 11s12 1.6 12 3.3-12 2-12 3.7 12 1.6 12 2" />
  </>
);

/** A block's corner cut flat. */
export const chamferGlyph = glyph(
  <>
    <path d="M4 20V10l6-6h10v16z" />
    <path d="M4 10h6V4" strokeDasharray={DASH} />
  </>
);

/** Teeth cut along a rim: a rack, so it is not mistaken for a whole gear. */
export const gearTeethGlyph = glyph(
  <>
    <path d="M3 20h18" />
    <path d="M4 20v-4l1.5-3h2L9 16v4" />
    <path d="M10.5 20v-4l1-3h1l1 3v4" />
    <path d="M15 20v-4l1.5-3h2l1.5 3v4" />
  </>
);

/** A boss in profile with its thread's slanted crests. */
export const threadGlyph = glyph(
  <>
    <path d="M7 3v18M17 3v18" />
    <path d="M7 6l10-2M7 11l10-2M7 16l10-2M7 21l10-2" />
  </>
);

/** A solid hollowed to an open cup. */
export const shellGlyph = glyph(
  <>
    <path d="M4 5v14a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1V5" />
    <path d="M8 5v11h8V5" />
  </>
);

/** A tapered wall beside the upright it leans from. */
export const draftGlyph = glyph(
  <>
    <path d="M5 20h14" />
    <path d="M7 20 10 4h4l3 16" />
    <path d="M7 4v16" strokeDasharray={DASH} />
  </>
);

/** A curved surface given a thickness. */
export const thickenGlyph = glyph(
  <>
    <path d="M3 9c4-3.5 14-3.5 18 0" />
    <path d="M3 16c4-3.5 14-3.5 18 0" />
    <path d="M3 9v7" />
    <path d="M21 9v7" />
  </>
);

/** A body and the offset of its whole outline. */
export const solidOffsetGlyph = glyph(
  <>
    <rect x="8" y="8" width="8" height="8" rx="1" />
    <rect x="3" y="3" width="18" height="18" rx="4" strokeDasharray={DASH} />
  </>
);

/** A body with the plane that cuts it in two. */
export const splitGlyph = glyph(
  <>
    <path d="M5 5h14v14H5z" />
    <path d="M2 15 22 9" strokeDasharray={DASH} />
  </>
);

/** Copies in a row. */
export const linearPatternGlyph = glyph(
  <>
    <rect x="2" y="9" width="5" height="6" rx="1" />
    <rect x="9.5" y="9" width="5" height="6" rx="1" />
    <rect x="17" y="9" width="5" height="6" rx="1" />
  </>
);

/** Copies about a centre. */
export const circularPatternGlyph = glyph(
  <>
    <circle cx="12" cy="12" r="1" />
    <circle cx="12" cy="4" r="2" />
    <circle cx="19" cy="16" r="2" />
    <circle cx="5" cy="16" r="2" />
    <path d="M12 12 12 6.5" strokeDasharray="1 2.5" />
  </>
);

/** Copies in rows and columns, spaced apart: not the viewer's grid. */
export const gridPatternGlyph = glyph(
  <>
    <rect x="3" y="3" width="6" height="6" rx="1" />
    <rect x="15" y="3" width="6" height="6" rx="1" />
    <rect x="3" y="15" width="6" height="6" rx="1" />
    <rect x="15" y="15" width="6" height="6" rx="1" />
  </>
);
