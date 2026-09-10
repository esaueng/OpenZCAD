import { createRef } from 'react';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { toBodyId, toSketchId, type ParamValue } from '@openzcad/shared';
import { ExtrudeForm } from './ExtrudeForm';

const sketchId = toSketchId('layout');
const bodies = [{ bodyId: toBodyId('plate'), name: 'Mounting plate' }];
const initial = { name: 'Bores', sketchId, distance: -8 };
const base = {
  initial,
  bodies,
  sketches: [{ sketchId, name: 'Bore layout' }],
  scope: { thickness: 8 },
  submitLabel: 'Apply'
};

describe('shared extrusion editor', () => {
  it('previews explicit Cut and expressions without committing; Enter applies that exact draft', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    const onPreview = vi.fn();
    const onDistance = vi.fn();
    render(
      <ExtrudeForm
        {...base}
        onSubmit={onSubmit}
        onPreview={onPreview}
        onDistance={onDistance}
        onCancel={vi.fn()}
      />
    );
    await user.selectOptions(
      screen.getByLabelText('Stored extrude operation'),
      'cut'
    );
    expect(screen.getByLabelText('Extrude target body')).toHaveValue('plate');
    const input = screen.getByRole('textbox', { name: 'Distance' });
    await user.clear(input);
    expect(screen.getByRole('button', { name: 'Apply' })).toBeDisabled();
    await user.type(input, '-thickness');
    expect(onSubmit).not.toHaveBeenCalled();
    expect(onPreview).toHaveBeenLastCalledWith(
      expect.objectContaining({
        distance: '-thickness',
        choice: { operation: 'cut', targetBodyId: 'plate' }
      })
    );
    await user.click(screen.getByRole('button', { name: 'Distance…' }));
    expect(onDistance).toHaveBeenCalledExactlyOnceWith('-thickness');
    await user.click(input);
    await user.keyboard('{Enter}');
    expect(onSubmit).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        distance: '-thickness',
        choice: { operation: 'cut', targetBodyId: 'plate' }
      })
    );
  });

  it('drops the target for New Body, preserves expression reversal, and cancels from a focused field', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    const onCancel = vi.fn();
    render(
      <ExtrudeForm
        {...base}
        initial={{
          ...initial,
          distance: 'thickness',
          operation: 'cut',
          targetBodyId: bodies[0]!.bodyId
        }}
        onSubmit={onSubmit}
        onCancel={onCancel}
      />
    );
    await user.selectOptions(
      screen.getByLabelText('Stored extrude operation'),
      'new-body'
    );
    expect(screen.queryByLabelText('Extrude target body')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Reverse direction' }));
    expect(screen.getByRole('textbox', { name: 'Distance' })).toHaveValue(
      '-(thickness)'
    );
    await user.click(screen.getByRole('textbox', { name: 'Distance' }));
    await user.keyboard('{Escape}');
    expect(onCancel).toHaveBeenCalledOnce();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('prevents invalid targets and dimensions and keeps Cancel available while validating', async () => {
    const user = userEvent.setup();
    const props = { ...base, onSubmit: vi.fn(), onCancel: vi.fn() };
    const { rerender } = render(
      <ExtrudeForm
        {...props}
        initial={{
          ...initial,
          operation: 'add',
          targetBodyId: toBodyId('missing')
        }}
      />
    );
    expect(screen.getByRole('button', { name: 'Apply' })).toBeDisabled();
    await user.selectOptions(
      screen.getByLabelText('Extrude target body'),
      'plate'
    );
    await user.clear(screen.getByRole('textbox', { name: 'Back distance' }));
    await user.type(
      screen.getByRole('textbox', { name: 'Back distance' }),
      '-2'
    );
    expect(screen.getByRole('button', { name: 'Apply' })).toBeDisabled();
    await user.click(
      screen.getByRole('checkbox', { name: 'Symmetric about the sketch plane' })
    );
    await user.click(screen.getByRole('button', { name: 'Apply' }));
    expect(props.onSubmit).toHaveBeenLastCalledWith(
      expect.objectContaining({ symmetric: true, backDistance: 0 })
    );
    rerender(<ExtrudeForm {...props} disabled />);
    expect(screen.getByRole('textbox', { name: 'Distance' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeEnabled();
  });

  it('accepts a released drag into the same draft without creating a feature', async () => {
    const user = userEvent.setup();
    const distanceSetterRef = createRef<((value: ParamValue) => void) | null>();
    const onSubmit = vi.fn();
    const onPreview = vi.fn();
    render(
      <ExtrudeForm
        {...base}
        creating
        submitLabel="Create"
        initial={{ ...initial, distance: 0 }}
        distanceSetterRef={distanceSetterRef}
        onPreview={onPreview}
        onSubmit={onSubmit}
        onCancel={vi.fn()}
      />
    );
    // The viewport calls this bridge on pointer release.
    act(() => distanceSetterRef.current?.(12.5));
    expect(screen.getByRole('textbox', { name: 'Distance' })).toHaveValue(
      '12.5'
    );
    expect(onSubmit).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Create' }));
    expect(onSubmit).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ distance: 12.5 })
    );
  });
});
