/**
 * Editing a finished text sketch from the history panel.
 *
 * Reported from the deployed build: selecting a text sketch after Finish
 * Sketch showed the closed-shape form — "Rectangle 32×18" — with no way to
 * reach the text, and applying it would have replaced the text object with
 * that rectangle and re-planed a face-attached sketch. This form is the fix,
 * so these tests pin the two properties that matter: the text is editable,
 * and what Apply produces is still the text object.
 */
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { SketchObjectData } from '@openzcad/shared';
import { TextSketchForm } from './FeatureForms';

const TEXT_OBJECT = {
  objectKind: 'text',
  text: 'Hello',
  fontFamily: 'open-sans',
  fontStyle: 'regular',
  size: 10,
  x: 2,
  y: 3
} satisfies SketchObjectData;

function renderForm(onSubmit = vi.fn(), onEditInViewport = vi.fn()) {
  render(
    <TextSketchForm
      scope={{}}
      initial={{ name: 'Sketch 01', object: TEXT_OBJECT }}
      onSubmit={onSubmit}
      onEditInViewport={onEditInViewport}
    />
  );
  return { onSubmit, onEditInViewport };
}

describe('TextSketchForm', () => {
  it('offers the string, font, style, size, rotation and position', () => {
    renderForm();
    expect(screen.getByLabelText('Text')).toHaveValue('Hello');
    expect(screen.getByLabelText('Font')).toBeTruthy();
    expect(screen.getByRole('group', { name: 'Font style' })).toBeTruthy();
    expect(screen.getByLabelText('Size (em)')).toBeTruthy();
    expect(screen.getByLabelText('Rotation')).toBeTruthy();
    expect(screen.getByLabelText('X')).toBeTruthy();
    expect(screen.getByLabelText('Y')).toBeTruthy();
    // The defining property of the bug this form fixes: a text sketch must
    // never be presented as a closed-shape profile.
    expect(screen.queryByText('Rectangle')).toBeNull();
  });

  it('applies a whole-word change as a text object, not a rectangle', async () => {
    const user = userEvent.setup();
    const { onSubmit } = renderForm();
    const field = screen.getByLabelText('Text');
    await user.clear(field);
    await user.type(field, 'World');
    await user.click(screen.getByRole('button', { name: /apply/i }));
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit.mock.calls[0]![0]).toMatchObject({
      name: 'Sketch 01',
      data: {
        objectKind: 'text',
        text: 'World',
        fontFamily: 'open-sans',
        size: 10,
        x: 2,
        y: 3
      }
    });
  });

  it('edits the alignment the text card set', async () => {
    const user = userEvent.setup();
    const { onSubmit } = renderForm();
    expect(screen.getByRole('radio', { name: 'Align left' })).toHaveAttribute(
      'aria-checked',
      'true'
    );
    await user.click(screen.getByRole('radio', { name: 'Align center' }));
    await user.click(screen.getByRole('button', { name: /apply/i }));
    expect(onSubmit.mock.calls[0]![0]).toMatchObject({
      data: { objectKind: 'text', text: 'Hello', align: 'center' }
    });
  });

  it('offers the viewport as the spatial alternative', async () => {
    const user = userEvent.setup();
    const { onEditInViewport, onSubmit } = renderForm();
    await user.click(
      screen.getByRole('button', { name: 'Edit sketch in viewport' })
    );
    expect(onEditInViewport).toHaveBeenCalledTimes(1);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('refuses an empty string rather than committing invisible ink', async () => {
    const user = userEvent.setup();
    const { onSubmit } = renderForm();
    await user.clear(screen.getByLabelText('Text'));
    await user.click(screen.getByRole('button', { name: /apply/i }));
    expect(onSubmit).not.toHaveBeenCalled();
  });
});

describe('history text sketch unit context', () => {
  const unitObject = {
    ...TEXT_OBJECT,
    size: '1 in + 25.4 mm',
    rotation: '1.5707963267948966 rad',
    x: '1 cm',
    y: '-5 mm'
  };

  it.each([
    { units: 'mm', size: '= 50.8', x: '= 10' },
    { units: 'cm', size: '= 5.08', x: '= 1' },
    { units: 'inch', size: '= 2', x: '= 0.394' }
  ] as const)(
    'can rename saved text in $units while retaining authored lengths and rotation',
    ({ units, size, x }) => {
      const onSubmit = vi.fn();
      render(
        <TextSketchForm
          scope={{}}
          units={units}
          initial={{ name: 'Text profile', object: unitObject }}
          onSubmit={onSubmit}
        />
      );
      expect(screen.getByLabelText('Size (em)')).toHaveAccessibleDescription(
        size
      );
      expect(screen.getByLabelText('Rotation')).toHaveAccessibleDescription(
        '= 90'
      );
      expect(screen.getByLabelText('X')).toHaveAccessibleDescription(x);
      expect(screen.getByRole('button', { name: 'Apply' })).toBeEnabled();
      fireEvent.change(screen.getByLabelText('Name'), {
        target: { value: 'Renamed text' }
      });
      fireEvent.keyDown(screen.getByLabelText('Name'), { key: 'Enter' });
      expect(onSubmit).toHaveBeenCalledExactlyOnceWith({
        name: 'Renamed text',
        data: unitObject
      });
    }
  );

  it.each([
    { label: 'Size (em)', expression: '30 deg', expected: /expected a length/ },
    { label: 'Rotation', expression: '5 mm', expected: /expected an angle/ },
    { label: 'X', expression: '2 mm * 3 mm', expected: /expected a length/ }
  ])(
    'refuses a wrong dimension in $label',
    ({ label, expression, expected }) => {
      const onSubmit = vi.fn();
      render(
        <TextSketchForm
          scope={{}}
          units="cm"
          initial={{ name: 'Text profile', object: unitObject }}
          onSubmit={onSubmit}
        />
      );
      const input = screen.getByRole('textbox', { name: label });
      fireEvent.change(input, { target: { value: expression } });
      expect(input).toHaveAttribute('aria-invalid', 'true');
      expect(input).toHaveAccessibleDescription(expected);
      expect(screen.getByRole('button', { name: 'Apply' })).toBeDisabled();
      fireEvent.keyDown(input, { key: 'Enter' });
      expect(onSubmit).not.toHaveBeenCalled();
    }
  );

  it.each(['0 mm', '-1 cm'])(
    'refuses a converted non-positive text size %s',
    (expression) => {
      const onSubmit = vi.fn();
      render(
        <TextSketchForm
          scope={{}}
          units="inch"
          initial={{ name: 'Text profile', object: unitObject }}
          onSubmit={onSubmit}
        />
      );
      const size = screen.getByLabelText('Size (em)');
      fireEvent.change(size, { target: { value: expression } });
      expect(size).toHaveAccessibleDescription('Must be greater than zero.');
      expect(screen.getByRole('button', { name: 'Apply' })).toBeDisabled();
      fireEvent.keyDown(size, { key: 'Enter' });
      expect(onSubmit).not.toHaveBeenCalled();
    }
  );
});
