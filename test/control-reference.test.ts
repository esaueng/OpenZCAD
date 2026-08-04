import { describe, expect, it } from 'vitest';
import {
  CONTROL_REFERENCE_SEARCH_TERMS,
  KEYBOARD_CONTROL_GROUPS,
  POINTER_CONTROL_GROUPS,
  type ControlReferenceGroup,
  type ControlReferenceItem
} from '../apps/web/src/lib/controlReference';
import { visibleSettingsSections } from '../apps/web/src/lib/settingsSections';

function referenceItem(
  groups: readonly ControlReferenceGroup[],
  id: string
): ControlReferenceItem | undefined {
  for (const group of groups) {
    const item = group.items.find((candidate) => candidate.id === id);
    if (item) {
      return item;
    }
  }
  return undefined;
}

function keyboardItem(id: string) {
  return referenceItem(KEYBOARD_CONTROL_GROUPS, id);
}

function pointerItem(id: string) {
  return referenceItem(POINTER_CONTROL_GROUPS, id);
}

describe('controls reference', () => {
  it('covers the complete workspace tool shortcut map', () => {
    expect(
      KEYBOARD_CONTROL_GROUPS.find(
        (group) => group.id === 'modeling-tools'
      )?.items.map(({ keys, action }) => [keys[0], action])
    ).toEqual([
      ['B', 'Box'],
      ['C', 'Cylinder'],
      ['S', 'Sketch'],
      ['E', 'Extrude'],
      ['R', 'Revolve'],
      ['U', 'Union'],
      ['X', 'Subtract'],
      ['I', 'Intersect'],
      ['M', 'Move']
    ]);
  });

  it('documents context-specific keys and directional selection gestures', () => {
    expect(keyboardItem('sketch-circle')?.keys).toEqual(['C']);
    expect(keyboardItem('sketch-rectangle')?.keys).toEqual(['R']);
    expect(keyboardItem('sketch-text')?.keys).toEqual(['T']);
    expect(pointerItem('orbit')?.keys[0]).toContain('Shift');
    expect(pointerItem('window-select')?.keys).toEqual(['Drag left → right']);
    expect(pointerItem('window-select')?.detail).toContain('fully enclosed');
    expect(pointerItem('crossing-select')?.detail).toContain('touched');
    expect(pointerItem('middle-drag')?.detail).toContain('Viewport settings');
  });

  it('keeps every reference item id unique', () => {
    const ids = [...KEYBOARD_CONTROL_GROUPS, ...POINTER_CONTROL_GROUPS].flatMap(
      (group) => group.items.map((item) => item.id)
    );
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('makes detailed controls discoverable from settings search', () => {
    expect(CONTROL_REFERENCE_SEARCH_TERMS).toContain('Orbit');
    for (const query of [
      'orbit',
      'crossing select',
      'wireframe',
      'rectangle'
    ]) {
      expect(
        visibleSettingsSections({ assistantEnabled: true, query }).map(
          (section) => section.id
        )
      ).toContain('shortcuts');
    }
  });
});
