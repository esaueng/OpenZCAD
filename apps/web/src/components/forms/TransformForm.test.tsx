import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { BodyId } from '@openzcad/shared';
import { MoveOverlay } from '../MoveOverlay';
import { TransformForm } from './FeatureForms';

const zero = { x: 0, y: 0, z: 0 };

/** Visible label and accessible name of every input with a label, in order. */
function fieldNames(root: HTMLElement) {
  return Array.from(root.querySelectorAll('input')).flatMap((input) => {
    // The Move card wraps each input in its label; an expression field's
    // label points at its input from beside it (`for`).
    const label =
      input.closest('label')?.querySelector(':scope > span') ??
      Array.from(root.querySelectorAll('label')).find(
        (candidate) => input.id !== '' && candidate.htmlFor === input.id
      );
    return label
      ? [{ label: label.textContent, name: input.getAttribute('aria-label') }]
      : [];
  });
}

describe('Move edit card labels (F19)', () => {
  it('names the translation and rotation fields as the Move create card does', () => {
    const { container: create } = render(
      <MoveOverlay
        bodyName="Box"
        values={{ translation: zero, rotationDeg: zero }}
        units="mm"
        snap={null}
        onChange={() => {}}
        onConfirm={() => {}}
        onCancel={() => {}}
      />
    );
    const created = fieldNames(create).filter((field) =>
      /^[dr][XYZ]$/.test(field.label ?? '')
    );
    expect(created).toHaveLength(6);
    cleanup();

    const { container: edit } = render(
      <TransformForm
        scope={{}}
        bodies={[{ bodyId: 'body-1' as BodyId, name: 'Box', consumed: false }]}
        units="mm"
        initial={{
          name: 'Move',
          targetBodyId: 'body-1' as BodyId,
          translation: { x: 10, y: 0, z: 0 },
          rotationDeg: zero
        }}
        submitLabel="Apply"
        onSubmit={vi.fn()}
      />
    );
    const edited = fieldNames(edit).filter((field) =>
      /^[dr][XYZ]$/.test(field.label ?? '')
    );
    expect(edited).toEqual(created);
    expect(screen.queryByText('Move X')).toBeNull();
    expect(screen.getByRole('textbox', { name: 'Move X in mm' })).toHaveValue(
      '10'
    );
    // Scale has no gizmo to match and keeps its own label.
    expect(screen.getByRole('textbox', { name: 'Scale ×' })).toHaveValue('1');
  });
});

describe('Move pivot (M10)', () => {
  const bodies = [{ bodyId: 'body-1' as BodyId, name: 'Box', consumed: false }];

  it('keeps the pivot the gizmo wrote through an edit', () => {
    const onSubmit = vi.fn();
    render(
      <TransformForm
        scope={{}}
        bodies={bodies}
        units="mm"
        initial={{
          name: 'Move',
          targetBodyId: 'body-1' as BodyId,
          translation: zero,
          rotationDeg: { x: 0, y: 0, z: 90 },
          pivot: { x: 10, y: 5, z: 5 }
        }}
        submitLabel="Apply"
        onSubmit={onSubmit}
      />
    );
    expect(screen.getByRole('textbox', { name: 'Pivot X in mm' })).toHaveValue(
      '10'
    );
    fireEvent.change(
      screen.getByRole('textbox', { name: 'Rotate Z in degrees' }),
      {
        target: { value: '180' }
      }
    );
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        rotationDeg: { x: 0, y: 0, z: 180 },
        pivot: { x: 10, y: 5, z: 5 }
      })
    );
  });

  it('stores no pivot when it is left at the origin', () => {
    const onSubmit = vi.fn();
    render(
      <TransformForm
        scope={{}}
        bodies={bodies}
        units="mm"
        submitLabel="Create"
        onSubmit={onSubmit}
      />
    );
    fireEvent.change(screen.getByRole('textbox', { name: 'Move X in mm' }), {
      target: { value: '4' }
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    expect(onSubmit.mock.calls[0]![0]).not.toHaveProperty('pivot');
  });
});

describe('Move copy (M10)', () => {
  const bodies = [{ bodyId: 'body-1' as BodyId, name: 'Box', consumed: false }];

  it('creates a copy when the box is ticked, and a plain Move otherwise', () => {
    const onSubmit = vi.fn();
    render(
      <TransformForm
        scope={{}}
        bodies={bodies}
        units="mm"
        submitLabel="Create"
        onSubmit={onSubmit}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    expect(onSubmit.mock.calls[0]![0]).not.toHaveProperty('copy');
    fireEvent.click(
      screen.getByRole('checkbox', { name: 'Copy (keep the original)' })
    );
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    expect(onSubmit.mock.calls[1]![0]).toMatchObject({ copy: true });
  });

  it('names an existing copy instead of offering the toggle', () => {
    render(
      <TransformForm
        scope={{}}
        bodies={bodies}
        units="mm"
        initial={{
          name: 'Copy',
          targetBodyId: 'body-1' as BodyId,
          translation: zero,
          rotationDeg: zero,
          copy: true
        }}
        submitLabel="Apply"
        onSubmit={() => {}}
      />
    );
    expect(screen.queryByRole('checkbox')).toBeNull();
    expect(
      screen.getByText('Copy: the source body stays in place.')
    ).toBeTruthy();
  });
});

describe('Move gizmo card copy (M10)', () => {
  it('offers Copy for a body, applies a copy in place, and hides it for a sketch', () => {
    const onCopy = vi.fn();
    const onConfirm = vi.fn();
    const { rerender } = render(
      <MoveOverlay
        bodyName="Box"
        values={{ translation: zero, rotationDeg: zero }}
        units="mm"
        snap={null}
        copy={false}
        onCopy={onCopy}
        onChange={() => {}}
        onConfirm={onConfirm}
        onCancel={() => {}}
      />
    );
    // Nothing to move yet: a plain Move cannot apply.
    expect(screen.getByRole('button', { name: 'Apply move' })).toBeDisabled();
    fireEvent.click(
      screen.getByRole('checkbox', { name: 'Copy (keep the original)' })
    );
    expect(onCopy).toHaveBeenCalledWith(true);
    rerender(
      <MoveOverlay
        bodyName="Box"
        values={{ translation: zero, rotationDeg: zero }}
        units="mm"
        snap={null}
        copy
        onCopy={onCopy}
        onChange={() => {}}
        onConfirm={onConfirm}
        onCancel={() => {}}
      />
    );
    // A copy in place is a coincident duplicate, which is a real result.
    fireEvent.click(screen.getByRole('button', { name: 'Apply copy' }));
    expect(onConfirm).toHaveBeenCalledOnce();
    rerender(
      <MoveOverlay
        bodyName="Sketch 1"
        values={{ translation: zero, rotationDeg: zero }}
        units="mm"
        snap={null}
        hideRotation
        onChange={() => {}}
        onConfirm={onConfirm}
        onCancel={() => {}}
      />
    );
    expect(screen.queryByRole('checkbox')).toBeNull();
  });
});

describe('Move edit card field types (F05)', () => {
  it('reads moves and the pivot as lengths and turns as angles', () => {
    const onSubmit = vi.fn();
    render(
      <TransformForm
        scope={{}}
        bodies={[{ bodyId: 'body-1' as BodyId, name: 'Box', consumed: false }]}
        units="mm"
        initial={{
          name: 'Move',
          targetBodyId: 'body-1' as BodyId,
          translation: zero,
          rotationDeg: zero
        }}
        submitLabel="Apply"
        onSubmit={onSubmit}
      />
    );
    const apply = screen.getByRole('button', { name: 'Apply' });
    const pivotX = screen.getByLabelText('Pivot X in mm');
    // A length with its unit is a length here...
    fireEvent.change(pivotX, { target: { value: '10 mm' } });
    expect(apply).toBeEnabled();
    // ...and an angle is not, though it evaluates to a number.
    fireEvent.change(pivotX, { target: { value: '30 deg' } });
    expect(apply).toBeDisabled();
    fireEvent.change(pivotX, { target: { value: '1 cm' } });
    fireEvent.change(screen.getByLabelText('Rotate Z in degrees'), {
      target: { value: '1 rad' }
    });
    expect(apply).toBeEnabled();
    fireEvent.change(screen.getByLabelText('Move X in mm'), {
      target: { value: '30 deg' }
    });
    expect(apply).toBeDisabled();
  });
});
