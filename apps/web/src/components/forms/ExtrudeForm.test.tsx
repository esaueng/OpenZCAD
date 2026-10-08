import { createRef } from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { toBodyId, toSketchId, type ParamValue } from '@openzcad/shared';
import {
  ExtrudeForm,
  distanceKeypadText,
  reversedDistance
} from './ExtrudeForm';
import { NumericKeypad } from '../NumericKeypad';

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

  it('holds the zero-distance error until the distance is edited', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(
      <ExtrudeForm
        {...base}
        creating
        submitLabel="Create"
        initial={{ ...initial, distance: 0 }}
        onSubmit={onSubmit}
        onCancel={vi.fn()}
      />
    );
    // A fresh card opens at zero: nothing typed yet, so nothing in red.
    expect(screen.queryByText(/Distance cannot be zero/)).toBeNull();
    expect(screen.getByRole('button', { name: 'Create' })).toBeDisabled();

    const input = screen.getByRole('textbox', { name: 'Distance' });
    await user.clear(input);
    await user.type(input, '5');
    expect(screen.queryByText(/Distance cannot be zero/)).toBeNull();
    await user.clear(input);
    await user.type(input, '0');
    expect(screen.getByText(/Distance cannot be zero/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Create' })).toBeDisabled();
  });

  it('shows the zero-distance error on an attempt to submit', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(
      <ExtrudeForm
        {...base}
        creating
        submitLabel="Create"
        initial={{ ...initial, distance: 0 }}
        onSubmit={onSubmit}
        onCancel={vi.fn()}
      />
    );
    expect(screen.queryByText(/Distance cannot be zero/)).toBeNull();
    await user.click(screen.getByRole('textbox', { name: 'Name' }));
    await user.keyboard('{Enter}');
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByText(/Distance cannot be zero/)).toBeTruthy();
  });
});

describe('zero-distance extrude', () => {
  it('says why Create is disabled before the first edit, then turns red only after one', async () => {
    const user = userEvent.setup();
    render(
      <ExtrudeForm
        {...base}
        creating
        initial={{ name: 'Extrude', sketchId, distance: 0 }}
        submitLabel="Create"
        onSubmit={vi.fn()}
        onCancel={vi.fn()}
      />
    );
    expect(screen.getByRole('button', { name: 'Create' })).toBeDisabled();
    expect(
      screen.getByText(
        'Enter a distance other than 0, or drag the arrow, to enable Create.'
      )
    ).toBeInTheDocument();

    const input = screen.getByRole('textbox', { name: 'Distance' });
    await user.clear(input);
    await user.type(input, '12');
    expect(
      screen.queryByText(/Enter a distance other than 0/)
    ).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create' })).toBeEnabled();
  });
});

describe('Distance… exact entry', () => {
  /*
    The keypad opened on the resolved number rounded to two decimals, and
    Enter (which its hint offers) applied that: Distance 10/3 became a
    3.33 mm extrude and lost its expression.
  */
  it('opens the keypad on the distance as the form holds it', () => {
    expect(distanceKeypadText('10/3')).toBe('10/3');
    expect(distanceKeypadText('-thickness')).toBe('-thickness');
    expect(distanceKeypadText(12.345)).toBe('12.345');
    expect(distanceKeypadText(-8)).toBe('-8');
    // Zero opens empty, so the first key types the value.
    expect(distanceKeypadText(0)).toBe('');
    expect(distanceKeypadText('')).toBe('');
  });

  it('re-commits that prefill as the expression, not a rounding of it', () => {
    const onCommit = vi.fn<(value: number, raw: string) => void>();
    render(
      <NumericKeypad
        request={{
          kind: 'offset',
          label: 'Distance',
          initial: distanceKeypadText('10/3'),
          unitKind: 'length'
        }}
        units="mm"
        scope={{}}
        anchorRef={{ current: null }}
        onPreview={vi.fn()}
        onCommit={onCommit}
        onCancel={vi.fn()}
      />
    );
    const field = screen.getByRole('textbox', { name: 'Distance' });
    expect(field).toHaveValue('10/3');
    fireEvent.keyDown(field, { key: 'Enter' });
    expect(onCommit).toHaveBeenCalledOnce();
    const [value, raw] = onCommit.mock.calls[0]!;
    expect(value).toBeCloseTo(10 / 3, 9);
    expect(raw).toBe('10/3');
  });
});

describe('Reverse direction', () => {
  it('unwraps a negated expression instead of negating it again', () => {
    expect(reversedDistance('10/2')).toBe('-(10/2)');
    expect(reversedDistance('-(10/2)')).toBe('10/2');
    expect(reversedDistance('12')).toBe('-12');
    expect(reversedDistance('-12')).toBe('12');
    // The first parenthesis closes early: not a negation of the whole.
    expect(reversedDistance('-(a)*(b)')).toBe('-(-(a)*(b))');
  });

  it('round-trips the distance field through two presses', async () => {
    const user = userEvent.setup();
    render(
      <ExtrudeForm
        {...base}
        initial={{ ...initial, distance: '10/2' }}
        onSubmit={vi.fn()}
        onCancel={vi.fn()}
      />
    );
    const reverse = screen.getByRole('button', { name: 'Reverse direction' });
    // A styled button, not bare caption text.
    expect(reverse).toHaveClass('secondary');
    await user.click(reverse);
    await user.click(reverse);
    expect(screen.getByRole('textbox', { name: 'Distance' })).toHaveValue(
      '10/2'
    );
  });
});
