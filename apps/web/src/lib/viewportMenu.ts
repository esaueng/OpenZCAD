import type {
  ContextMenuItem,
  ContextMenuState
} from '../components/ContextMenu';
import type { SelectionCalloutVerb } from './selectionCallout';

/**
 * The viewport's selection menu beyond its body actions (design review
 * I18, I19).
 *
 * A right-click on a face used to offer only what acts on the whole body:
 * Move, the booleans, Hide, Isolate. The face's own verbs, the ones the
 * verb rail shows for that pick (Sketch, Offset, Hole, Shell…), now lead
 * the menu, with Look at face beside them. They are read from the rail's
 * list as the workspace renders it, so the two can never disagree.
 */

/** Menu item ids for the face's verbs carry this prefix. */
export const FACE_VERB_PREFIX = 'verb:';
export const SELECT_OTHER_ITEM_ID = 'select-other';
export const LOOK_AT_FACE_ITEM_ID = 'look-at-face';

/** The face a selection menu was opened for, which its verbs must match. */
export interface ViewportMenuFace {
  bodyId: string;
  topologyId?: string | undefined;
  hash?: number | undefined;
}

/** One face, by its id where both sides have one, else by its hash. */
function sameFace(a: ViewportMenuFace, b: ViewportMenuFace): boolean {
  if (a.bodyId !== b.bodyId) return false;
  if (a.topologyId !== undefined && b.topologyId !== undefined) {
    return a.topologyId === b.topologyId;
  }
  return a.hash !== undefined && a.hash === b.hash;
}

export interface ViewportMenuState extends ContextMenuState {
  /** Set on a face's menu: its verbs go in before the body actions. */
  face?: ViewportMenuFace;
}

/** The menu's own names, where the rail's one word would be too terse. */
const MENU_LABELS: Partial<Record<SelectionCalloutVerb['id'], string>> = {
  'action:sketch-on-face': 'Sketch on face',
  'tool:sketch': 'Sketch on face',
  'action:offset-face': 'Push/pull face',
  'action:resize-body': 'Resize body',
  'action:resize-radial-face': 'Change radius',
  'tool:datum-plane': 'Plane from face…',
  'tool:datum-axis': 'Axis from face…'
};

/** First in a menu over stacked targets: the list of everything there. */
export function selectOtherMenuItem(count: number): ContextMenuItem {
  return {
    id: SELECT_OTHER_ITEM_ID,
    label: 'Select other',
    detail: `${count} under the pointer`,
    shortcut: 'Alt+↓',
    submenu: true
  };
}

/**
 * The face's rail verbs as menu items. A disabled one says why on its second
 * line, as every disabled menu item should, instead of only greying out.
 */
export function faceVerbMenuItems(
  verbs: readonly SelectionCalloutVerb[]
): ContextMenuItem[] {
  return verbs.map((verb) => {
    const label =
      MENU_LABELS[verb.id] ??
      (verb.id.startsWith('tool:') ? `${verb.label}…` : verb.label);
    return {
      id: `${FACE_VERB_PREFIX}${verb.id}`,
      label,
      ...(verb.disabled ? { disabled: true, detail: verb.title } : {})
    };
  });
}

/**
 * The menu as drawn: a face's menu takes its verbs and Look at face after
 * Select other, while the face is still the one selected. Until then (or
 * once it is not) the menu is drawn as stored, body actions only.
 */
export function withFaceVerbs(
  menu: ViewportMenuState,
  selected: ViewportMenuFace | null,
  verbs: readonly SelectionCalloutVerb[] | null,
  lookAtFace: { disabledReason: string | null; shortcut?: string | undefined }
): ContextMenuState {
  const { face, ...shown } = menu;
  if (!face || !selected || !verbs || !sameFace(face, selected)) {
    return shown;
  }
  const faceItems: ContextMenuItem[] = [
    ...faceVerbMenuItems(verbs),
    {
      id: LOOK_AT_FACE_ITEM_ID,
      label: 'Look at face',
      ...(lookAtFace.shortcut ? { shortcut: lookAtFace.shortcut } : {}),
      ...(lookAtFace.disabledReason
        ? { disabled: true, detail: lookAtFace.disabledReason }
        : {})
    }
  ];
  const leading = shown.items[0]?.id === SELECT_OTHER_ITEM_ID ? 1 : 0;
  const rest = shown.items.slice(leading);
  return {
    ...shown,
    items: [
      ...shown.items.slice(0, leading),
      ...faceItems.map((item, index) =>
        index === 0 && leading ? { ...item, section: true } : item
      ),
      ...rest.map((item, index) =>
        index === 0 ? { ...item, section: true } : item
      )
    ]
  };
}
