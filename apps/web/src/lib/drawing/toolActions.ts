import type { AnnotationToolKind } from './annotationPicking';
import {
  ANNOTATION_TOOL_KEYS,
  ANNOTATION_TOOLS,
  AUXILIARY_TOOL_KEY,
  DETAIL_TOOL_KEY,
  SECTION_TOOL_KEY
} from './toolKeys';

/**
 * Draw's 25 tools as actions (U12): the 22 annotation tools and the
 * section, detail and auxiliary view tools, each with the id the action
 * registry gives it and the key Draw answers to.
 *
 * Draw's letter keys, its toolbar, its compact tray and the command bar all
 * start a tool through one handler in `DrawingWorkspace`, which reports what
 * each tool can do now through a {@link DrawingToolBridge}. This module is
 * small on purpose: the workspace's command bar reads it without loading
 * Draw.
 */

export type DrawingViewTool = 'section' | 'detail' | 'auxiliary';

export type DrawingToolActionId =
  `drawing-${AnnotationToolKind}` | `drawing-${DrawingViewTool}-view`;

export type DrawingToolTarget =
  | { kind: 'annotation'; annotation: AnnotationToolKind }
  | { kind: 'view'; view: DrawingViewTool };

export interface DrawingToolAction {
  readonly id: DrawingToolActionId;
  /** What the toolbar's tooltip calls the tool. */
  readonly name: string;
  /**
   * Its command-bar row's name: its name, unless a Build tool already has
   * it (Build's Image inserts a reference picture into the model).
   */
  readonly searchName: string;
  readonly key: string;
  readonly tool: DrawingToolTarget;
}

/**
 * Each annotation tool's full name: a dimension says it is one, so the
 * command bar's "Chamfer dimension" is not taken for Build's Chamfer.
 */
export const ANNOTATION_TOOL_NAMES: Readonly<
  Record<AnnotationToolKind, string>
> = {
  horizontal: 'Horizontal dimension',
  vertical: 'Vertical dimension',
  aligned: 'Aligned dimension',
  distance: 'Distance dimension',
  radius: 'Radius dimension',
  diameter: 'Diameter dimension',
  angle: 'Angle dimension',
  'arc-angle': 'Arc angle dimension',
  'three-point-angle': '3-point angle dimension',
  chamfer: 'Chamfer dimension',
  note: 'Note',
  'center-mark': 'Centre mark',
  'intersection-mark': 'Intersection mark',
  centerline: 'Centreline',
  'circle-centerline': 'Circular centreline',
  balloon: 'Balloon',
  'parts-list': 'Parts list',
  'hole-table': 'Hole table',
  image: 'Image',
  'datum-feature': 'Datum feature',
  'feature-control-frame': 'Feature control frame',
  'general-tolerance': 'General tolerances'
};

/** Command-bar names that differ from the toolbar's, to stay distinct. */
const SEARCH_NAMES: Partial<Record<AnnotationToolKind, string>> = {
  image: 'Sheet image'
};

const VIEW_TOOLS: readonly (readonly [DrawingViewTool, string, string])[] = [
  ['section', 'Section view', SECTION_TOOL_KEY],
  ['detail', 'Detail view', DETAIL_TOOL_KEY],
  ['auxiliary', 'Auxiliary view', AUXILIARY_TOOL_KEY]
];

/** The toolbar's order: the annotation tools, then the view tools. */
export const DRAWING_TOOL_ACTIONS: readonly DrawingToolAction[] = [
  ...ANNOTATION_TOOLS.map((kind): DrawingToolAction => ({
    id: `drawing-${kind}`,
    name: ANNOTATION_TOOL_NAMES[kind],
    searchName: SEARCH_NAMES[kind] ?? ANNOTATION_TOOL_NAMES[kind],
    key: ANNOTATION_TOOL_KEYS[kind],
    tool: { kind: 'annotation', annotation: kind }
  })),
  ...VIEW_TOOLS.map(([view, name, key]): DrawingToolAction => ({
    id: `drawing-${view}-view`,
    name,
    searchName: name,
    key,
    tool: { kind: 'view', view }
  }))
];

const BY_ID = new Map(
  DRAWING_TOOL_ACTIONS.map((action) => [action.id, action])
);

export function drawingToolAction(
  id: DrawingToolActionId
): DrawingToolAction | undefined {
  return BY_ID.get(id);
}

/** The tool a key starts in Draw, matched without regard to case. */
export function drawingToolActionForKey(
  key: string
): DrawingToolAction | undefined {
  const wanted = key.toLowerCase();
  return DRAWING_TOOL_ACTIONS.find(
    (action) => action.key.toLowerCase() === wanted
  );
}

/** Why a Draw tool cannot start while no sheet is open. */
export const DRAWING_NO_SHEET_REASON = 'Add a sheet first.';

/** What a Draw tool can do now. */
export interface DrawingToolStatus {
  /** Why it cannot start now, or null. */
  readonly disabledReason: string | null;
  /** It is the running tool, so starting it again ends it. */
  readonly active: boolean;
}

/**
 * What Draw tells the workspace about its tools while it is open: each
 * tool's status, and the handler its key, toolbar and tray run.
 */
export interface DrawingToolBridge {
  readonly status: Readonly<Record<DrawingToolActionId, DrawingToolStatus>>;
  run(id: DrawingToolActionId): void;
}
