import {
  pickedEnough,
  type AnnotationTool,
  type AnnotationToolKind
} from './annotationPicking';

/**
 * Draw in the compact workspace (U12 slice 9): the annotation tools in five
 * icon groups, each with one word under its icon, and the running tool's
 * step as a short chip in the tray. The tools, their accessible names and
 * what they do are the drawing workspace's own; only the grouping and the
 * words are compact.
 */

export interface CompactAnnotationGroup {
  id: 'dimensions' | 'marks' | 'notes' | 'tables' | 'tolerances';
  label: string;
  tools: readonly AnnotationToolKind[];
}

/** Every annotation tool, once, in five groups. */
export const COMPACT_ANNOTATION_GROUPS: readonly CompactAnnotationGroup[] = [
  {
    id: 'dimensions',
    label: 'Dimensions',
    tools: [
      'horizontal',
      'vertical',
      'aligned',
      'distance',
      'radius',
      'diameter',
      'chamfer',
      'angle',
      'arc-angle',
      'three-point-angle'
    ]
  },
  {
    id: 'marks',
    label: 'Symbols and marks',
    tools: [
      'center-mark',
      'intersection-mark',
      'centerline',
      'circle-centerline'
    ]
  },
  {
    id: 'notes',
    label: 'Notes and balloons',
    tools: ['note', 'balloon', 'image']
  },
  { id: 'tables', label: 'Tables', tools: ['parts-list', 'hole-table'] },
  {
    id: 'tolerances',
    label: 'Tolerances',
    tools: ['datum-feature', 'feature-control-frame', 'general-tolerance']
  }
];

/** One word under each tool's icon; its accessible name stays its label. */
export const COMPACT_ANNOTATION_WORDS: Readonly<
  Record<AnnotationToolKind, string>
> = {
  horizontal: 'Horizontal',
  vertical: 'Vertical',
  aligned: 'Aligned',
  distance: 'Distance',
  radius: 'Radius',
  diameter: 'Diameter',
  chamfer: 'Chamfer',
  angle: 'Angle',
  'arc-angle': 'Arc',
  'three-point-angle': '3-point',
  'center-mark': 'Centre',
  'intersection-mark': 'Cross',
  centerline: 'Axis',
  'circle-centerline': 'Circular',
  note: 'Note',
  balloon: 'Balloon',
  image: 'Image',
  'parts-list': 'Parts',
  'hole-table': 'Holes',
  'datum-feature': 'Datum',
  'feature-control-frame': 'Frame',
  'general-tolerance': 'General'
};

/**
 * What a running annotation tool asks for next, as a chip of a word or two
 * ("Point 2", "Place"). The full sentence (`annotationToolHint`) stays the
 * tool's status for assistive technology.
 */
export function annotationToolStep(tool: AnnotationTool): string {
  if (pickedEnough(tool)) return tool.repairId ? 'Done' : 'Place';
  switch (tool.kind) {
    case 'horizontal':
    case 'vertical':
    case 'aligned':
      if (tool.faces.length === 1) return 'Face 2';
      return tool.points.length === 0 ? 'Point 1' : 'Point 2';
    case 'radius':
    case 'diameter':
    case 'center-mark':
      return 'Circle';
    case 'angle':
    case 'intersection-mark':
      return tool.edges.length === 0 ? 'Edge 1' : 'Edge 2';
    case 'arc-angle':
      return 'Arc';
    case 'three-point-angle':
      return tool.points.length === 0
        ? 'Vertex'
        : tool.points.length === 1
          ? 'Arm 1'
          : 'Arm 2';
    case 'chamfer':
      return 'Outline';
    case 'note':
      return 'Leader';
    case 'distance':
      return (tool.targets ?? []).length === 0 ? 'From' : 'To';
    case 'centerline':
      return tool.points.length === 1 || tool.edges.length === 1
        ? 'Second'
        : 'First';
    case 'circle-centerline':
      return `Point ${tool.points.length + 1}`;
    case 'balloon':
    case 'datum-feature':
    case 'feature-control-frame':
      return 'Edge';
    case 'hole-table':
      return tool.viewId ? 'Place' : 'View';
    case 'parts-list':
    case 'image':
    case 'general-tolerance':
      return 'Place';
  }
}

/** A view tool's step: its first pick, then where the view goes. */
export function viewToolStep(
  kind: 'section' | 'detail' | 'auxiliary',
  state: { picked: boolean; freeSection?: boolean }
): string {
  if (!state.picked) {
    return kind === 'section' ? 'Line' : kind === 'detail' ? 'Circle' : 'Edge';
  }
  return kind === 'section' && state.freeSection ? 'Side' : 'Place';
}
