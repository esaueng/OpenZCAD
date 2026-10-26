import { createRef, type MutableRefObject } from 'react';
import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import {
  toBodyId,
  toSketchId,
  type ExtrudeToFaceTarget,
  type ParamValue
} from '@openzcad/shared';
import {
  ExtrudeCommand,
  extrudeShownValues,
  type ExtrudeCommandHandle
} from './ExtrudeCommand';
import type { ExtrudeToFacePicking } from '../lib/extrudeDraft';

const sketchId = toSketchId('layout');
const plate = toBodyId('plate');

function setup(overrides: Partial<Parameters<typeof ExtrudeCommand>[0]> = {}) {
  const distanceSetterRef = createRef<
    (value: ParamValue) => void
  >() as MutableRefObject<((value: ParamValue) => void) | null>;
  const commandRef = createRef<ExtrudeCommandHandle>();
  const props = {
    scope: { thickness: 8 },
    units: 'mm' as const,
    bodies: [{ bodyId: plate, name: 'Plate' }],
    initial: { name: 'Extrude', sketchId, distance: 0 },
    profileCount: 1,
    disabled: false,
    distanceSetterRef,
    commandRef,
    onOpenValue: vi.fn(),
    onDraft: vi.fn(),
    onPreview: vi.fn(),
    onSubmit: vi.fn(),
    onCancel: vi.fn(),
    ...overrides
  };
  render(<ExtrudeCommand {...props} />);
  return { ...props, distanceSetterRef, commandRef };
}

async function openOptions(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByLabelText('Extrude options'));
}

function choice(group: string, label: string) {
  return within(screen.getByRole('radiogroup', { name: group })).getByRole(
    'radio',
    { name: label }
  );
}

describe('in-place Extrude bar', () => {
  it('finishes only once the arrow sets a distance, then creates that draft', async () => {
    const user = userEvent.setup();
    const { distanceSetterRef, commandRef, onSubmit, onPreview } = setup();
    const done = screen.getByRole('button', { name: 'Done' });
    expect(done).toBeDisabled();
    expect(commandRef.current?.submit()).toBe(false);
    act(() => distanceSetterRef.current?.(12));
    expect(onPreview).toHaveBeenLastCalledWith(
      expect.objectContaining({ distance: 12, endCondition: 'blind' })
    );
    expect(done).toBeEnabled();
    await user.click(done);
    expect(onSubmit).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        name: 'Extrude',
        distance: 12,
        symmetric: false,
        backDistance: 0,
        choice: { operation: 'automatic' }
      })
    );
  });

  it('keeps every card setting under Options: operation, target, sides, values, Reverse', async () => {
    const user = userEvent.setup();
    const { distanceSetterRef, commandRef, onPreview, onOpenValue } = setup();
    act(() => distanceSetterRef.current?.(10));
    await openOptions(user);
    await user.click(choice('Operation', 'Cut'));
    expect(choice('Target body', 'Plate')).toHaveAttribute(
      'aria-checked',
      'true'
    );
    expect(onPreview).toHaveBeenLastCalledWith(
      expect.objectContaining({
        choice: { operation: 'cut', targetBodyId: plate }
      })
    );
    // Values open the keypad; a typed expression is kept as typed.
    await user.click(screen.getByRole('button', { name: 'Back distance' }));
    expect(onOpenValue).toHaveBeenCalledWith(
      'backDistance',
      expect.any(Object)
    );
    act(() => commandRef.current?.setValue('backDistance', 'thickness / 2'));
    expect(onPreview).toHaveBeenLastCalledWith(
      expect.objectContaining({ backDistance: 'thickness / 2' })
    );
    // Symmetric drops the back distance, and its row.
    await user.click(choice('Sides', 'Symmetric'));
    expect(onPreview).toHaveBeenLastCalledWith(
      expect.objectContaining({ symmetric: true, backDistance: 0 })
    );
    expect(screen.queryByRole('button', { name: 'Back distance' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Reverse direction' }));
    expect(onPreview).toHaveBeenLastCalledWith(
      expect.objectContaining({ distance: -10 })
    );
  });

  it('refuses a draft beside Symmetric by name and holds Done', async () => {
    const user = userEvent.setup();
    const { distanceSetterRef, commandRef } = setup();
    act(() => distanceSetterRef.current?.(10));
    await openOptions(user);
    await user.click(choice('Sides', 'Symmetric'));
    act(() => commandRef.current?.setValue('draftAngle', '4'));
    expect(
      screen.getByText(
        'Draft tapers a one-sided extrusion; turn off Symmetric to draft it.'
      )
    ).toBeVisible();
    expect(screen.getByRole('button', { name: 'Done' })).toBeDisabled();
  });

  it('offers Through all on Cut only, with its direction, and no draft', async () => {
    const user = userEvent.setup();
    const { distanceSetterRef, onSubmit } = setup();
    act(() => distanceSetterRef.current?.(10));
    await openOptions(user);
    expect(screen.queryByRole('radiogroup', { name: 'Extent' })).toBeNull();
    await user.click(choice('Operation', 'Cut'));
    await user.click(choice('Extent', 'Through all'));
    await user.click(choice('Direction', 'Both sides'));
    expect(screen.queryByRole('button', { name: 'Draft angle' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Done' }));
    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        endCondition: 'through-all',
        throughAllSide: 'both'
      })
    );
  });

  it('arms the face pick for To face and creates up to the picked face', async () => {
    const user = userEvent.setup();
    const target = { type: 'face' } as unknown as ExtrudeToFaceTarget;
    const onPick = vi.fn();
    const setterRef = createRef<
      (target: ExtrudeToFaceTarget) => void
    >() as MutableRefObject<((target: ExtrudeToFaceTarget) => void) | null>;
    const toFacePicking: ExtrudeToFacePicking = {
      armed: false,
      onPick,
      cancel: vi.fn(),
      describe: () => ({ label: 'Ceiling', distance: 6 }),
      setterRef
    };
    const { onSubmit } = setup({ toFacePicking });
    await openOptions(user);
    await user.click(choice('Extent', 'To face'));
    expect(onPick).toHaveBeenCalledOnce();
    act(() => setterRef.current?.(target));
    expect(screen.getByText(/Up to Ceiling/)).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Done' }));
    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        endCondition: 'to-face',
        toFace: target,
        distance: 6
      })
    );
  });

  it('locks the draft a Done is checking: nothing but Cancel changes it', async () => {
    const user = userEvent.setup();
    const distanceSetterRef = createRef<
      (value: ParamValue) => void
    >() as MutableRefObject<((value: ParamValue) => void) | null>;
    const commandRef = createRef<ExtrudeCommandHandle>();
    const onPreview = vi.fn();
    const onCancel = vi.fn();
    const props = {
      scope: {},
      units: 'mm' as const,
      bodies: [{ bodyId: plate, name: 'Plate' }],
      initial: { name: 'Extrude', sketchId, distance: 0 },
      profileCount: 1,
      distanceSetterRef,
      commandRef,
      onOpenValue: vi.fn(),
      onDraft: vi.fn(),
      onPreview,
      onSubmit: vi.fn(),
      onCancel
    };
    const { rerender } = render(<ExtrudeCommand {...props} disabled={false} />);
    act(() => distanceSetterRef.current?.(10));
    // Done pressed: App holds the bar disabled while it validates.
    rerender(<ExtrudeCommand {...props} disabled />);
    onPreview.mockClear();
    await openOptions(user);
    expect(choice('Operation', 'Cut')).toBeDisabled();
    expect(
      screen.getByRole('button', { name: 'Reverse direction' })
    ).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Distance' })).toBeDisabled();
    // A keypad left open across the Done commits nothing either.
    act(() => commandRef.current?.setValue('distance', '20'));
    expect(onPreview).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Done' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it('holds Done while the open keypad holds an entry that does not evaluate', () => {
    const { distanceSetterRef, commandRef, onSubmit } = setup({
      entryRefusal: 'Distance: Unexpected end of expression.'
    });
    act(() => distanceSetterRef.current?.(10));
    expect(screen.getByRole('button', { name: 'Done' })).toBeDisabled();
    expect(
      screen.getByText('Distance: Unexpected end of expression.')
    ).toBeVisible();
    // Nor does Enter create the last valid value behind it.
    expect(commandRef.current?.submit()).toBe(false);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('offers each value only where the extent takes it', () => {
    expect(extrudeShownValues({ extent: 'blind', symmetric: false })).toEqual([
      'distance',
      'backDistance',
      'draftAngle'
    ]);
    expect(extrudeShownValues({ extent: 'blind', symmetric: true })).toEqual([
      'distance',
      'draftAngle'
    ]);
    expect(extrudeShownValues({ extent: 'to-face', symmetric: false })).toEqual(
      ['draftAngle']
    );
    expect(
      extrudeShownValues({ extent: 'through-all', symmetric: false })
    ).toEqual([]);
  });

  it('cancels from its Cancel button', async () => {
    const user = userEvent.setup();
    const { onCancel } = setup();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onCancel).toHaveBeenCalledOnce();
  });
});
