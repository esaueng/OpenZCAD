import type { DisplayMode } from '@openzcad/viewport';

/**
 * Isometric unit cube, drawn once and reused by every display-mode glyph so
 * the three modes differ only in what shading and which edges are present.
 * The near and far corners of an isometric cube both land on the centre, so
 * `FRONT_EDGES` are the three edges meeting the near corner and `BACK_EDGES`
 * the three that are hidden behind the solid.
 */
const OUTLINE = 'M12 3 20.5 7.75V16.25L12 21 3.5 16.25V7.75Z';
const FRONT_EDGES = 'M12 12V21M12 12 3.5 7.75M12 12 20.5 7.75';
const BACK_EDGES = 'M12 12V3M12 12 3.5 16.25M12 12 20.5 16.25';
const FACE_TOP = 'M12 3 20.5 7.75 12 12 3.5 7.75Z';
const FACE_LEFT = 'M3.5 7.75 12 12 12 21 3.5 16.25Z';
const FACE_RIGHT = 'M20.5 7.75 12 12 12 21 20.5 16.25Z';

/** Face fills per mode. Lighter top, darker left reads as a lit solid. */
const FACE_OPACITY: Record<
  'shaded' | 'shaded-edges',
  [number, number, number]
> = {
  shaded: [0.85, 0.3, 0.55],
  // Dimmer under `shaded-edges`, so the drawn edges stay the louder signal.
  'shaded-edges': [0.55, 0.18, 0.34]
};

interface DisplayModeIconProps {
  mode: DisplayMode;
  size?: number;
}

/**
 * Says which display mode is active by showing it: a lit solid for `shaded`,
 * a lit solid with its edges drawn for `shaded-edges`, and an all-edges cube
 * with its hidden edges ghosted for `wireframe`.
 */
export function DisplayModeIcon({ mode, size = 15 }: DisplayModeIconProps) {
  const faces = mode === 'wireframe' ? null : FACE_OPACITY[mode];
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
      {faces && (
        <g fill="currentColor" stroke="none">
          <path d={FACE_TOP} opacity={faces[0]} />
          <path d={FACE_LEFT} opacity={faces[1]} />
          <path d={FACE_RIGHT} opacity={faces[2]} />
        </g>
      )}
      {mode === 'wireframe' && <path d={BACK_EDGES} opacity={0.4} />}
      {mode !== 'shaded' && <path d={FRONT_EDGES} />}
      {mode !== 'shaded' && <path d={OUTLINE} />}
    </svg>
  );
}

/**
 * Axis triad, matching the arms on the orientation cube. Marks the control
 * that opens the standard-view list.
 */
export function AxisTriadIcon({ size = 15 }: { size?: number }) {
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
