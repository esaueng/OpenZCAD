import { SPACE_MOUSE_BUTTON } from '@openzcad/viewport/space-mouse';
import type { ControlReferenceGroup } from './controlReference';
import type { SpaceMouseButtonEvent } from './spaceMouse';

/**
 * What each SpaceMouse key does. The device's own Shift turns a view key to
 * its opposite and the roll key back the other way, as 3Dconnexion's
 * driver does; Esc, Shift, Ctrl and Alt act as those keyboard keys.
 */
export type SpaceMouseAction =
  | { kind: 'menu' }
  | { kind: 'fit' }
  | {
      kind: 'view';
      view: 'top' | 'bottom' | 'right' | 'left' | 'front' | 'back' | 'iso';
    }
  | { kind: 'roll'; direction: 1 | -1 }
  | { kind: 'normal-to-face' }
  | { kind: 'projection' }
  | { kind: 'display' }
  | { kind: 'rotation-lock' }
  | {
      kind: 'key';
      key: EmulatedKey;
      pressed: boolean;
    };

export type EmulatedKey = 'Escape' | 'Shift' | 'Control' | 'Alt';

const KEY_BUTTONS: ReadonlyMap<number, EmulatedKey> = new Map([
  [SPACE_MOUSE_BUTTON.escape, 'Escape'],
  [SPACE_MOUSE_BUTTON.shift, 'Shift'],
  [SPACE_MOUSE_BUTTON.control, 'Control'],
  [SPACE_MOUSE_BUTTON.alt, 'Alt']
]);

/** The action a key change asks for, or null when it asks for none. */
export function spaceMouseAction(
  event: SpaceMouseButtonEvent
): SpaceMouseAction | null {
  const key = KEY_BUTTONS.get(event.button);
  if (key) {
    return { kind: 'key', key, pressed: event.pressed };
  }
  // Everything else acts once, on the way down.
  if (!event.pressed) {
    return null;
  }
  const opposite = event.shift;
  switch (event.button) {
    case SPACE_MOUSE_BUTTON.menu:
      return { kind: 'menu' };
    case SPACE_MOUSE_BUTTON.fit:
      return { kind: 'fit' };
    case SPACE_MOUSE_BUTTON.top:
      return { kind: 'view', view: opposite ? 'bottom' : 'top' };
    case SPACE_MOUSE_BUTTON.right:
      return { kind: 'view', view: opposite ? 'left' : 'right' };
    case SPACE_MOUSE_BUTTON.front:
      return { kind: 'view', view: opposite ? 'back' : 'front' };
    case SPACE_MOUSE_BUTTON.rollClockwise:
      return { kind: 'roll', direction: opposite ? -1 : 1 };
    case SPACE_MOUSE_BUTTON.one:
      return { kind: 'view', view: 'iso' };
    case SPACE_MOUSE_BUTTON.two:
      return { kind: 'normal-to-face' };
    case SPACE_MOUSE_BUTTON.three:
      return { kind: 'projection' };
    case SPACE_MOUSE_BUTTON.four:
      return { kind: 'display' };
    case SPACE_MOUSE_BUTTON.rotationLock:
      return { kind: 'rotation-lock' };
    default:
      return null;
  }
}

/** The key reference Settings shows, in the SpaceMouse Pro's own words. */
export const SPACE_MOUSE_KEY_REFERENCE: ControlReferenceGroup = {
  id: 'space-mouse',
  title: 'SpaceMouse keys',
  description: 'What each key on a 3Dconnexion SpaceMouse Pro does.',
  items: [
    {
      id: 'cap',
      keys: ['Cap'],
      action: 'Move the view',
      detail:
        'Push, pull and lift to pan and zoom; tilt, spin and roll to turn the model about its pivot.'
    },
    {
      id: 'menu',
      keys: ['Menu'],
      action: 'Open these settings',
      detail: 'Settings › Controls, where this reference lives.'
    },
    {
      id: 'fit',
      keys: ['Fit'],
      action: 'Fit the model in view',
      detail: 'The same as the Fit view command.'
    },
    {
      id: 'views',
      keys: ['T', 'R', 'F'],
      action: 'Top, right and front views',
      detail: 'Hold the SpaceMouse Shift key for bottom, left and back.'
    },
    {
      id: 'roll',
      keys: ['Roll'],
      action: 'Roll a quarter turn',
      detail: 'Clockwise; hold the SpaceMouse Shift key to roll back.'
    },
    {
      id: 'iso',
      keys: ['1'],
      action: 'Isometric view',
      detail: 'The same view as the ISO command.'
    },
    {
      id: 'normal',
      keys: ['2'],
      action: 'Normal to the selected face',
      detail: 'Select a planar face first.'
    },
    {
      id: 'projection',
      keys: ['3'],
      action: 'Perspective or orthographic',
      detail: 'Switches the projection.'
    },
    {
      id: 'display',
      keys: ['4'],
      action: 'Next display mode',
      detail: 'Shaded, shaded with edges, wireframe and the rest in turn.'
    },
    {
      id: 'lock',
      keys: ['Lock'],
      action: 'Lock rotation',
      detail: 'The cap pans and zooms only until Lock is pressed again.'
    },
    {
      id: 'modifiers',
      keys: ['Esc', 'Shift', 'Ctrl', 'Alt'],
      action: 'Those keyboard keys',
      detail:
        'Esc cancels as the keyboard key does. Clicks still read only the keyboard’s own modifiers.'
    }
  ]
};

const KEY_CODES: Record<EmulatedKey, string> = {
  Escape: 'Escape',
  Shift: 'ShiftLeft',
  Control: 'ControlLeft',
  Alt: 'AltLeft'
};

/**
 * Plays a device key as the keyboard key it stands for, at the focused
 * element so it reaches the same listeners a real key would. Pointer events
 * still carry only the keyboard's own modifiers: the browser sets those.
 */
export function dispatchEmulatedKey(
  key: EmulatedKey,
  pressed: boolean,
  target: EventTarget = document.activeElement ?? document.body
) {
  target.dispatchEvent(
    new KeyboardEvent(pressed ? 'keydown' : 'keyup', {
      key,
      code: KEY_CODES[key],
      bubbles: true,
      cancelable: true,
      composed: true,
      shiftKey: key === 'Shift' && pressed,
      ctrlKey: key === 'Control' && pressed,
      altKey: key === 'Alt' && pressed
    })
  );
}
