import type { AnnotationToolKind } from './annotationPicking';

/**
 * Draw's tools and their single-letter keys, shared by the drawing toolbar
 * and the action registry (U12). The keys are live while Draw is open and
 * focus is not in a field; they are not in the remappable keymap.
 */

/** The annotation toolbar's order. */
export const ANNOTATION_TOOLS: readonly AnnotationToolKind[] = [
  'horizontal',
  'vertical',
  'aligned',
  'distance',
  'radius',
  'diameter',
  'angle',
  'arc-angle',
  'three-point-angle',
  'chamfer',
  'note',
  'center-mark',
  'intersection-mark',
  'centerline',
  'circle-centerline',
  'balloon',
  'parts-list',
  'hole-table',
  'image',
  'datum-feature',
  'feature-control-frame',
  'general-tolerance'
];

/** One key per tool, live while Draw is open and focus is not in a field. */
export const ANNOTATION_TOOL_KEYS: Readonly<
  Record<AnnotationToolKind, string>
> = {
  horizontal: 'H',
  vertical: 'V',
  aligned: 'A',
  distance: 'T',
  radius: 'R',
  diameter: 'D',
  angle: 'G',
  'arc-angle': 'E',
  'three-point-angle': 'J',
  chamfer: 'C',
  note: 'N',
  'center-mark': 'M',
  'intersection-mark': 'X',
  centerline: 'L',
  'circle-centerline': 'B',
  balloon: 'O',
  'parts-list': 'P',
  'hole-table': 'Y',
  image: 'I',
  'datum-feature': 'Q',
  'feature-control-frame': 'F',
  'general-tolerance': 'W'
};

/** D03: the section view tool's key, beside the annotation tools'. */
export const SECTION_TOOL_KEY = 'S';
/** D03 (v78): the detail view tool's key. */
export const DETAIL_TOOL_KEY = 'K';
/** D03 (v81): the auxiliary view tool's key. */
export const AUXILIARY_TOOL_KEY = 'U';
