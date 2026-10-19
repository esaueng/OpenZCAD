/**
 * What an entity edit is allowed to change, and what it must leave alone.
 *
 * The editor exposes numeric fields per object kind. Everything it does not
 * expose has to survive an Apply — `construction` on any kind, and a text
 * object's string, family and style, none of which are expression fields.
 * Rebuilding a fresh object literal per kind silently dropped them.
 */
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { SketchObjectData } from '@openzcad/shared';
import { SketchEntityEditor } from './SketchEntityEditor';
import { styleFromToggles } from './TextObjectFields';
import { newSketchTextDraft } from '../lib/interaction/machine';
import { textObjectFromPoint } from '../lib/sketch/textPlacement';

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
  it('shows dragged coordinates at working precision and writes back the exact ones untouched', async () => {
    const onApply = vi.fn();
    const user = userEvent.setup();
    render(
      <SketchEntityEditor
        data={{
          objectKind: 'rectangle',
          width: 41.808471716162806,
          height: 26.130294953253244,
          centerX: 20.904235858081403,
          centerY: 13.065147476626622
        }}
        scope={{}}
        onApply={onApply}
        onDelete={vi.fn()}
        onClose={vi.fn()}
      />
    );
    expect(screen.getByLabelText('Width')).toHaveValue('41.808');
    expect(screen.getByLabelText('Center Y')).toHaveValue('13.065');
    const width = screen.getByLabelText('Width');
    await user.clear(width);
    await user.type(width, '80');
    await user.click(screen.getByRole('button', { name: /apply/i }));
    expect(onApply).toHaveBeenCalledTimes(1);
    // The edited field takes the typed value; the fields left alone keep
    // the document's exact doubles rather than their rounded display.
    expect(onApply.mock.calls[0]![0]).toMatchObject({
      width: 80,
      height: 26.130294953253244,
      centerX: 20.904235858081403,
      centerY: 13.065147476626622
    });
  });

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
      'Size (em)',
      '25'
    );
    expect(applied).toEqual({
      objectKind: 'text',
      text: 'HELLO',
      fontFamily: 'lora',
      fontStyle: 'bold',
      size: 25,
      // The editor exposes rotation, so it writes one. An object created
      // before the field existed carries none, and an apply normalises it to
      // the 0 it was already behaving as.
      rotation: 0,
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
    const bold = screen.getByRole('button', { name: 'Bold' });
    const italic = screen.getByRole('button', { name: 'Italic' });
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
    expect(screen.getByLabelText('Size (em)')).toBeTruthy();
    expect(screen.getByRole('group', { name: 'Font style' })).toBeTruthy();
  });

  it('refuses polygon side counts above the render budget', async () => {
    const onApply = vi.fn();
    const user = userEvent.setup();
    render(
      <SketchEntityEditor
        data={{
          objectKind: 'polygon',
          sides: 6,
          radius: 10,
          centerX: 0,
          centerY: 0
        }}
        scope={{}}
        onApply={onApply}
        onDelete={vi.fn()}
        onClose={vi.fn()}
      />
    );

    const sides = screen.getByLabelText('Sides');
    await user.clear(sides);
    await user.type(sides, '65');
    expect(screen.getByRole('alert')).toHaveTextContent('3 to 64');
    expect(screen.getByRole('button', { name: /apply/i })).toBeDisabled();
    expect(onApply).not.toHaveBeenCalled();
  });

  it('refuses a multi-turn arc sweep', async () => {
    const onApply = vi.fn();
    const user = userEvent.setup();
    render(
      <SketchEntityEditor
        data={{
          objectKind: 'arc',
          centerX: 0,
          centerY: 0,
          radius: 10,
          startAngleDeg: 0,
          endAngleDeg: 90
        }}
        scope={{}}
        onApply={onApply}
        onDelete={vi.fn()}
        onClose={vi.fn()}
      />
    );

    const end = screen.getByLabelText('End angle');
    await user.clear(end);
    await user.type(end, '720');
    expect(screen.getByRole('alert')).toHaveTextContent('360 degrees');
    expect(screen.getByRole('button', { name: /apply/i })).toBeDisabled();
    expect(onApply).not.toHaveBeenCalled();
  });
});

describe('text placement and movement', () => {
  // Reported from the deployed build: "it just adds the text 'Text', I can't
  // modify the text at all". Rotation was in the data model and honoured by
  // the layout, but the editor never exposed it, so text could not be turned
  // to sit on the face being sketched.
  it('offers rotation and position, not only size', () => {
    render(
      <SketchEntityEditor
        data={TEXT_OBJECT}
        scope={{}}
        onApply={vi.fn()}
        onDelete={vi.fn()}
        onClose={vi.fn()}
      />
    );
    expect(screen.getByLabelText('Rotation')).toBeTruthy();
    expect(screen.getByLabelText('X')).toBeTruthy();
    expect(screen.getByLabelText('Y')).toBeTruthy();
  });

  it('defaults rotation to 0 on an object that predates the field', async () => {
    // `rotation` is optional, so every text object created before it existed
    // carries no value. An empty expression input is invalid, which would
    // disable Apply on an object the user had not even touched.
    const applied = await applyEdit(TEXT_OBJECT, 'X', '12');
    expect(applied).toMatchObject({ x: 12, rotation: 0 });
  });

  it('rotates without disturbing the string or the placement', async () => {
    const applied = await applyEdit(
      { ...TEXT_OBJECT, text: 'HELLO', x: 5, y: 7 },
      'Rotation',
      '45'
    );
    expect(applied).toMatchObject({
      rotation: 45,
      text: 'HELLO',
      x: 5,
      y: 7
    });
  });
});

describe('one owner while the canvas moves the object', () => {
  // A handle drag commits through the same path as Apply, so the editor stays
  // mounted and rebases onto the stored object: the newest write wins per
  // field, and nothing typed but not yet applied is thrown away.
  function renderEditor(data: SketchObjectData, onApply = vi.fn()) {
    const props = {
      scope: {},
      onApply,
      onDelete: vi.fn(),
      onClose: vi.fn()
    };
    const view = render(<SketchEntityEditor data={data} {...props} />);
    return {
      onApply,
      moveTo: (next: SketchObjectData) =>
        view.rerender(<SketchEntityEditor data={next} {...props} />)
    };
  }

  it('keeps a typed string through a drag and applies both', async () => {
    const user = userEvent.setup();
    const placed = { ...TEXT_OBJECT, text: 'Boa', x: 5, y: 7 };
    const { onApply, moveTo } = renderEditor(placed);
    const field = screen.getByLabelText('Text', { exact: true });
    await user.clear(field);
    await user.type(field, 'Bob');

    // The drag lands: the stored origin and turn change, the string does not.
    moveTo({ ...placed, x: 12.25, y: -3, rotation: 30 });
    expect(screen.getByLabelText('Text', { exact: true })).toHaveValue('Bob');
    expect(screen.getByLabelText('X')).toHaveValue('12.25');
    expect(screen.getByLabelText('Y')).toHaveValue('-3');
    expect(screen.getByLabelText('Rotation')).toHaveValue('30');

    await user.click(screen.getByRole('button', { name: /apply/i }));
    expect(onApply).toHaveBeenCalledTimes(1);
    expect(onApply.mock.calls[0]![0]).toMatchObject({
      text: 'Bob',
      x: 12.25,
      y: -3,
      rotation: 30
    });
  });

  it('shows the stored value for a field the canvas wrote, even if typed', async () => {
    const user = userEvent.setup();
    const placed = { ...TEXT_OBJECT, x: 5, y: 7 };
    const { moveTo } = renderEditor(placed);
    const x = screen.getByLabelText('X');
    await user.clear(x);
    await user.type(x, '40');
    const size = screen.getByLabelText('Size (em)');
    await user.clear(size);
    await user.type(size, '14');

    // The drag is the newer write to X; Size was not touched by it.
    moveTo({ ...placed, x: 9, y: 7 });
    expect(screen.getByLabelText('X')).toHaveValue('9');
    expect(screen.getByLabelText('Size (em)')).toHaveValue('14');
  });

  it('follows a style change made elsewhere and keeps untouched fields exact', async () => {
    const user = userEvent.setup();
    const placed = { ...TEXT_OBJECT, x: 20.904235858081403, y: 7 };
    const { onApply, moveTo } = renderEditor(placed);
    moveTo({ ...placed, fontStyle: 'bold', y: 8 });
    expect(screen.getByRole('button', { name: 'Bold' })).toHaveAttribute(
      'aria-pressed',
      'true'
    );
    await user.click(screen.getByRole('button', { name: /apply/i }));
    // X was never typed in, so the exact double goes back, not its display.
    expect(onApply.mock.calls[0]![0]).toMatchObject({
      fontStyle: 'bold',
      x: 20.904235858081403,
      y: 8
    });
  });
});

describe('text alignment in the editor', () => {
  // The text card sets alignment before placement; once placed, the editor
  // owns the object, so alignment has to be editable here too.
  async function applyAlignment(
    data: SketchObjectData,
    pick: string | null
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
    if (pick) {
      await user.click(screen.getByRole('radio', { name: pick }));
    }
    await user.click(screen.getByRole('button', { name: /apply/i }));
    return onApply.mock.calls[0]![0] as SketchObjectData;
  }

  it('shows the stored alignment, and left for an object without one', () => {
    const { unmount } = render(
      <SketchEntityEditor
        data={{ ...TEXT_OBJECT, align: 'right' }}
        scope={{}}
        onApply={vi.fn()}
        onDelete={vi.fn()}
        onClose={vi.fn()}
      />
    );
    expect(screen.getByRole('radio', { name: 'Align right' })).toHaveAttribute(
      'aria-checked',
      'true'
    );
    unmount();
    render(
      <SketchEntityEditor
        data={TEXT_OBJECT}
        scope={{}}
        onApply={vi.fn()}
        onDelete={vi.fn()}
        onClose={vi.fn()}
      />
    );
    expect(screen.getByRole('radio', { name: 'Align left' })).toHaveAttribute(
      'aria-checked',
      'true'
    );
  });

  it('applies a picked alignment', async () => {
    const applied = await applyAlignment(
      { ...TEXT_OBJECT, align: 'center' },
      'Align right'
    );
    expect(applied).toMatchObject({ align: 'right', text: 'Text' });
  });

  it('writes no alignment back onto an object that never had one', async () => {
    const applied = await applyAlignment(TEXT_OBJECT, null);
    expect('align' in applied).toBe(false);
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
  it('places the composed draft at the click, with no drag extent', () => {
    const object = textObjectFromPoint(
      { x: 3, y: -4 },
      { ...newSketchTextDraft(), text: 'Boa', size: 8 }
    );
    // The card's string, never a placeholder, and the left alignment the
    // schema defaults to left out so the stored object stays minimal.
    expect(object).toEqual({
      objectKind: 'text',
      text: 'Boa',
      fontFamily: 'open-sans',
      fontStyle: 'regular',
      size: 8,
      x: 3,
      y: -4
    });
  });

  it('carries a non-default alignment and face from the draft', () => {
    const object = textObjectFromPoint(
      { x: 0, y: 0 },
      {
        text: 'Hi',
        fontFamily: 'lora',
        fontStyle: 'bold',
        size: 'h * 2',
        align: 'center'
      }
    );
    expect(object).toMatchObject({
      fontFamily: 'lora',
      fontStyle: 'bold',
      size: 'h * 2',
      align: 'center'
    });
  });

  it('starts a draft empty, so nothing is placed until text is typed', () => {
    expect(newSketchTextDraft()).toMatchObject({ text: '', align: 'left' });
  });
  it('lists what holds the entity, with edit and delete per row', async () => {
    const user = userEvent.setup();
    const onDeleteConstraint = vi.fn();
    const onEditConstraint = vi.fn();
    render(
      <SketchEntityEditor
        data={{ objectKind: 'line', x1: 0, y1: 0, x2: 10, y2: 0 }}
        scope={{}}
        onApply={vi.fn()}
        onDelete={vi.fn()}
        onClose={vi.fn()}
        constraints={[
          {
            constraintId: 'c1',
            kind: 'tangent',
            label: 'Tangent · line ○ circle',
            editable: false
          },
          {
            constraintId: 'c2',
            kind: 'distance',
            label: 'Distance 12 mm',
            editable: true
          }
        ]}
        onEditConstraint={onEditConstraint}
        onDeleteConstraint={onDeleteConstraint}
      />
    );
    // Adding a relation starts from the relations rail, not from here.
    expect(
      screen.queryByRole('group', { name: 'Add a constraint from this entity' })
    ).not.toBeInTheDocument();
    await user.click(
      screen.getByRole('button', {
        name: 'Delete constraint: Tangent · line ○ circle'
      })
    );
    expect(onDeleteConstraint).toHaveBeenCalledWith('c1');
    await user.click(
      screen.getByRole('button', { name: 'Edit constraint: Distance 12 mm' })
    );
    expect(onEditConstraint).toHaveBeenCalledTimes(1);
    const [constraintId, anchor] = onEditConstraint.mock.calls[0] as [
      string,
      { x: number; y: number }
    ];
    expect(constraintId).toBe('c2');
    expect(typeof anchor.x).toBe('number');
  });

  it('stays a plain value form without constraint tools', () => {
    render(
      <SketchEntityEditor
        data={TEXT_OBJECT}
        scope={{}}
        onApply={vi.fn()}
        onDelete={vi.fn()}
        onClose={vi.fn()}
      />
    );
    expect(screen.queryByLabelText('Constraints')).not.toBeInTheDocument();
  });

  it('keeps the constraints out of the form so field labels stay unique', () => {
    render(
      <SketchEntityEditor
        data={{
          objectKind: 'arc',
          radius: 5,
          centerX: 0,
          centerY: 0,
          startAngleDeg: 0,
          endAngleDeg: 90
        }}
        scope={{}}
        onApply={vi.fn()}
        onDelete={vi.fn()}
        onClose={vi.fn()}
        constraints={[
          {
            constraintId: 'c1',
            kind: 'radius',
            label: 'Radius 5 mm',
            editable: true
          }
        ]}
      />
    );
    const form = screen.getByRole('form', { name: 'Edit arc' });
    expect(within(form).getAllByLabelText(/radius/i)).toHaveLength(1);
    expect(
      screen.getByRole('region', { name: 'Constraints' })
    ).not.toContainElement(form);
  });
});

describe('editor feedback', () => {
  const LINE: SketchObjectData = {
    objectKind: 'line',
    x1: 0,
    y1: 0,
    x2: 10,
    y2: 0
  };

  it('shows a refused Apply as a form error beside the values', () => {
    render(
      <SketchEntityEditor
        data={LINE}
        scope={{}}
        error="The solver could not apply this edit."
        onApply={vi.fn()}
        onDelete={vi.fn()}
        onClose={vi.fn()}
      />
    );
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('The solver could not apply this edit.');
    expect(alert).toHaveClass('form-error');
    // Inside the values, ahead of Delete and Apply, as the validation
    // message is.
    const footer = screen
      .getByRole('button', { name: /apply/i })
      .closest('footer')!;
    expect(alert.parentElement).toBe(footer.parentElement);
    expect(
      alert.compareDocumentPosition(footer) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
  });

  it('offers a driving dimension to edit only when one holds the entity', () => {
    const { rerender } = render(
      <SketchEntityEditor
        data={LINE}
        scope={{}}
        onApply={vi.fn()}
        onDelete={vi.fn()}
        onClose={vi.fn()}
        constraints={[
          {
            constraintId: 'c1',
            kind: 'horizontal',
            label: 'Horizontal · Line 1',
            editable: false
          }
        ]}
      />
    );
    const section = screen.getByRole('region', { name: 'Constraints' });
    expect(section).toHaveTextContent(
      'These constraints control this geometry.'
    );
    expect(section).not.toHaveTextContent('driving dimension');
    rerender(
      <SketchEntityEditor
        data={LINE}
        scope={{}}
        onApply={vi.fn()}
        onDelete={vi.fn()}
        onClose={vi.fn()}
        constraints={[
          {
            constraintId: 'c2',
            kind: 'distance',
            label: 'Distance 10 mm',
            editable: true
          }
        ]}
      />
    );
    expect(
      screen.getByRole('region', { name: 'Constraints' })
    ).toHaveTextContent(
      'Edit a driving dimension below to change its constrained size.'
    );
  });
});

describe('sketch field unit context', () => {
  const rectangle: SketchObjectData = {
    objectKind: 'rectangle',
    width: 10,
    height: 4,
    centerX: 0,
    centerY: 0
  };

  it.each([
    { units: 'mm', expression: '5 mm + 2 cm', preview: '= 25' },
    { units: 'cm', expression: '5 mm + 2 cm', preview: '= 2.5' },
    { units: 'inch', expression: '1 in + 25.4 mm', preview: '= 2' }
  ] as const)(
    'previews lengths in $units and applies the authored expression',
    async ({ units, expression, preview }) => {
      const user = userEvent.setup();
      const onApply = vi.fn();
      render(
        <SketchEntityEditor
          data={rectangle}
          scope={{}}
          units={units}
          onApply={onApply}
          onDelete={vi.fn()}
          onClose={vi.fn()}
        />
      );
      const width = screen.getByLabelText('Width');
      await user.clear(width);
      await user.type(width, expression);
      expect(width).toHaveAccessibleDescription(preview);
      expect(width).not.toHaveAttribute('aria-invalid');
      expect(screen.getByRole('button', { name: /apply/i })).toBeEnabled();
      expect(onApply).not.toHaveBeenCalled();
      await user.click(screen.getByRole('button', { name: /apply/i }));
      expect(onApply).toHaveBeenCalledExactlyOnceWith({
        ...rectangle,
        width: expression
      });
    }
  );

  it.each(['0 mm', '-1 cm'])(
    'refuses the resolved non-positive width %s before Apply',
    async (expression) => {
      const user = userEvent.setup();
      const onApply = vi.fn();
      render(
        <SketchEntityEditor
          data={rectangle}
          scope={{}}
          units="cm"
          onApply={onApply}
          onDelete={vi.fn()}
          onClose={vi.fn()}
        />
      );
      const width = screen.getByLabelText('Width');
      await user.clear(width);
      await user.type(width, expression);
      expect(screen.getByRole('alert')).toHaveTextContent(
        'Lengths and radii must be greater than zero.'
      );
      expect(screen.getByRole('button', { name: /apply/i })).toBeDisabled();
      await user.keyboard('{Enter}');
      expect(onApply).not.toHaveBeenCalled();
    }
  );

  it('checks the line minimum in document units after converting endpoints', async () => {
    const user = userEvent.setup();
    const onApply = vi.fn();
    render(
      <SketchEntityEditor
        data={{ objectKind: 'line', x1: 0, y1: 0, x2: 1, y2: 0 }}
        scope={{}}
        units="cm"
        onApply={onApply}
        onDelete={vi.fn()}
        onClose={vi.fn()}
      />
    );
    const end = screen.getByLabelText('End X');
    await user.clear(end);
    await user.type(end, '4 mm');
    expect(end).toHaveAccessibleDescription('= 0.4');
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Line endpoints must be at least 0.5 units apart.'
    );
    expect(screen.getByRole('button', { name: /apply/i })).toBeDisabled();
    await user.clear(end);
    await user.type(end, '5 mm');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    await user.keyboard('{Enter}');
    expect(onApply).toHaveBeenCalledExactlyOnceWith({
      objectKind: 'line',
      x1: 0,
      y1: 0,
      x2: '5 mm',
      y2: 0
    });
  });

  it.each(['30 deg', '2 mm * 3 mm'])(
    'refuses another dimension in a length field: %s',
    async (expression) => {
      const user = userEvent.setup();
      const onApply = vi.fn();
      render(
        <SketchEntityEditor
          data={rectangle}
          scope={{}}
          units="cm"
          onApply={onApply}
          onDelete={vi.fn()}
          onClose={vi.fn()}
        />
      );
      const width = screen.getByLabelText('Width');
      await user.clear(width);
      await user.type(width, expression);
      expect(width).toHaveAttribute('aria-invalid', 'true');
      expect(width).toHaveAccessibleDescription(/expected a length/);
      expect(screen.getByRole('button', { name: /apply/i })).toBeDisabled();
      await user.keyboard('{Enter}');
      expect(onApply).not.toHaveBeenCalled();
    }
  );

  it('converts angle units for arc limits and refuses a length as an angle', async () => {
    const user = userEvent.setup();
    const onApply = vi.fn();
    render(
      <SketchEntityEditor
        data={{
          objectKind: 'arc',
          radius: 10,
          centerX: 0,
          centerY: 0,
          startAngleDeg: 0,
          endAngleDeg: 90
        }}
        scope={{}}
        units="inch"
        onApply={onApply}
        onDelete={vi.fn()}
        onClose={vi.fn()}
      />
    );
    const end = screen.getByLabelText('End angle');
    await user.clear(end);
    await user.type(end, '4 * 3.141592653589793 rad');
    expect(end).toHaveAccessibleDescription('= 720');
    expect(screen.getByRole('alert')).toHaveTextContent('360 degrees');
    expect(screen.getByRole('button', { name: /apply/i })).toBeDisabled();
    await user.clear(end);
    await user.type(end, '1 mm');
    expect(end).toHaveAccessibleDescription(/expected an angle/);
    expect(screen.getByRole('button', { name: /apply/i })).toBeDisabled();
    await user.clear(end);
    await user.type(end, '3.141592653589793 rad');
    expect(end).toHaveAccessibleDescription('= 180');
    await user.click(screen.getByRole('button', { name: /apply/i }));
    expect(onApply).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ endAngleDeg: '3.141592653589793 rad' })
    );
  });

  it('keeps polygon sides dimensionless while its radius accepts length units', async () => {
    const user = userEvent.setup();
    const onApply = vi.fn();
    render(
      <SketchEntityEditor
        data={{
          objectKind: 'polygon',
          sides: 6,
          radius: 2,
          centerX: 0,
          centerY: 0
        }}
        scope={{}}
        units="cm"
        onApply={onApply}
        onDelete={vi.fn()}
        onClose={vi.fn()}
      />
    );
    const radius = screen.getByLabelText('Radius');
    await user.clear(radius);
    await user.type(radius, '1 in');
    expect(radius).toHaveAccessibleDescription('= 2.54');
    const sides = screen.getByLabelText('Sides');
    await user.clear(sides);
    await user.type(sides, '6 mm');
    expect(sides).toHaveAccessibleDescription(/a number without units/);
    expect(screen.getByRole('button', { name: /apply/i })).toBeDisabled();
    await user.keyboard('{Enter}');
    expect(onApply).not.toHaveBeenCalled();
    await user.clear(sides);
    await user.type(sides, '3 + 3');
    await user.click(screen.getByRole('button', { name: /apply/i }));
    expect(onApply).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ sides: '3 + 3', radius: '1 in' })
    );
  });
});

describe('composite card (S04)', () => {
  const side: SketchObjectData = {
    objectKind: 'line',
    x1: 0,
    y1: 0,
    x2: 20,
    y2: 0
  };

  it('names the shape and side, and resizes the rectangle as one object', async () => {
    const user = userEvent.setup();
    const onResizeComposite = vi.fn();
    render(
      <SketchEntityEditor
        data={side}
        scope={{ gap: 3 }}
        onApply={vi.fn()}
        onDelete={vi.fn()}
        onClose={vi.fn()}
        composite={{
          compositeId: 'scmp_1',
          kind: 'rectangle',
          title: 'Center rectangle',
          side: 1,
          sides: 4,
          size: { width: 20, height: 12 },
          anchor: 'Keeps its center.'
        }}
        onResizeComposite={onResizeComposite}
      />
    );
    const card = screen.getByRole('form', { name: 'Resize center rectangle' });
    expect(card).toHaveTextContent('Side 1 of 4');
    expect(card).toHaveTextContent('Keeps its center.');
    expect(within(card).getByLabelText('Width')).toHaveValue('20');
    const height = within(card).getByLabelText('Height');
    await user.clear(height);
    await user.type(height, 'gap * 4');
    await user.click(within(card).getByRole('button', { name: 'Resize' }));
    // The typed expression rides along, so it keeps driving the height; the
    // untouched plain width does not.
    expect(onResizeComposite).toHaveBeenCalledWith(
      { width: 20, height: 12 },
      { height: 'gap * 4' }
    );
  });

  it('offers the polygon its circumradius and refuses a non-positive size', async () => {
    const user = userEvent.setup();
    const onResizeComposite = vi.fn();
    render(
      <SketchEntityEditor
        data={side}
        scope={{}}
        onApply={vi.fn()}
        onDelete={vi.fn()}
        onClose={vi.fn()}
        composite={{
          compositeId: 'scmp_2',
          kind: 'polygon',
          title: 'Polygon',
          side: 3,
          sides: 6,
          size: { circumradius: 10 },
          anchor: 'Keeps its center.'
        }}
        onResizeComposite={onResizeComposite}
      />
    );
    const card = screen.getByRole('form', { name: 'Resize polygon' });
    const radius = within(card).getByLabelText('Circumradius');
    await user.clear(radius);
    await user.type(radius, '0');
    expect(within(card).getByRole('button', { name: 'Resize' })).toBeDisabled();
    await user.clear(radius);
    await user.type(radius, '15');
    await user.click(within(card).getByRole('button', { name: 'Resize' }));
    expect(onResizeComposite).toHaveBeenCalledWith({ circumradius: 15 }, {});
  });
});
