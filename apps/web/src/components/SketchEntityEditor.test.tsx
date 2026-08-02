/**
 * What an entity edit is allowed to change, and what it must leave alone.
 *
 * The editor exposes numeric fields per object kind. Everything it does not
 * expose has to survive an Apply — `construction` on any kind, and a text
 * object's string, family and style, none of which are expression fields.
 * Rebuilding a fresh object literal per kind silently dropped them.
 */
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { SketchObjectData } from '@openzcad/shared';
import { SketchEntityEditor } from './SketchEntityEditor';
import { styleFromToggles } from './TextObjectFields';
import { textObjectFromPoint } from '../lib/sketch/session';

const TEXT_OBJECT: SketchObjectData = {
  objectKind: 'text',
  text: 'Text',
  fontFamily: 'open-sans',
  fontStyle: 'regular',
  size: 10,
  x: 0,
  y: 0
};

async function applyEdit(
  data: SketchObjectData,
  label: string,
  value: string
): Promise<SketchObjectData> {
  const onApply = vi.fn();
  const user = userEvent.setup();
  render(
    <SketchEntityEditor
      data={data}
      scope={{}}
      onApply={onApply}
      onDelete={vi.fn()}
      onClose={vi.fn()}
    />
  );
  const field = screen.getByLabelText(label);
  await user.clear(field);
  await user.type(field, value);
  await user.click(screen.getByRole('button', { name: /apply/i }));
  expect(onApply).toHaveBeenCalledTimes(1);
  return onApply.mock.calls[0]![0] as SketchObjectData;
}

describe('SketchEntityEditor', () => {
  it('keeps a circle construction after its radius is edited', async () => {
    const applied = await applyEdit(
      {
        objectKind: 'circle',
        radius: 5,
        centerX: 0,
        centerY: 0,
        construction: true
      },
      'Radius',
      '8'
    );
    expect(applied).toEqual({
      objectKind: 'circle',
      radius: 8,
      centerX: 0,
      centerY: 0,
      construction: true
    });
  });

  it('keeps a rectangle construction after its width is edited', async () => {
    const applied = await applyEdit(
      {
        objectKind: 'rectangle',
        width: 10,
        height: 4,
        centerX: 0,
        centerY: 0,
        construction: true
      },
      'Width',
      '20'
    );
    expect(applied).toMatchObject({ width: 20, construction: true });
  });

  it("carries a text object's string, family and style through a resize", async () => {
    const applied = await applyEdit(
      {
        objectKind: 'text',
        text: 'HELLO',
        fontFamily: 'lora',
        fontStyle: 'bold',
        size: 10,
        x: 1,
        y: 2,
        align: 'center'
      },
      'Size',
      '25'
    );
    expect(applied).toEqual({
      objectKind: 'text',
      text: 'HELLO',
      fontFamily: 'lora',
      fontStyle: 'bold',
      size: 25,
      x: 1,
      y: 2,
      align: 'center'
    });
  });

  // The reason the feature exists: place text, then change what it says and
  // how big it is without deleting and redrawing anything.
  it('edits the string itself, not only the numbers around it', async () => {
    const onApply = vi.fn();
    const user = userEvent.setup();
    render(
      <SketchEntityEditor
        data={TEXT_OBJECT}
        scope={{}}
        onApply={onApply}
        onDelete={vi.fn()}
        onClose={vi.fn()}
      />
    );
    const field = screen.getByLabelText('Text');
    await user.clear(field);
    await user.type(field, 'OpenZCAD');
    await user.click(screen.getByRole('button', { name: /apply/i }));
    expect(onApply.mock.calls[0]![0]).toMatchObject({
      text: 'OpenZCAD',
      // Untouched fields survive the edit.
      fontFamily: 'open-sans',
      size: 10
    });
  });

  it('toggles bold and italic into a real style, not a synthetic one', async () => {
    const onApply = vi.fn();
    const user = userEvent.setup();
    render(
      <SketchEntityEditor
        data={TEXT_OBJECT}
        scope={{}}
        onApply={onApply}
        onDelete={vi.fn()}
        onClose={vi.fn()}
      />
    );
    const bold = screen.getByRole('button', { name: 'B' });
    const italic = screen.getByRole('button', { name: 'I' });
    expect(bold).toHaveAttribute('aria-pressed', 'false');

    await user.click(bold);
    await user.click(italic);
    await user.click(screen.getByRole('button', { name: /apply/i }));
    // Two independent toggles collapse onto the one bundled face that carries
    // both, because there is no synthetic bold or italic to fall back on.
    expect(onApply.mock.calls[0]![0]).toMatchObject({
      fontStyle: 'boldItalic'
    });
  });

  it('is the same editor whether the string or the size changed', () => {
    render(
      <SketchEntityEditor
        data={TEXT_OBJECT}
        scope={{}}
        onApply={vi.fn()}
        onDelete={vi.fn()}
        onClose={vi.fn()}
      />
    );
    // One panel owns every parameter of a text object. If these ever split
    // across two places, "change the text" and "change its size" stop being
    // the same gesture.
    expect(screen.getByLabelText('Text')).toBeTruthy();
    expect(screen.getByLabelText('Font')).toBeTruthy();
    expect(screen.getByLabelText('Size')).toBeTruthy();
    expect(screen.getByRole('group', { name: 'Font style' })).toBeTruthy();
  });
});

describe('styleFromToggles', () => {
  it('maps both toggles onto the four bundled faces', () => {
    expect(styleFromToggles(false, false)).toBe('regular');
    expect(styleFromToggles(true, false)).toBe('bold');
    expect(styleFromToggles(false, true)).toBe('italic');
    expect(styleFromToggles(true, true)).toBe('boldItalic');
  });
});

describe('textObjectFromPoint', () => {
  it('places a ready-to-edit object at the click, with no drag extent', () => {
    const object = textObjectFromPoint({ x: 3, y: -4 });
    expect(object).toMatchObject({
      objectKind: 'text',
      x: 3,
      y: -4,
      fontStyle: 'regular'
    });
    // A placeholder string and a real size, so the object is visible and
    // selectable the instant it lands rather than being a zero-extent nothing.
    expect(object.objectKind === 'text' && object.text.length).toBeGreaterThan(
      0
    );
    expect(object.objectKind === 'text' && object.size).toBeGreaterThan(0);
  });
});
