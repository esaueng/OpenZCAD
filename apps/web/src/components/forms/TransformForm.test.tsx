import { cleanup, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { BodyId } from '@openzcad/shared';
import { MoveOverlay } from '../DirectModelingOverlays';
import { TransformForm } from './FeatureForms';

const zero = { x: 0, y: 0, z: 0 };

/** Visible label and accessible name of every input with a label, in order. */
function fieldNames(root: HTMLElement) {
  return Array.from(root.querySelectorAll('input')).flatMap((input) => {
    const label = input.closest('label')?.querySelector(':scope > span');
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
