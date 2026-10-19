import { createRef, type MutableRefObject } from 'react';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import {
  toBodyId,
  toSketchId,
  type ExtrudeToFaceTarget,
  type ParamValue
} from '@openzcad/shared';
import {
  ExtrudeForm,
  reversedDistance,
  type ExtrudeToFacePicking
} from './ExtrudeForm';

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
    render(
      <ExtrudeForm
        {...base}
        onSubmit={onSubmit}
        onPreview={onPreview}
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

describe('through-all extent (F01)', () => {
  it('offers Through all once Cut is explicit and submits its side, not a distance', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    const { rerender } = render(
      <ExtrudeForm {...base} onSubmit={onSubmit} onCancel={vi.fn()} />
    );
    // New body: no extent choice.
    expect(screen.queryByLabelText('Extent')).toBeNull();
    await user.selectOptions(
      screen.getByLabelText('Stored extrude operation'),
      'cut'
    );
    await user.selectOptions(
      await screen.findByLabelText('Extent'),
      'through-all'
    );
    // The distance controls give way to a direction.
    expect(screen.queryByRole('textbox', { name: 'Distance' })).toBeNull();
    await user.selectOptions(
      screen.getByLabelText('Through-all direction'),
      'both'
    );
    await user.click(screen.getByRole('button', { name: 'Apply' }));
    expect(onSubmit).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        endCondition: 'through-all',
        throughAllSide: 'both',
        symmetric: false,
        backDistance: 0,
        choice: { operation: 'cut', targetBodyId: 'plate' }
      })
    );
    // Creating offers it once Cut is chosen, never while still inferring.
    rerender(
      <ExtrudeForm
        {...base}
        key="create"
        creating
        initial={{ ...initial, distance: 0 }}
        onSubmit={onSubmit}
        onCancel={vi.fn()}
      />
    );
    expect(screen.queryByLabelText('Extent')).toBeNull();
    await user.selectOptions(screen.getByLabelText('Extrude operation'), 'cut');
    await user.selectOptions(
      await screen.findByLabelText('Extent'),
      'through-all'
    );
    // The zero starting distance does not block a through-all Create.
    await user.click(screen.getByRole('button', { name: 'Apply' }));
    expect(onSubmit).toHaveBeenLastCalledWith(
      expect.objectContaining({
        endCondition: 'through-all',
        throughAllSide: 'forward',
        choice: { operation: 'cut', targetBodyId: 'plate' }
      })
    );
  });

  it('reopens a through-all cut as such and returns to blind with its distance', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(
      <ExtrudeForm
        {...base}
        initial={{
          ...initial,
          operation: 'cut',
          targetBodyId: bodies[0]!.bodyId,
          endCondition: 'through-all',
          throughAllSide: 'backward'
        }}
        onSubmit={onSubmit}
        onCancel={vi.fn()}
      />
    );
    expect(await screen.findByLabelText('Extent')).toHaveValue('through-all');
    expect(screen.getByLabelText('Through-all direction')).toHaveValue(
      'backward'
    );
    await user.selectOptions(screen.getByLabelText('Extent'), 'blind');
    expect(screen.getByRole('textbox', { name: 'Distance' })).toHaveValue('-8');
    await user.click(screen.getByRole('button', { name: 'Apply' }));
    expect(onSubmit).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ endCondition: 'blind', distance: -8 })
    );
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

describe('direction', () => {
  /*
    The 11 Oct 2026 review (G8) found three ways to flip an extrusion: the
    distance's sign, Reverse direction, and a "Distance…" button that only
    reopened the same number in the exact-entry keypad. The sign is the
    direction and Reverse is the one control that flips it.
  */
  it('offers the signed distance and one flip control, nothing else', () => {
    render(<ExtrudeForm {...base} onSubmit={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.getByRole('textbox', { name: 'Distance' })).toHaveValue('-8');
    expect(
      screen.getAllByRole('button', { name: /reverse|direction|distance/i })
    ).toEqual([screen.getByRole('button', { name: 'Reverse direction' })]);
    expect(screen.queryByRole('button', { name: /Distance…/ })).toBeNull();
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

describe('extrusion field unit context', () => {
  it.each([
    {
      units: 'mm',
      expression: '5 mm + 2 cm',
      distancePreview: '= 25',
      backPreview: '= 5'
    },
    {
      units: 'cm',
      expression: '5 mm + 2 cm',
      distancePreview: '= 2.5',
      backPreview: '= 0.5'
    },
    {
      units: 'inch',
      expression: '1 in + 25.4 mm',
      distancePreview: '= 2',
      backPreview: '= 0.197'
    }
  ] as const)(
    'previews both distances in $units and Enter commits the authored draft',
    async ({ units, expression, distancePreview, backPreview }) => {
      const user = userEvent.setup();
      const onSubmit = vi.fn();
      const onPreview = vi.fn();
      render(
        <ExtrudeForm
          {...base}
          units={units}
          onSubmit={onSubmit}
          onPreview={onPreview}
          onCancel={vi.fn()}
        />
      );
      const distance = screen.getByRole('textbox', { name: 'Distance' });
      const back = screen.getByRole('textbox', { name: 'Back distance' });
      await user.clear(distance);
      await user.type(distance, expression);
      await user.clear(back);
      await user.type(back, '5 mm');
      expect(distance).toHaveAccessibleDescription(distancePreview);
      expect(back).toHaveAccessibleDescription(backPreview);
      expect(screen.getByRole('button', { name: 'Apply' })).toBeEnabled();
      expect(onSubmit).not.toHaveBeenCalled();
      const draft = {
        distance: expression,
        backDistance: '5 mm',
        symmetric: false
      };
      expect(onPreview).toHaveBeenLastCalledWith(
        expect.objectContaining(draft)
      );
      await user.keyboard('{Enter}');
      expect(onSubmit).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining(draft)
      );
    }
  );

  it('reverses a unit-bearing expression without flattening it to a number', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    const onPreview = vi.fn();
    render(
      <ExtrudeForm
        {...base}
        units="cm"
        initial={{ ...initial, distance: '12 mm' }}
        onSubmit={onSubmit}
        onPreview={onPreview}
        onCancel={vi.fn()}
      />
    );
    await user.click(screen.getByRole('button', { name: 'Reverse direction' }));
    const distance = screen.getByRole('textbox', { name: 'Distance' });
    expect(distance).toHaveValue('-(12 mm)');
    expect(distance).toHaveAccessibleDescription('= -1.2');
    expect(onPreview).toHaveBeenLastCalledWith(
      expect.objectContaining({ distance: '-(12 mm)' })
    );
    await user.click(screen.getByRole('button', { name: 'Apply' }));
    expect(onSubmit).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ distance: '-(12 mm)' })
    );
  });

  it.each(['0 mm', '1 cm - 10 mm'])(
    'refuses a converted zero distance %s for preview and Enter',
    async (expression) => {
      const user = userEvent.setup();
      const onSubmit = vi.fn();
      const onPreview = vi.fn();
      render(
        <ExtrudeForm
          {...base}
          units="inch"
          onSubmit={onSubmit}
          onPreview={onPreview}
          onCancel={vi.fn()}
        />
      );
      const distance = screen.getByRole('textbox', { name: 'Distance' });
      await user.clear(distance);
      await user.type(distance, expression);
      expect(distance).toHaveAccessibleDescription(/Distance cannot be zero/);
      expect(onPreview).toHaveBeenLastCalledWith(null);
      expect(screen.getByRole('button', { name: 'Apply' })).toBeDisabled();
      await user.keyboard('{Enter}');
      expect(onSubmit).not.toHaveBeenCalled();
    }
  );

  it('refuses a converted negative back distance, then discards it for symmetric extrusion', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    const onPreview = vi.fn();
    render(
      <ExtrudeForm
        {...base}
        units="cm"
        initial={{ ...initial, distance: '12 mm' }}
        onSubmit={onSubmit}
        onPreview={onPreview}
        onCancel={vi.fn()}
      />
    );
    const back = screen.getByRole('textbox', { name: 'Back distance' });
    await user.clear(back);
    await user.type(back, '-2 mm');
    expect(back).toHaveAccessibleDescription(
      'Back distance cannot be negative.'
    );
    expect(onPreview).toHaveBeenLastCalledWith(null);
    expect(screen.getByRole('button', { name: 'Apply' })).toBeDisabled();
    await user.keyboard('{Enter}');
    expect(onSubmit).not.toHaveBeenCalled();
    const symmetric = screen.getByRole('checkbox', {
      name: 'Symmetric about the sketch plane'
    });
    await user.click(symmetric);
    expect(screen.queryByRole('textbox', { name: 'Back distance' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Apply' })).toBeEnabled();
    expect(onPreview).toHaveBeenLastCalledWith(
      expect.objectContaining({
        distance: '12 mm',
        symmetric: true,
        backDistance: 0
      })
    );
    await user.click(symmetric);
    expect(onPreview).toHaveBeenLastCalledWith(null);
    expect(screen.getByRole('button', { name: 'Apply' })).toBeDisabled();
    await user.click(symmetric);
    await user.click(screen.getByRole('button', { name: 'Apply' }));
    expect(onSubmit).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        distance: '12 mm',
        symmetric: true,
        backDistance: 0
      })
    );
  });

  it.each([
    { label: 'Distance', expression: '30 deg' },
    { label: 'Back distance', expression: '2 mm * 3 mm' }
  ])(
    'refuses a wrong dimension in $label for preview and commit',
    async ({ label, expression }) => {
      const user = userEvent.setup();
      const onSubmit = vi.fn();
      const onPreview = vi.fn();
      render(
        <ExtrudeForm
          {...base}
          units="cm"
          onSubmit={onSubmit}
          onPreview={onPreview}
          onCancel={vi.fn()}
        />
      );
      const input = screen.getByRole('textbox', { name: label });
      await user.clear(input);
      await user.type(input, expression);
      expect(input).toHaveAttribute('aria-invalid', 'true');
      expect(input).toHaveAccessibleDescription(/expected a length/);
      expect(onPreview).toHaveBeenLastCalledWith(null);
      expect(screen.getByRole('button', { name: 'Apply' })).toBeDisabled();
      await user.keyboard('{Enter}');
      expect(onSubmit).not.toHaveBeenCalled();
    }
  );
});

describe('intersect result intent (ZC-060)', () => {
  it('needs a target and submits an explicit Intersect with it', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(
      <ExtrudeForm
        {...base}
        initial={{ ...initial, distance: 8 }}
        onSubmit={onSubmit}
        onCancel={vi.fn()}
      />
    );
    await user.selectOptions(
      screen.getByLabelText('Stored extrude operation'),
      'intersect'
    );
    // One body: it is picked for the user, as for Add and Cut.
    expect(screen.getByLabelText('Extrude target body')).toHaveValue('plate');
    // Through all stays a cut-only extent.
    expect(screen.queryByLabelText('Extent')).toBeNull();
    await user.click(screen.getByRole('button', { name: /Apply/ }));
    expect(onSubmit).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        choice: { operation: 'intersect', targetBodyId: 'plate' }
      })
    );
  });
});

describe('to-face extent and draft (F01, schema v29)', () => {
  const face = {
    type: 'face',
    bodyId: toBodyId('ceiling'),
    faceHash: 7,
    faceReference: { kind: 'face' },
    sourceArea: 400,
    sourceCenter: { x: 10, y: 10, z: 25 },
    sourceCentroid: { x: 10, y: 10, z: 25 },
    sourceNormal: { x: 0, y: 0, z: -1 },
    frame: {
      origin: { x: 10, y: 10, z: 25 },
      xAxis: { x: 1, y: 0, z: 0 },
      yAxis: { x: 0, y: -1, z: 0 },
      zAxis: { x: 0, y: 0, z: -1 }
    }
  } as unknown as ExtrudeToFaceTarget;

  function picking(overrides: Partial<ExtrudeToFacePicking> = {}) {
    return {
      armed: false,
      onPick: vi.fn(),
      cancel: vi.fn(),
      describe: () => ({ label: 'Ceiling · face', distance: 25 }),
      setterRef: { current: null } satisfies ExtrudeToFacePicking['setterRef'],
      ...overrides
    } satisfies ExtrudeToFacePicking;
  }

  it('waits for the exact reach before enabling Apply and names the pending check', () => {
    render(
      <ExtrudeForm
        {...base}
        initial={{ ...initial, endCondition: 'to-face', toFace: face }}
        toFacePicking={picking({
          describe: () => ({
            label: 'Ceiling · face',
            distance: null,
            pending: true
          })
        })}
        onSubmit={vi.fn()}
        onCancel={vi.fn()}
      />
    );
    expect(screen.getByText('Checking the target face…')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Apply' })).toBeDisabled();
    expect(
      screen.queryByText(/This face is not parallel/)
    ).not.toBeInTheDocument();
  });

  it('offers To face for any operation, arms the pick, and submits the picked face with its reach as the dormant distance', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    const host = picking();
    render(
      <ExtrudeForm
        {...base}
        toFacePicking={host}
        onSubmit={onSubmit}
        onCancel={vi.fn()}
      />
    );
    // New body: To face is offered, Through all is not.
    const extent = screen.getByLabelText('Extent');
    expect(
      Array.from(extent.querySelectorAll('option'), (option) => option.value)
    ).toEqual(['blind', 'to-face']);
    await user.selectOptions(extent, 'to-face');
    expect(screen.queryByRole('textbox', { name: 'Distance' })).toBeNull();
    expect(screen.getByText('No face picked yet.')).toBeInTheDocument();
    // Without a face there is nothing to Apply.
    expect(screen.getByRole('button', { name: 'Apply' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Pick face' }));
    expect(host.onPick).toHaveBeenCalledOnce();
    act(() => host.setterRef.current?.(face));
    expect(screen.getByText('Up to Ceiling · face')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Apply' }));
    expect(onSubmit).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        endCondition: 'to-face',
        toFace: face,
        distance: 25,
        symmetric: false,
        backDistance: 0
      })
    );
  });

  it('withdraws its pick when the card closes', () => {
    const host = picking({ armed: true });
    const { unmount } = render(
      <ExtrudeForm
        {...base}
        toFacePicking={host}
        onSubmit={vi.fn()}
        onCancel={vi.fn()}
      />
    );
    expect(host.cancel).not.toHaveBeenCalled();
    unmount();
    expect(host.cancel).toHaveBeenCalledOnce();
  });

  it.each([false, true])(
    'refuses an unreachable picked face for preview and submit (creating: %s)',
    async (creating) => {
      const user = userEvent.setup();
      const onSubmit = vi.fn();
      const onPreview = vi.fn();
      const host = picking({
        describe: (target) => ({
          label: 'Wall · face',
          distance: target.faceHash === 7 ? null : 25
        })
      });
      render(
        <ExtrudeForm
          {...base}
          creating={creating}
          submitLabel={creating ? 'Create' : 'Apply'}
          initial={{
            ...initial,
            distance: creating ? 0 : 8,
            endCondition: 'to-face'
          }}
          toFacePicking={host}
          onSubmit={onSubmit}
          onPreview={onPreview}
          onCancel={vi.fn()}
        />
      );
      act(() => host.setterRef.current?.(face));
      expect(
        screen.getByText(/not parallel to the sketch plane, or lies on it/)
      ).toBeInTheDocument();
      expect(onPreview).toHaveBeenLastCalledWith(null);
      expect(
        screen.getByRole('button', { name: creating ? 'Create' : 'Apply' })
      ).toBeDisabled();
      await user.click(screen.getByRole('textbox', { name: 'Name' }));
      await user.keyboard('{Enter}');
      expect(onSubmit).not.toHaveBeenCalled();

      // Re-picking a reachable face restores both preview and submit.
      act(() => host.setterRef.current?.({ ...face, faceHash: 8 }));
      expect(onPreview).toHaveBeenLastCalledWith(
        expect.objectContaining({ endCondition: 'to-face', distance: 25 })
      );
      await user.click(
        screen.getByRole('button', { name: creating ? 'Create' : 'Apply' })
      );
      expect(onSubmit).toHaveBeenCalledOnce();
    }
  );

  it('shows the unresolved state on reopen until a re-pick replaces the face', async () => {
    const host = picking({ unresolved: true });
    render(
      <ExtrudeForm
        {...base}
        initial={{ ...initial, endCondition: 'to-face', toFace: face }}
        toFacePicking={host}
        onSubmit={vi.fn()}
        onCancel={vi.fn()}
      />
    );
    expect(screen.getByText(/Target face is unresolved/)).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Re-pick face' })
    ).toBeInTheDocument();
    // Applying the unchanged, unresolved face cannot succeed.
    expect(screen.getByRole('button', { name: 'Apply' })).toBeDisabled();
    act(() => host.setterRef.current?.({ ...face, faceHash: 8 }));
    expect(screen.queryByText(/Target face is unresolved/)).toBeNull();
    expect(screen.getByRole('button', { name: 'Apply' })).toBeEnabled();
  });

  it('sends a non-zero dormant distance for to-face, whatever zero the field holds', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(
      <ExtrudeForm
        {...base}
        initial={{
          ...initial,
          distance: '0 mm',
          endCondition: 'to-face',
          toFace: face
        }}
        toFacePicking={picking()}
        onSubmit={onSubmit}
        onCancel={vi.fn()}
      />
    );
    await user.click(screen.getByRole('button', { name: 'Apply' }));
    expect(onSubmit).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ endCondition: 'to-face', distance: 1 })
    );
  });

  it('keeps the sign of a reach shorter than the field rounding', () => {
    const host = picking({
      describe: () => ({ label: 'Ledge · face', distance: -2e-7 })
    });
    const onDraft = vi.fn();
    render(
      <ExtrudeForm
        {...base}
        toFacePicking={host}
        onDraft={onDraft}
        onSubmit={vi.fn()}
        onCancel={vi.fn()}
      />
    );
    act(() => host.setterRef.current?.(face));
    const sent = onDraft.mock.lastCall![0] as { distance: ParamValue };
    expect(Number(sent.distance)).toBeLessThan(0);
  });

  it('returns to Distance when the viewport arrow is dragged', async () => {
    const distanceSetterRef: MutableRefObject<
      ((value: ParamValue) => void) | null
    > = { current: null };
    const onDraft = vi.fn();
    render(
      <ExtrudeForm
        {...base}
        initial={{ ...initial, endCondition: 'to-face', toFace: face }}
        toFacePicking={picking()}
        distanceSetterRef={distanceSetterRef}
        onDraft={onDraft}
        onSubmit={vi.fn()}
        onCancel={vi.fn()}
      />
    );
    act(() => distanceSetterRef.current?.(12));
    expect(onDraft).toHaveBeenLastCalledWith(
      expect.objectContaining({ endCondition: 'blind', distance: 12 })
    );
    expect(screen.getByRole('textbox', { name: 'Distance' })).toHaveValue('12');
  });

  it('submits a draft angle, omits a zero one, and refuses it beside a back distance', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(<ExtrudeForm {...base} onSubmit={onSubmit} onCancel={vi.fn()} />);
    const angle = screen.getByRole('textbox', { name: 'Draft angle' });
    expect(angle).toHaveValue('0');
    await user.click(screen.getByRole('button', { name: 'Apply' }));
    expect(onSubmit.mock.lastCall![0]).not.toHaveProperty('draftAngleDeg');
    await user.clear(angle);
    await user.type(angle, '5');
    await user.click(screen.getByRole('button', { name: 'Apply' }));
    expect(onSubmit).toHaveBeenLastCalledWith(
      expect.objectContaining({ draftAngleDeg: 5, distance: -8 })
    );
    const back = screen.getByRole('textbox', { name: 'Back distance' });
    await user.clear(back);
    await user.type(back, '2');
    expect(
      screen.getByText(/clear Back distance to draft it/)
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Apply' })).toBeDisabled();
    await user.clear(angle);
    await user.type(angle, '95');
    expect(
      screen.getByText(/Draft must be between -89° and 89°/)
    ).toBeInTheDocument();
  });

  it('hides the draft for a through-all cut', async () => {
    render(
      <ExtrudeForm
        {...base}
        initial={{
          ...initial,
          operation: 'cut',
          targetBodyId: bodies[0]!.bodyId,
          endCondition: 'through-all',
          throughAllSide: 'forward'
        }}
        onSubmit={vi.fn()}
        onCancel={vi.fn()}
      />
    );
    expect(screen.queryByRole('textbox', { name: 'Draft angle' })).toBeNull();
  });
});
