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
import { render, screen } from '@testing-library/react';
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
    expect(screen.getByLabelText('Size')).toBeTruthy();
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
