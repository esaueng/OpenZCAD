import type { DisplayMode } from '@openzcad/viewport';

/**
 * A sphere, drawn once and reused by every display-mode glyph so the three
 * modes differ only in what shading and which lines are present. A sphere,
 * not a cube: the cube was the Box tool's own icon, so the Display button
 * read as a second Box (I52).
 */
const CX = 12;
const CY = 12;
const R = 8.5;
/** The equator seen from a little above: its near half, then its far half. */
const EQUATOR_NEAR = 'M3.5 12A8.5 3 0 0 0 20.5 12';
const EQUATOR_FAR = 'M3.5 12A8.5 3 0 0 1 20.5 12';
/** One meridian, edge-on enough to read as a line round the back. */
const MERIDIAN = 'M12 3.5A3.2 8.5 0 0 0 12 20.5A3.2 8.5 0 0 0 12 3.5Z';

/** Fill per mode: the body, its lit side, and the highlight. */
const SHADING: Record<'shaded' | 'shaded-edges', [number, number, number]> = {
  shaded: [0.3, 0.45, 0.9],
  // Dimmer under `shaded-edges`, so the drawn lines stay the louder signal.
  'shaded-edges': [0.18, 0.28, 0.7]
};

interface DisplayModeIconProps {
  mode: DisplayMode;
  size?: number;
}

/**
 * Says which display mode is active by showing it: a lit ball for `shaded`,
 * the same ball with its outline and equator drawn for `shaded-edges`, and
 * a see-through ball of lines, its far side ghosted, for `wireframe`.
 */
export function DisplayModeIcon({ mode, size = 16 }: DisplayModeIconProps) {
  const shading = mode === 'wireframe' ? null : SHADING[mode];
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {shading && (
        <g fill="currentColor" stroke="none">
          <circle cx={CX} cy={CY} r={R} opacity={shading[0]} />
          <circle cx={10.4} cy={10.4} r={6} opacity={shading[1]} />
          <circle cx={9.2} cy={9.2} r={2} opacity={shading[2]} />
        </g>
      )}
      {mode === 'wireframe' && (
        <>
          <path d={EQUATOR_FAR} opacity={0.4} />
          <path d={MERIDIAN} />
        </>
      )}
      {mode !== 'shaded' && <path d={EQUATOR_NEAR} />}
      {mode !== 'shaded' && <circle cx={CX} cy={CY} r={R} />}
    </svg>
  );
}

/**
 * Axis triad, matching the arms on the orientation cube. Marks the control
 * that opens the standard-view list.
 */
export function AxisTriadIcon({ size = 16 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M9 15V3.5M9 15h11.5M9 15l-5.5 5.5" />
      <path d="M7 5.5 9 3.5l2 2M18.5 13l2 2-2 2" />
    </svg>
  );
}
