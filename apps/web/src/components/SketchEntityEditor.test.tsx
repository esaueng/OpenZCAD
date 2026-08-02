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
});
