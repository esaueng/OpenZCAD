export interface ControlReferenceItem {
  id: string;
  keys: readonly string[];
  action: string;
  detail: string;
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
 * references cannot quietly disagree as controls evolve.
 */
export const KEYBOARD_CONTROL_GROUPS = [
  {
    id: 'workspace',
    title: 'Workspace & history',
    description: 'Open global surfaces and manage the current revision.',
    items: [
      {
        id: 'open-settings',
        keys: ['Ctrl/Cmd+,'],
        action: 'Open Settings',
        detail: 'Available from the start screen or an open project.'
      },
      {
        id: 'command-palette',
        keys: ['Ctrl/Cmd+K', '/'],
        action: 'Open the command palette',
        detail: 'Search tools, views, file actions, and workspace commands.'
      },
      {
        id: 'save-revision',
        keys: ['Ctrl/Cmd+S'],
        action: 'Save a revision',
        detail: 'Saves the current canonical project document.'
      },
      {
        id: 'undo',
        keys: ['Ctrl/Cmd+Z'],
        action: 'Undo',
        detail: 'Steps backward through document history.'
      },
      {
        id: 'redo',
        keys: ['Ctrl/Cmd+Shift+Z', 'Ctrl/Cmd+Y'],
        action: 'Redo',
        detail: 'Restores the next document-history step.'
      },
      {
        id: 'shortcut-reference',
        keys: ['?'],
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
        keys: ['B'],
        action: 'Box',
        detail: 'Create a rectangular solid.'
      },
      {
        id: 'cylinder',
        keys: ['C'],
        action: 'Cylinder',
        detail: 'Create a circular solid.'
      },
      {
        id: 'sketch',
        keys: ['S'],
        action: 'Sketch',
        detail: 'Start a 2D profile on a plane.'
      },
      {
        id: 'extrude',
        keys: ['E'],
        action: 'Extrude',
        detail: 'Push a sketch profile into a solid.'
      },
      {
        id: 'revolve',
        keys: ['R'],
        action: 'Revolve',
        detail: 'Spin a sketch around an axis.'
      },
      {
        id: 'union',
        keys: ['U'],
        action: 'Union',
        detail: 'Merge selected bodies into one.'
      },
      {
        id: 'subtract',
        keys: ['X'],
        action: 'Subtract',
        detail: 'Cut selected bodies out of a base body.'
      },
      {
        id: 'intersect',
        keys: ['I'],
        action: 'Intersect',
        detail: 'Keep only the overlap between selected bodies.'
      },
      {
        id: 'move',
        keys: ['M'],
        action: 'Move',
        detail: 'Translate or rotate a body.'
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
        keys: ['1'],
        action: 'Front view',
        detail: 'Align the camera with the front of the model.'
      },
      {
        id: 'top-view',
        keys: ['2'],
        action: 'Top view',
        detail: 'Align the camera above the model.'
      },
      {
        id: 'right-view',
        keys: ['3'],
        action: 'Right view',
        detail: 'Align the camera with the right side.'
      },
      {
        id: 'isometric-view',
        keys: ['4'],
        action: 'Isometric view',
        detail: 'Return to the standard three-quarter view.'
      },
      {
        id: 'fit-view',
        keys: ['F'],
        action: 'Fit view',
        detail: 'Frame all visible model geometry.'
      },
      {
        id: 'normal-to-face',
        keys: ['Space'],
        action: 'Normal to selected face',
        detail: 'Centres and frames an exact planar face head-on.'
      },
      {
        id: 'toggle-grid',
        keys: ['G'],
        action: 'Toggle the grid',
        detail: 'Show or hide the construction grid.'
      },
      {
        id: 'display-mode',
        keys: ['W'],
        action: 'Cycle display mode',
        detail: 'Step through shaded + edges, shaded, and wireframe.'
      },
      {
        id: 'projection',
        keys: ['P'],
        action: 'Toggle projection',
        detail: 'Switch between perspective and orthographic projection.'
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
        keys: ['Q'],
        action: 'Cycle the selection filter',
        detail: 'Steps through Any, Body, Face, Edge, and Sketch.'
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
        keys: ['V'],
        action: 'Select',
        detail: 'Pick an existing sketch entity or profile.'
      },
      {
        id: 'sketch-line',
        keys: ['L'],
        action: 'Line',
        detail: 'Click to place a start point, then each next point.'
      },
      {
        id: 'sketch-arc',
        keys: ['A'],
        action: 'Arc',
        detail: 'Place the center, start, and end of the arc.'
      },
      {
        id: 'sketch-circle',
        keys: ['C'],
        action: 'Circle',
        detail: 'Drag from the center to set the radius.'
      },
      {
        id: 'sketch-rectangle',
        keys: ['R'],
        action: 'Rectangle',
        detail: 'Drag from one corner to the opposite corner.'
      },
      {
        id: 'sketch-text',
        keys: ['T'],
        action: 'Text',
        detail: 'Place editable text on the sketch plane.'
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
        action: 'Move through palette results',
        detail: 'Press Enter to run the highlighted command.'
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
        detail: 'Closes the palette, shortcut reference, or context menu.'
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
        detail: 'Pan, orbit, or zoom as chosen under Viewport settings.'
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
        action: 'Open the context menu',
        detail: 'Shows actions for the topology under the pointer.'
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
