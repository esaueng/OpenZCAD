import { createRef, type MutableRefObject } from 'react';
import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import {
  addSketchFeature,
  createProjectDocument,
  extrudeSketch,
  getLatestSketchId,
  listFeaturesInOrder
} from '@openzcad/document-core';
import {
  toBodyId,
  toSketchId,
  toUserId,
  type ExtrudeToFaceTarget,
  type ParamValue
} from '@openzcad/shared';
import {
  ExtrudeCommand,
  extrudeChangedInput,
  extrudeShownValues,
  type ExtrudeCommandHandle,
  type ExtrudeCommandState
} from './ExtrudeCommand';
import type {
  ExtrudeFormValue,
  ExtrudeToFacePicking
} from '../lib/extrudeDraft';

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
  const { rerender } = render(<ExtrudeCommand {...props} />);
  return {
    ...props,
    distanceSetterRef,
    commandRef,
    update: (overrides: Partial<Parameters<typeof ExtrudeCommand>[0]>) =>
      rerender(<ExtrudeCommand {...props} {...overrides} />)
  };
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
  it('names an automatic preview operation and its target outside Options', () => {
    setup({
      initial: { name: 'Extrude', sketchId, distance: 10 },
      resolvedChoice: {
        operation: 'cut',
        targetBodyId: plate,
        reason: 'enclosed',
        tolerance: 1e-6
      }
    });
    expect(screen.getByRole('status')).toHaveTextContent(
      /^Preview: Cut · Plate/
    );
  });

  it('offers to show a hidden Auto Cut while keeping the preview and draft', async () => {
    const user = userEvent.setup();
    const showFullModel = vi.fn();
    const { commandRef, onDraft, onPreview, onSubmit, update } = setup({
      onShowFullModel: showFullModel,
      resolvedChoice: {
        operation: 'cut',
        targetBodyId: plate,
        reason: 'enclosed',
        tolerance: 1e-6
      }
    });
    showFullModel.mockImplementation(() =>
      update({ onShowFullModel: undefined })
    );
    act(() => commandRef.current?.setValue('distance', '2 - thickness'));

    const advisory = 'Section view hides this change';
    const status = screen.getByRole('status');
    expect(status).toHaveAttribute('aria-live', 'polite');
    expect(status).toHaveTextContent(`Preview: Cut · Plate · ${advisory}`);
    expect(within(status).getByText(advisory, { exact: true }).tagName).toBe(
      'SPAN'
    );
    expect(screen.getByText('Preview', { exact: true })).toBeVisible();
    const done = screen.getByRole('button', { name: 'Done' });
    expect(done).toBeEnabled();
    const button = screen.getByRole('button', {
      name: 'Show full model'
    });
    expect(button.closest('details')).toBeNull();
    await user.click(button);

    expect(showFullModel).toHaveBeenCalledOnce();
    expect(status).toHaveTextContent(/^Preview: Cut · Plate/);
    expect(status).not.toHaveTextContent(advisory);
    expect(button).not.toBeInTheDocument();
    expect(commandRef.current?.text('distance')).toBe('2 - thickness');
    expect(onDraft).toHaveBeenCalledOnce();
    expect(onPreview).toHaveBeenCalledOnce();
    expect(onSubmit).not.toHaveBeenCalled();
    await user.click(done);
    expect(onSubmit).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        distance: '2 - thickness',
        choice: { operation: 'automatic' }
      })
    );
  });

  it.each([
    ['a pending preview', { previewPending: true }],
    ['a preview refusal', { note: 'This cut did not produce a valid body.' }],
    [
      'a keypad refusal',
      { entryRefusal: 'Distance: Unexpected end of expression.' }
    ],
    ['a commit lock', { disabled: true }],
    ['a held drag', { onShowFullModel: undefined }]
  ] as const)('withdraws section recovery during %s', (_condition, next) => {
    const showFullModel = vi.fn();
    const { update, onSubmit } = setup({
      initial: { name: 'Extrude', sketchId, distance: -6 },
      onShowFullModel: showFullModel
    });
    const button = screen.getByRole('button', { name: 'Show full model' });
    expect(button).toBeVisible();
    button.focus();
    update(next);
    expect(
      screen.queryByRole('button', { name: 'Show full model' })
    ).toBeNull();
    expect(
      screen.getByRole('group', { name: 'Extrude command' })
    ).toHaveFocus();
    expect(screen.getByRole('status')).not.toHaveTextContent(
      'Section view hides this change'
    );
    expect(showFullModel).not.toHaveBeenCalled();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('shows an operation only after the latest automatic draft has been previewed', () => {
    const cut = {
      operation: 'cut',
      targetBodyId: plate,
      reason: 'enclosed',
      tolerance: 1e-6
    } as const;
    const { commandRef, update } = setup();
    const status = screen.getByRole('status');
    expect(status).toHaveTextContent(/^Auto · Drag the arrows/);

    act(() => commandRef.current?.setValue('distance', '10'));
    update({ resolvedChoice: cut });
    expect(status).toHaveTextContent(/^Preview: Cut · Plate/);

    act(() => commandRef.current?.setValue('distance', '20'));
    update({ resolvedChoice: cut, previewPending: true });
    expect(status).toHaveTextContent('Auto · Checking preview…');
    expect(status).not.toHaveTextContent('Cut · Plate');
    expect(screen.getByText('Checking…', { exact: true })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Done' })).toBeEnabled();

    update({
      resolvedChoice: {
        operation: 'new-body',
        reason: 'no-overlap',
        tolerance: 1e-6
      }
    });
    expect(status).toHaveTextContent(/^Preview: New body/);
  });

  // U11: a value the kernel refuses is said in the bar after the input that
  // must change; the readout of the last built preview returns with a value
  // that builds.
  it('names the input a kernel refusal is about, and keeps it named', () => {
    const cut = {
      operation: 'cut',
      targetBodyId: plate,
      reason: 'enclosed',
      tolerance: 1e-6
    } as const;
    const refusal = 'Extrude preview did not produce an exact result body.';
    const { commandRef, update } = setup({
      initial: { name: 'Extrude', sketchId, distance: -4 },
      resolvedChoice: cut
    });
    const status = screen.getByRole('status');
    expect(status).toHaveTextContent(/^Preview: Cut · Plate/);

    act(() => commandRef.current?.setValue('draftAngle', '40'));
    update({ valueRefusal: refusal });
    expect(status).toHaveTextContent(`Draft angle: ${refusal}`);
    expect(status).not.toHaveTextContent('Preview: Cut');

    // A later change does not take the blame for a refusal it did not cause.
    act(() => commandRef.current?.setValue('distance', '-3'));
    update({ valueRefusal: refusal });
    expect(status).toHaveTextContent(`Draft angle: ${refusal}`);

    // The same refusal again, after the newer value is checked, is its own.
    update({ valueRefusal: null, previewPending: true });
    expect(status).toHaveTextContent('Auto · Checking preview…');
    update({ valueRefusal: refusal });
    expect(status).toHaveTextContent(`Distance: ${refusal}`);

    update({ valueRefusal: null, resolvedChoice: cut });
    expect(status).toHaveTextContent(/^Preview: Cut · Plate/);
  });

  // Review of #1769: the region's arrow sets the distance only on release,
  // so a frame refused under the hand must still be the distance's.
  it('names the distance for a refusal under a held arrow drag', () => {
    const refusal = 'Extrude preview did not produce an exact result body.';
    const { commandRef, update } = setup({
      initial: { name: 'Extrude', sketchId, distance: -4 }
    });
    act(() => commandRef.current?.setValue('draftAngle', '2'));
    act(() => commandRef.current?.holdValue('distance'));
    update({ valueRefusal: refusal });
    expect(screen.getByRole('status')).toHaveTextContent(
      `Distance: ${refusal}`
    );
    expect(commandRef.current?.text('distance')).toBe('-4');
  });

  // #1769 follow-up: the model marks the chip of the value the bar names,
  // not the distance's whatever was refused, and none for an option.
  it('reports the value the bar names a refusal after, for its chip', () => {
    const refusal = 'Extrude preview did not produce an exact result body.';
    const onRefusedValue = vi.fn<(valueId: string | null) => void>();
    const { commandRef, update } = setup({
      initial: { name: 'Extrude', sketchId, distance: -4 },
      onRefusedValue
    });
    const last = () => onRefusedValue.mock.lastCall?.[0];
    expect(last()).toBeNull();

    act(() => commandRef.current?.setValue('draftAngle', '40'));
    update({ onRefusedValue, valueRefusal: refusal });
    expect(last()).toBe('draftAngle');

    // Withdrawn while a newer value is checked: no chip is marked.
    act(() => commandRef.current?.setValue('distance', '-3'));
    update({ onRefusedValue, valueRefusal: null, previewPending: true });
    expect(last()).toBeNull();
    update({ onRefusedValue, valueRefusal: refusal });
    expect(last()).toBe('distance');

    // The bar's own refusal names no value the kernel refused.
    update({
      onRefusedValue,
      valueRefusal: refusal,
      entryRefusal: 'Distance: Unexpected end of expression.'
    });
    expect(last()).toBeNull();
    update({ onRefusedValue, valueRefusal: refusal });
    expect(last()).toBe('distance');
  });

  it('marks no chip for a refusal named after an option', async () => {
    const user = userEvent.setup();
    const refusal = 'Extrude preview did not produce an exact result body.';
    const onRefusedValue = vi.fn<(valueId: string | null) => void>();
    const { update } = setup({
      initial: { name: 'Extrude', sketchId, distance: -4 },
      onRefusedValue
    });
    await openOptions(user);
    await user.click(choice('Operation', 'Cut'));
    update({ onRefusedValue, valueRefusal: refusal });
    expect(screen.getByRole('status')).toHaveTextContent(
      `Operation: ${refusal}`
    );
    expect(onRefusedValue.mock.lastCall?.[0]).toBeNull();
  });

  // #1769 follow-up: an edit's refusal is named as a new extrude's is. Its
  // preview may refuse at once, in the same words as the refusal before:
  // that is the newer change's.
  it('names the input an edit refusal is about, even in the same words', () => {
    const refusal =
      'Extrude 1: Extrude preview did not produce an exact result body.';
    const onPreview = vi.fn((): string | null => null);
    const { commandRef, update } = setup({
      editing: true,
      initial: { name: 'Extrude 1', sketchId, distance: -4 },
      onPreview
    });
    const status = screen.getByRole('status');

    act(() => commandRef.current?.setValue('draftAngle', '40'));
    update({ onPreview, valueRefusal: refusal });
    expect(status).toHaveTextContent(`Draft angle: ${refusal}`);

    onPreview.mockReturnValueOnce(refusal);
    act(() => commandRef.current?.setValue('distance', '-3'));
    update({ onPreview, valueRefusal: refusal });
    expect(status).toHaveTextContent(`Distance: ${refusal}`);
  });

  it('says a kernel refusal plainly when no input has changed, and leaves its own refusals unprefixed', () => {
    const refusal = 'Extrude preview did not produce an exact result body.';
    const { commandRef, update } = setup({
      initial: { name: 'Extrude', sketchId, distance: -4 },
      valueRefusal: refusal
    });
    const status = screen.getByRole('status');
    expect(status).toHaveTextContent(new RegExp(`^${refusal}$`));

    act(() => commandRef.current?.setValue('draftAngle', '40'));
    update({
      valueRefusal: refusal,
      entryRefusal: 'Draft angle: Unexpected end of expression.'
    });
    expect(status).toHaveTextContent(
      /^Draft angle: Unexpected end of expression\.$/
    );
    update({ valueRefusal: refusal, note: 'This cut did not build.' });
    expect(status).toHaveTextContent(/^This cut did not build\.$/);
  });

  it('names the input a change set by the bar label it carries', () => {
    const base = {
      name: 'Extrude',
      distance: '10',
      symmetric: false,
      backDistance: '0',
      choice: { operation: 'automatic' },
      endCondition: 'blind',
      throughAllSide: 'forward',
      faceOffset: '0',
      draftAngle: '0'
    } as const;
    expect(extrudeChangedInput(base, base)).toBeNull();
    expect(extrudeChangedInput(base, { ...base, faceOffset: '2' })).toBe(
      'Offset from face'
    );
    // A value that also leaves an extent or Symmetric is named for itself.
    expect(
      extrudeChangedInput(base, {
        ...base,
        distance: '5',
        endCondition: 'through-all'
      })
    ).toBe('Distance');
    expect(
      extrudeChangedInput(
        { ...base, symmetric: true },
        { ...base, backDistance: '2' }
      )
    ).toBe('Back distance');
    expect(extrudeChangedInput(base, { ...base, draftAngle: '3' })).toBe(
      'Draft angle'
    );
    expect(
      extrudeChangedInput(base, {
        ...base,
        choice: { operation: 'cut', targetBodyId: plate }
      })
    ).toBe('Operation');
    expect(
      extrudeChangedInput(
        { ...base, choice: { operation: 'cut', targetBodyId: plate } },
        {
          ...base,
          choice: { operation: 'cut', targetBodyId: toBodyId('lid') }
        }
      )
    ).toBe('Target body');
    expect(
      extrudeChangedInput(base, { ...base, endCondition: 'through-all' })
    ).toBe('Extent');
    expect(extrudeChangedInput(base, { ...base, throughAllSide: 'both' })).toBe(
      'Direction'
    );
    expect(extrudeChangedInput(base, { ...base, symmetric: true })).toBe(
      'Sides'
    );
  });

  it('keeps an explicit 10 mm New body draft separate from an inferred target', async () => {
    const user = userEvent.setup();
    const { commandRef, onSubmit } = setup({
      resolvedChoice: {
        operation: 'cut',
        targetBodyId: plate,
        reason: 'enclosed',
        tolerance: 1e-6
      },
      previewPending: true
    });
    act(() => commandRef.current?.setValue('distance', '10'));
    await openOptions(user);
    await user.click(choice('Operation', 'New body'));
    expect(screen.getByRole('status')).toHaveTextContent(
      'New body · Checking preview…'
    );
    expect(
      screen.queryByRole('radiogroup', { name: 'Target body' })
    ).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Done' }));
    expect(onSubmit).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        distance: 10,
        choice: { operation: 'new-body' }
      })
    );
  });

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
    // Symmetric drops the back distance, and its row: none is sent (F002).
    await user.click(choice('Sides', 'Symmetric'));
    expect(onPreview).toHaveBeenLastCalledWith(
      expect.objectContaining({ symmetric: true })
    );
    expect(vi.mocked(onPreview).mock.lastCall?.[0]).not.toHaveProperty(
      'backDistance'
    );
    expect(screen.queryByRole('button', { name: 'Back distance' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Reverse direction' }));
    expect(onPreview).toHaveBeenLastCalledWith(
      expect.objectContaining({ distance: -10 })
    );
  });

  // F002: every symmetric create was refused as "both symmetric and
  // two-sided", because the bar sent a zero back distance beside Symmetric.
  it('creates a symmetric extrude the document accepts', async () => {
    const user = userEvent.setup();
    const sketched = addSketchFeature(
      createProjectDocument('Symmetric', toUserId('user_test')),
      {
        name: 'Circle',
        plane: 'XY',
        offset: 0,
        object: { objectKind: 'circle', radius: 5, centerX: 0, centerY: 0 }
      }
    ).document;
    const circleSketch = getLatestSketchId(sketched)!;
    const { distanceSetterRef, onSubmit } = setup({
      initial: { name: 'Extrude', sketchId: circleSketch, distance: 0 }
    });
    act(() => distanceSetterRef.current?.(10));
    await openOptions(user);
    await user.click(choice('Sides', 'Symmetric'));
    await user.click(screen.getByRole('button', { name: 'Done' }));
    expect(onSubmit).toHaveBeenCalledOnce();
    const value = vi.mocked(onSubmit).mock.calls[0]![0] as ExtrudeFormValue;
    expect(value).toEqual(
      expect.objectContaining({ distance: 10, symmetric: true })
    );
    expect(value).not.toHaveProperty('backDistance');
    // What the host then commits: the document takes it, stored symmetric.
    const created = extrudeSketch(sketched, {
      name: value.name,
      sketchId: value.sketchId,
      distance: value.distance,
      symmetric: value.symmetric,
      backDistance: value.backDistance
    }).document;
    expect(listFeaturesInOrder(created).at(-1)!.data).toEqual(
      expect.objectContaining({
        featureKind: 'extrude',
        distance: 10,
        symmetric: true
      })
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
    await user.click(choice('Direction', 'Both'));
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
    // Late keypad and drag events cannot replace the draft being checked.
    act(() => {
      commandRef.current?.setValue('distance', '20');
      distanceSetterRef.current?.(30);
    });
    expect(commandRef.current?.text('distance')).toBe('10');
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

  it('edits a stored extrude: titled for it, its operation kept, its draft published as it opens', async () => {
    const user = userEvent.setup();
    const { onDraft, onSubmit } = setup({
      editing: true,
      note: 'Base corner fillets: a selected edge no longer exists.',
      initial: {
        name: 'Post',
        sketchId,
        distance: 'thickness',
        operation: 'cut',
        targetBodyId: plate
      }
    });
    expect(
      screen.getByRole('group', { name: 'Edit Post command' })
    ).toBeVisible();
    // The handles stand on what is stored before anything changes.
    expect(onDraft).toHaveBeenCalledOnce();
    const [opened] = vi.mocked(onDraft).mock.calls[0] as [ExtrudeCommandState];
    expect(opened.distance).toBe(8);
    expect(opened.texts.distance).toBe('thickness');
    expect(opened.value.choice).toEqual({
      operation: 'cut',
      targetBodyId: plate
    });
    // A refusal from the last preview or Done is said in the bar.
    expect(
      screen.getByText('Base corner fillets: a selected edge no longer exists.')
    ).toBeVisible();
    await user.click(screen.getByLabelText('Edit Post options'));
    expect(choice('Operation', 'Cut')).toHaveAttribute('aria-checked', 'true');
    expect(
      within(screen.getByRole('radiogroup', { name: 'Operation' })).queryByRole(
        'radio',
        { name: 'Auto' }
      )
    ).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Done' }));
    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'Post',
        distance: 'thickness',
        choice: { operation: 'cut', targetBodyId: plate }
      })
    );
  });

  it('cancels from its Cancel button', async () => {
    const user = userEvent.setup();
    const { onCancel } = setup();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onCancel).toHaveBeenCalledOnce();
  });
});
