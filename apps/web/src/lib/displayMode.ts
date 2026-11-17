import type { DisplayMode } from '@openzcad/viewport/types';

export const DISPLAY_MODE_LABELS: Record<DisplayMode, string> = {
  'shaded-edges': 'Shaded + edges',
  shaded: 'Shaded',
  wireframe: 'Wireframe'
};

/** The display modes in the order W cycles them, and the Display menu lists them. */
export const DISPLAY_MODE_ORDER: readonly DisplayMode[] = [
  'shaded-edges',
  'shaded',
  'wireframe'
];
