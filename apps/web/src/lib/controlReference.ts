import {
  KEYMAP_COMMANDS,
  keymapCommand,
  referenceKeyLabel,
  type Keymap
} from './keymap';

export interface ControlReferenceItem {
  id: string;
  /** The default keys, as the reference writes them. */
  keys: readonly string[];
  /**
   * The keymap commands behind a remappable item, whose live keys replace
   * `keys` wherever the reference is drawn (`liveControlKeys`).
   */
  commands?: readonly string[];
  action: string;
  detail: string;
}

/** A remappable item: its commands and their default keys. */
function bound(...commands: string[]) {
  return {
    commands,
    keys: commands.flatMap((id) =>
      (keymapCommand(id)?.defaults ?? []).map(referenceKeyLabel)
    )
  };
}

export interface ControlReferenceGroup {
  id: string;
  title: string;
  description: string;
  items: readonly ControlReferenceItem[];
}

/**
 * Workspace key map, grouped by the context that owns each shortcut.
 *
 * Settings and the in-workspace `?` overlay render this same data so the two
 * references cannot quietly disagree as controls evolve. A remappable item's
 * keys come from the keymap registry, and both surfaces draw the user's live
 * binding in their place.
 */
export const KEYBOARD_CONTROL_GROUPS = [
  {
    id: 'workspace',
    title: 'Workspace & history',
    description: 'Open global surfaces and manage the current revision.',
    items: [
      {
        id: 'open-settings',
        ...bound('app-settings'),
        action: 'Open settings',
        detail: 'Available from the start screen or an open project.'
      },
      {
        id: 'command-palette',
        ...bound('command-palette', 'command-slash'),
        action: 'Focus the command bar',
        detail:
          'Search tools, views, file actions, and workspace commands, or ask the assistant.'
      },
      {
        id: 'save-revision',
        ...bound('file-save'),
        action: 'Save a revision',
        detail: 'Saves the current canonical project document.'
      },
      {
        id: 'undo',
        ...bound('edit-undo'),
        action: 'Undo',
        detail: 'Steps backward through document history.'
      },
      {
        id: 'redo',
        ...bound('edit-redo'),
        action: 'Redo',
        detail: 'Restores the next document-history step.'
      },
      {
        id: 'shortcut-reference',
        ...bound('shortcut-reference'),
        action: 'Open the shortcut reference',
        detail: 'Shows this keyboard map without leaving the workspace.'
      }
    ]
  },
  {
    id: 'modeling-tools',
    title: 'Modeling tools',
    description: 'Launch the most common creation and modification tools.',
    items: [
      {
        id: 'box',
        ...bound('tool-box'),
        action: 'Box',
        detail: 'Create a rectangular solid.'
      },
      {
        id: 'cylinder',
        ...bound('tool-cylinder'),
        action: 'Cylinder',
        detail: 'Create a circular solid.'
      },
      {
        id: 'sketch',
        ...bound('tool-sketch'),
        action: 'Sketch',
        detail: 'Start a 2D profile on a plane.'
      },
      {
        id: 'extrude',
        ...bound('tool-extrude'),
        action: 'Extrude',
        detail: 'Push a sketch profile into a solid.'
      },
      {
        id: 'revolve',
        ...bound('tool-revolve'),
        action: 'Revolve',
        detail: 'Spin a sketch around an axis.'
      },
      {
        id: 'union',
        ...bound('tool-union'),
        action: 'Union',
        detail: 'Merge selected bodies into one.'
      },
      {
        id: 'subtract',
        ...bound('tool-subtract'),
        action: 'Subtract',
        detail: 'Cut selected bodies out of a base body.'
      },
      {
        id: 'intersect',
        ...bound('tool-intersect'),
        action: 'Intersect',
        detail: 'Keep only the overlap between selected bodies.'
      },
      {
        id: 'move',
        ...bound('tool-transform'),
        action: 'Move',
        detail: 'Translate or rotate a body. Build mode; in View, M measures.'
      }
    ]
  },
  {
    id: 'view-display',
    title: 'View & display',
    description: 'Frame the model and change how the viewport renders it.',
    items: [
      {
        id: 'front-view',
        ...bound('view-front'),
        action: 'Front view',
        detail: 'Align the camera with the front of the model.'
      },
      {
        id: 'top-view',
        ...bound('view-top'),
        action: 'Top view',
        detail: 'Align the camera above the model.'
      },
      {
        id: 'right-view',
        ...bound('view-right'),
        action: 'Right view',
        detail: 'Align the camera with the right side.'
      },
      {
        id: 'isometric-view',
        ...bound('view-iso'),
        action: 'Isometric view',
        detail: 'Return to the standard three-quarter view.'
      },
      {
        id: 'back-view',
        ...bound('view-back'),
        action: 'Back view',
        detail: 'Align the camera with the back of the model.'
      },
      {
        id: 'bottom-view',
        ...bound('view-bottom'),
        action: 'Bottom view',
        detail: 'Align the camera below the model.'
      },
      {
        id: 'left-view',
        ...bound('view-left'),
        action: 'Left view',
        detail: 'Align the camera with the left side.'
      },
      {
        id: 'fit-view',
        ...bound('view-fit'),
        action: 'Fit view',
        detail: 'Frame all visible model geometry.'
      },
      {
        id: 'normal-to-face',
        ...bound('view-normal-to-face'),
        action: 'Normal to selected face',
        detail: 'Centres and frames an exact planar face head-on.'
      },
      {
        id: 'toggle-grid',
        ...bound('view-grid'),
        action: 'Toggle the grid',
        detail: 'Show or hide the construction grid.'
      },
      {
        id: 'display-mode',
        ...bound('view-display'),
        action: 'Cycle display mode',
        detail: 'Step through shaded + edges, shaded, and wireframe.'
      },
      {
        id: 'projection',
        ...bound('view-projection'),
        action: 'Toggle projection',
        detail: 'Switch between perspective and orthographic projection.'
      },
      {
        id: 'xray',
        ...bound('view-xray'),
        action: 'Toggle X-ray',
        detail:
          'See through faces to hidden edges, and pick or box-select through them.'
      },
      {
        id: 'hide-panels',
        ...bound('panels-hide-all'),
        action: 'Hide or show the model panels',
        detail:
          'Keeps the layout. The rest is under View options on the panel rail.'
      }
    ]
  },
  {
    id: 'view-mode',
    title: 'View mode',
    description:
      'Read a model without being able to change it. M and Move share a key without colliding, because each is only live in one mode.',
    items: [
      {
        id: 'workspace-mode',
        ...bound('workspace-mode-cycle'),
        action: 'Cycle View, Tweak and Build',
        detail:
          'A shared project you can only read stays in View, and says why.'
      },
      {
        id: 'measure',
        ...bound('view-measure'),
        action: 'Measure',
        detail:
          'In View mode only. Records what you pick; Escape stops recording and keeps the results.'
      },
      {
        id: 'measure-delete',
        keys: ['Delete'],
        action: 'Delete the selected measurement',
        detail: 'In View mode, where there is no feature to delete instead.'
      }
    ]
  },
  {
    id: 'selection-editing',
    title: 'Selection & editing',
    description: 'Control what can be selected and step out of active work.',
    items: [
      {
        id: 'selection-filter',
        ...bound('selection-filter'),
        action: 'Cycle the selection filter',
        detail: 'Steps through Any, Body, Face, Edge, and Sketch.'
      },
      {
        id: 'select-other-list',
        keys: ['Alt+↓'],
        action: 'List stacked targets',
        detail:
          'Opens the ordered targets under the last viewport pointer without advancing click cycling.'
      },
      {
        id: 'delete-selection',
        keys: ['Delete', 'Backspace'],
        action: 'Delete the current selection',
        detail: 'Deletes a selected feature or sketch entity when supported.'
      },
      {
        id: 'escape-ladder',
        keys: ['Esc'],
        action: 'Step back or cancel',
        detail: 'Cancels the innermost drag, tool, panel, or selection first.'
      }
    ]
  },
  {
    id: 'sketch-mode',
    title: 'Sketch mode',
    description: 'These keys take over while editing a sketch.',
    items: [
      {
        id: 'sketch-select',
        ...bound('sketch-select'),
        action: 'Select',
        detail: 'Pick an existing sketch entity or profile.'
      },
      {
        id: 'sketch-line',
        ...bound('sketch-line'),
        action: 'Line',
        detail: 'Click to place a start point, then each next point.'
      },
      {
        id: 'sketch-arc',
        ...bound('sketch-arc'),
        action: 'Arc',
        detail: 'Place the center, start, and end of the arc.'
      },
      {
        id: 'sketch-circle',
        ...bound('sketch-circle'),
        action: 'Circle',
        detail: 'Drag from the center to set the radius.'
      },
      {
        id: 'sketch-rectangle',
        ...bound('sketch-rectangle'),
        action: 'Rectangle',
        detail:
          'Drag corner to corner; again steps to the center and three-point types.'
      },
      {
        id: 'sketch-polygon',
        ...bound('sketch-polygon'),
        action: 'Polygon',
        detail: 'Drag from the center to a vertex; the strip sets the sides.'
      },
      {
        id: 'sketch-ellipse',
        ...bound('sketch-ellipse'),
        action: 'Ellipse',
        detail:
          'Place the center, an axis end, then the other radius; again steps to an elliptical arc.'
      },
      {
        id: 'sketch-spline',
        ...bound('sketch-spline'),
        action: 'Spline',
        detail:
          'Click its points and press Enter; again steps between fit and control-point splines.'
      },
      {
        id: 'sketch-text',
        ...bound('sketch-text'),
        action: 'Text',
        detail: 'Place editable text on the sketch plane.'
      },
      {
        id: 'sketch-project',
        ...bound('sketch-project'),
        action: 'Project edges',
        detail:
          'Click a model edge, or a face for its whole boundary, to project it into the sketch; again steps between linked and unlinked.'
      },
      {
        id: 'sketch-constraints',
        keys: ['—'],
        action: 'Constraints (Horizontal, Vertical, Parallel, …)',
        detail:
          'No shortcut: pick a rail button (Horizontal, Vertical, Parallel, Perpendicular, Equal, Tangent, Concentric, Coincident, Midpoint, Radius, Distance, Angle) after drawing an entity.'
      }
    ]
  },
  {
    id: 'forms-dialogs',
    title: 'Forms & dialogs',
    description: 'Confirm work and navigate temporary UI surfaces.',
    items: [
      {
        id: 'confirm-form',
        keys: ['Enter'],
        action: 'Confirm the current form',
        detail: 'Creates or applies an enabled feature form or active preview.'
      },
      {
        id: 'palette-navigation',
        keys: ['↑', '↓'],
        action: 'Move through command bar results',
        detail:
          'Press Enter to run the highlighted command, or Tab to complete its name.'
      },
      {
        id: 'dialog-focus',
        keys: ['Tab', 'Shift+Tab'],
        action: 'Move between dialog controls',
        detail: 'Focus stays inside modal dialogs until they close.'
      },
      {
        id: 'close-dialog',
        keys: ['Esc'],
        action: 'Close the active dialog',
        detail: 'Closes the command bar, shortcut reference, or context menu.'
      }
    ]
  }
] as const satisfies readonly ControlReferenceGroup[];

/** Pointer gestures are documented separately because many are directional. */
export const POINTER_CONTROL_GROUPS = [
  {
    id: 'viewport-navigation',
    title: 'Viewport navigation',
    description: 'Move the camera without changing the project document.',
    items: [
      {
        id: 'orbit',
        keys: ['Shift + left-drag'],
        action: 'Orbit',
        detail: 'Rotate around the most recently selected point.'
      },
      {
        id: 'middle-drag',
        keys: ['Middle-drag'],
        action: 'Use the configured navigation action',
        detail: 'Pan, orbit, or zoom as chosen under Navigation, above.'
      },
      {
        id: 'right-pan',
        keys: ['Right-drag'],
        action: 'Pan',
        detail: 'Move the camera target across the viewport.'
      },
      {
        id: 'wheel-zoom',
        keys: ['Wheel'],
        action: 'Zoom',
        detail: 'Zooms toward the pointer when that preference is enabled.'
      },
      {
        id: 'double-click-fit',
        keys: ['Double-click'],
        action: 'Fit from empty viewport',
        detail: 'Frames visible geometry when no topology is under the pointer.'
      }
    ]
  },
  {
    id: 'pointer-selection',
    title: 'Selection',
    description: 'Pick precise topology or select bodies by screen region.',
    items: [
      {
        id: 'select',
        keys: ['Click'],
        action: 'Select under the pointer',
        detail: 'Also moves the orbit pivot to the picked point.'
      },
      {
        id: 'depth-cycle',
        keys: ['Click again'],
        action: 'Cycle stacked targets',
        detail: 'Repeated clicks at the same point step through deeper hits.'
      },
      {
        id: 'add-selection',
        keys: ['Shift + click'],
        action: 'Toggle in the selection',
        detail: 'Adds an unselected item or removes a selected item.'
      },
      {
        id: 'window-select',
        keys: ['Drag left → right'],
        action: 'Window select',
        detail: 'Selects bodies fully enclosed by the selection box.'
      },
      {
        id: 'crossing-select',
        keys: ['Drag right → left'],
        action: 'Crossing select',
        detail: 'Selects bodies touched by the selection box.'
      },
      {
        id: 'edge-run',
        keys: ['Double-click edge'],
        action: 'Select the connected edge run',
        detail: 'Expands a picked edge to its smooth connected chain.'
      },
      {
        id: 'select-owning-body',
        keys: ['Double-click topology'],
        action: 'Select the owning body',
        detail: 'Promotes a face or isolated edge selection to its full body.'
      }
    ]
  },
  {
    id: 'direct-modeling',
    title: 'Context & direct modeling',
    description: 'Reach local actions and adjust geometry in the viewport.',
    items: [
      {
        id: 'context-menu',
        keys: ['Right-click'],
        action: 'Select other or open the context menu',
        detail:
          'Lists stacked topology under the pointer; a single target opens its actions.'
      },
      {
        id: 'drag-handle',
        keys: ['Drag handle'],
        action: 'Preview a direct edit',
        detail: 'Move, resize, offset, extrude, fillet, or chamfer live.'
      },
      {
        id: 'fine-drag',
        keys: ['Hold Shift during handle drag'],
        action: 'Use fine or unsnapped movement',
        detail:
          'Start the move, offset, radius, or edge drag before holding Shift.'
      },
      {
        id: 'exact-entry',
        keys: ['Click value chip'],
        action: 'Enter an exact value',
        detail: 'Opens numeric entry for the active direct-edit handle.'
      },
      {
        id: 'cancel-drag',
        keys: ['Esc'],
        action: 'Cancel the current manipulation',
        detail: 'Restores the value from before the active drag.'
      }
    ]
  }
] as const satisfies readonly ControlReferenceGroup[];

export const CONTROL_REFERENCE_SEARCH_TERMS = [
  ...KEYBOARD_CONTROL_GROUPS,
  ...POINTER_CONTROL_GROUPS
].flatMap((group) => [
  group.title,
  group.description,
  ...group.items.flatMap((item) => [...item.keys, item.action, item.detail])
]);

/** An item's keys as the user has them bound; empty when they unbound it. */
export function liveControlKeys(
  item: ControlReferenceItem,
  keymap: Keymap
): readonly string[] {
  return item.commands
    ? item.commands.flatMap((id) => keymap.bindings(id).map(referenceKeyLabel))
    : item.keys;
}

/**
 * The keyboard reference as the user's keymap has it. A tool the user gave a
 * key joins the modeling-tools list, which otherwise names only the tools
 * that ship with one.
 */
export function liveKeyboardGroups(
  keymap: Keymap
): readonly ControlReferenceGroup[] {
  return KEYBOARD_CONTROL_GROUPS.map((group) => {
    const items: ControlReferenceItem[] = group.items.map((item) => ({
      ...item,
      keys: liveControlKeys(item, keymap)
    }));
    if (group.id === 'modeling-tools') {
      const listed = new Set(
        group.items.flatMap((item): readonly string[] => item.commands)
      );
      for (const command of KEYMAP_COMMANDS) {
        if (
          command.group === 'modeling-tools' &&
          !listed.has(command.id) &&
          keymap.bindings(command.id).length > 0
        ) {
          items.push({
            id: command.id,
            keys: keymap.bindings(command.id).map(referenceKeyLabel),
            commands: [command.id],
            action: command.label,
            detail: 'A key you assigned in Settings.'
          });
        }
      }
    }
    return { ...group, items };
  });
}
