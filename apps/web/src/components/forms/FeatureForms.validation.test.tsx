import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { toBodyId, toSketchId, type BodyId } from '@openzcad/shared';
import {
  EdgeModifierForm,
  PatternForm,
  RevolveForm,
  SketchForm,
  TransformForm
} from './FeatureForms';

const bodies = [
  { bodyId: toBodyId('body_a'), name: 'Box', consumed: false }
] as const;

function field(name: string): HTMLInputElement {
  return screen.getByRole<HTMLInputElement>('textbox', { name });
}

describe('revolve angle', () => {
  /*
    At 0 or below the card said both "A partial revolve keeps hash-only
    references" and "Angle must be greater than 0", and the range error was
    a loose paragraph the field knew nothing about.
  */
  it('ties an out-of-range angle to its field and drops the partial-revolve note', () => {
    render(
      <RevolveForm
        scope={{}}
        sketches={[{ sketchId: toSketchId('sketch_a'), name: 'Profile' }]}
        submitLabel="Create"
        onSubmit={vi.fn()}
      />
    );
    const angle = field('Angle (°)');
    fireEvent.change(angle, { target: { value: '0' } });
    expect(angle).toHaveAttribute('aria-invalid', 'true');
    expect(angle).toHaveAccessibleDescription(
      'Must be greater than 0° and at most 360°.'
    );
    expect(screen.queryByText(/A partial revolve/)).toBeNull();
    expect(screen.getByRole('button', { name: 'Create' })).toBeDisabled();

    fireEvent.change(angle, { target: { value: '90' } });
    expect(angle).not.toHaveAttribute('aria-invalid');
    expect(screen.getByText(/A partial revolve/)).toBeInTheDocument();
  });
});

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

  it('fillet: says why a zero radius leaves Create off', () => {
    render(
      <EdgeModifierForm
        kind="fillet"
        scope={{}}
        targetBodyId={toBodyId('body_a')}
        edgeHashes={[11]}
        submitLabel="Create"
        onSubmit={vi.fn()}
      />
    );
    const radius = field('Radius');
    fireEvent.change(radius, { target: { value: '0' } });
    expect(radius).toHaveAccessibleDescription('Must be greater than zero.');
    expect(screen.getByRole('button', { name: 'Create' })).toBeDisabled();
    fireEvent.change(radius, { target: { value: '2' } });
    const end = field('End radius (blank = constant)');
    fireEvent.change(end, { target: { value: '-1' } });
    expect(end).toHaveAccessibleDescription('Must be greater than zero.');
    expect(screen.getByRole('button', { name: 'Create' })).toBeDisabled();
  });

  it('pattern: the count must be within what the builder makes', () => {
    render(
      <PatternForm
        kind="linear"
        scope={{}}
        bodies={[...bodies]}
        submitLabel="Create"
        onSubmit={vi.fn()}
      />
    );
    const count = field('Count');
    fireEvent.change(count, { target: { value: '1' } });
    expect(count).toHaveAccessibleDescription('Must be from 2 to 100.');
    expect(screen.getByRole('button', { name: 'Create' })).toBeDisabled();
    fireEvent.change(count, { target: { value: '4' } });
    expect(screen.getByRole('button', { name: 'Create' })).toBeEnabled();
    // The custom direction is one named group of three axis fields.
    expect(
      screen.getByRole('group', { name: 'Custom direction (blank = axis)' })
    ).toBeInTheDocument();
    expect(field('Direction Z')).toBeInTheDocument();
  });

  it('move: a scale of zero is refused beside the field', () => {
    render(
      <TransformForm
        scope={{}}
        bodies={[...bodies]}
        initialTarget={'body_a' as BodyId}
        units="mm"
        submitLabel="Create"
        onSubmit={vi.fn()}
      />
    );
    const scale = field('Scale ×');
    fireEvent.change(scale, { target: { value: '0' } });
    expect(scale).toHaveAccessibleDescription('Must be greater than zero.');
    expect(screen.getByRole('button', { name: 'Create' })).toBeDisabled();
  });
});
