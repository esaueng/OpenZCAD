import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { toBodyId, type BodyId } from '@openzcad/shared';
import { SketchForm, TransformForm } from './FeatureForms';

const bodies = [
  { bodyId: toBodyId('body_a'), name: 'Box', consumed: false }
] as const;

function field(name: string): HTMLInputElement {
  return screen.getByRole<HTMLInputElement>('textbox', { name });
}

describe('values the geometry refuses are refused in the form', () => {
  it('sketch: polygon sides must be a whole number from 3', () => {
    render(<SketchForm scope={{}} submitLabel="Create" onSubmit={vi.fn()} />);
    fireEvent.change(screen.getByRole('combobox', { name: 'Shape' }), {
      target: { value: 'polygon' }
    });
    const sides = field('Sides');
    fireEvent.change(sides, { target: { value: '2.5' } });
    expect(sides).toHaveAccessibleDescription(
      'Must be a whole number from 3 to 64.'
    );
    expect(screen.getByRole('button', { name: 'Create' })).toBeDisabled();
    fireEvent.change(sides, { target: { value: '5' } });
    fireEvent.change(field('Radius'), { target: { value: '0' } });
    expect(field('Radius')).toHaveAccessibleDescription(
      'Must be greater than zero.'
    );
    expect(screen.getByRole('button', { name: 'Create' })).toBeDisabled();
    fireEvent.change(field('Radius'), { target: { value: '4' } });
    expect(screen.getByRole('button', { name: 'Create' })).toBeEnabled();
  });

  it('move: a scale of zero is refused beside the field', () => {
    render(
      <TransformForm
        scope={{}}
        bodies={[...bodies]}
        initial={{
          name: 'Move',
          targetBodyId: 'body_a' as BodyId,
          translation: { x: 0, y: 0, z: 0 },
          rotationDeg: { x: 0, y: 0, z: 0 }
        }}
        units="mm"
        submitLabel="Apply"
        onSubmit={vi.fn()}
      />
    );
    const scale = field('Scale ×');
    fireEvent.change(scale, { target: { value: '0' } });
    expect(scale).toHaveAccessibleDescription('Must be greater than zero.');
    expect(screen.getByRole('button', { name: 'Apply' })).toBeDisabled();
  });
});
