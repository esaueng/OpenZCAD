import { describe, expect, it } from 'vitest';
import type { SelectionCalloutVerb } from './selectionCallout';
import {
  faceVerbMenuItems,
  selectOtherMenuItem,
  withFaceVerbs,
  type ViewportMenuState
} from './viewportMenu';

const verb = (
  id: SelectionCalloutVerb['id'],
  label: string,
  disabled: false | string = false
): SelectionCalloutVerb => ({
  id,
  label,
  title: disabled || label,
  disabled: disabled !== false,
  pressed: false
});

const VERBS = [
  verb('action:offset-face', 'Offset'),
  verb('action:sketch-on-face', 'Sketch'),
  verb('tool:hole', 'Hole', 'Waiting for exact geometry')
];

const face = { bodyId: 'body-1', topologyId: 'face-7', hash: 7 };

function menu(withSelectOther: boolean): ViewportMenuState {
  return {
    x: 0,
    y: 0,
    heading: 'Bracket · Top face',
    face,
    items: [
      ...(withSelectOther ? [selectOtherMenuItem(2)] : []),
      { id: 'move', label: 'Move / Rotate…' },
      { id: 'hide', label: 'Hide body', section: true }
    ]
  };
}

describe('viewport menu (I18, I19)', () => {
  it('names Select other with the count and marks it as opening a list', () => {
    expect(selectOtherMenuItem(3)).toEqual({
      id: 'select-other',
      label: 'Select other',
      detail: '3 under the pointer',
      shortcut: 'Alt+↓',
      submenu: true
    });
  });

  it('gives face verbs menu names, and a disabled verb its reason', () => {
    expect(faceVerbMenuItems(VERBS)).toEqual([
      { id: 'verb:action:offset-face', label: 'Push/pull face' },
      { id: 'verb:action:sketch-on-face', label: 'Sketch on face' },
      {
        id: 'verb:tool:hole',
        label: 'Hole…',
        disabled: true,
        detail: 'Waiting for exact geometry'
      }
    ]);
  });

  it('puts the face’s verbs after Select other and before the body actions', () => {
    const shown = withFaceVerbs(menu(true), face, VERBS, {
      disabledReason: null,
      shortcut: 'Space'
    });
    expect(shown).not.toHaveProperty('face');
    expect(shown.items.map((item) => [item.id, item.section ?? false])).toEqual(
      [
        ['select-other', false],
        ['verb:action:offset-face', true],
        ['verb:action:sketch-on-face', false],
        ['verb:tool:hole', false],
        ['look-at-face', false],
        ['move', true],
        ['hide', true]
      ]
    );
    expect(shown.items.find((item) => item.id === 'look-at-face')).toEqual({
      id: 'look-at-face',
      label: 'Look at face',
      shortcut: 'Space'
    });
  });

  it('leads with the face’s verbs when nothing is stacked, and says why Look at face is off', () => {
    const shown = withFaceVerbs(menu(false), face, VERBS, {
      disabledReason: 'The face is not flat'
    });
    expect(shown.items[0]?.id).toBe('verb:action:offset-face');
    expect(shown.items[0]?.section).toBeUndefined();
    expect(shown.items.find((item) => item.id === 'look-at-face')).toEqual({
      id: 'look-at-face',
      label: 'Look at face',
      disabled: true,
      detail: 'The face is not flat'
    });
  });

  it('draws body actions only while another face, or none, is selected', () => {
    const other = { ...face, topologyId: 'face-8', hash: 8 };
    for (const selected of [other, null]) {
      const shown = withFaceVerbs(menu(true), selected, VERBS, {
        disabledReason: null
      });
      expect(shown.items.map((item) => item.id)).toEqual([
        'select-other',
        'move',
        'hide'
      ]);
    }
    // Matched by hash when the selection carries no topology id.
    const byHash = withFaceVerbs(
      menu(false),
      { bodyId: 'body-1', hash: 7 },
      VERBS,
      { disabledReason: null }
    );
    expect(byHash.items).toHaveLength(6);
  });
});
