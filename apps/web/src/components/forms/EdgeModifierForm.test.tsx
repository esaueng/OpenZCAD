import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { toBodyId } from '@openzcad/shared';
import { EdgeModifierForm, type EdgeModifierFormValue } from './FeatureForms';

function renderChamfer(
  initial: { name: string; size: number; angleDeg?: number; distance2?: number },
  onSubmit: (value: EdgeModifierFormValue) => void
) {
  render(
    <EdgeModifierForm
      kind="chamfer"
      scope={{}}
      targetBodyId={toBodyId('body_a')}
      edgeHashes={[11]}
      initial={initial}
      submitLabel="Apply"
      onSubmit={onSubmit}
    />
  );
  return () =>
    fireEvent.submit(
      screen.getByRole('button', { name: /Apply/ }).closest('form')!
    );
}

describe('chamfer angle and second distance are exclusive in what the form emits', () => {
  it('emits no angle at all once a second distance is entered', () => {
    // The dead end this pins: the two inputs hide each other, so the angle
    // field is gone from the DOM by the time the second distance is filled.
    // If blanking the angle emitted a stand-in 45 the value would carry both
    // fields, every validator would refuse it, and no visible control could
    // clear the angle the error names.
    const onSubmit = vi.fn();
    const submit = renderChamfer(
      { name: 'Bevel', size: 2, angleDeg: 30 },
      onSubmit
    );

    fireEvent.change(screen.getByLabelText(/Angle/), { target: { value: '' } });
    fireEvent.change(screen.getByLabelText(/Second distance/), {
      target: { value: '5' }
    });
    expect(screen.queryByLabelText(/Angle/)).toBeNull();

    expect(screen.getByRole('button', { name: /Apply/ })).not.toBeDisabled();
    submit();

    const value = onSubmit.mock.calls[0]![0] as EdgeModifierFormValue;
    expect(value.distance2).toBe(5);
    expect('angleDeg' in value).toBe(false);
  });

  it('emits no angle when the field is simply blanked', () => {
    // Blanking the angle asks for the symmetric 45° bevel. The absent key is
    // that bevel, so the value says nothing rather than writing a lookalike.
    const onSubmit = vi.fn();
    const submit = renderChamfer(
      { name: 'Bevel', size: 2, angleDeg: 30 },
      onSubmit
    );

    fireEvent.change(screen.getByLabelText(/Angle/), { target: { value: '' } });
    submit();

    const value = onSubmit.mock.calls[0]![0] as EdgeModifierFormValue;
    expect('angleDeg' in value).toBe(false);
    expect('distance2' in value).toBe(false);
  });

  it('still emits an explicit angle when one is typed', () => {
    const onSubmit = vi.fn();
    const submit = renderChamfer({ name: 'Bevel', size: 2 }, onSubmit);

    fireEvent.change(screen.getByLabelText(/Angle/), {
      target: { value: '30' }
    });
    expect(screen.queryByLabelText(/Second distance/)).toBeNull();
    submit();

    const value = onSubmit.mock.calls[0]![0] as EdgeModifierFormValue;
    expect(value.angleDeg).toBe(30);
    expect('distance2' in value).toBe(false);
  });

  it('offers the angle again once a stored second distance is cleared', () => {
    const onSubmit = vi.fn();
    const submit = renderChamfer(
      { name: 'Bevel', size: 2, distance2: 5 },
      onSubmit
    );

    expect(screen.queryByLabelText(/Angle/)).toBeNull();
    fireEvent.change(screen.getByLabelText(/Second distance/), {
      target: { value: '' }
    });
    fireEvent.change(screen.getByLabelText(/Angle/), {
      target: { value: '30' }
    });
    submit();

    const value = onSubmit.mock.calls[0]![0] as EdgeModifierFormValue;
    expect(value.angleDeg).toBe(30);
    expect('distance2' in value).toBe(false);
  });
});
