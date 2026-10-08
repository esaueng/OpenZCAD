import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { toSketchId } from '@openzcad/shared';
import { ModelingOperationsForm } from './ModelingOperationsForm';

const profiles = ['Lower', 'Upper'].map((label, index) => ({
  id: label.toLowerCase(),
  label,
  section: {
    sketchId: toSketchId(`sketch_${index}`),
    profile: {
      profileId: `profile_${index}`,
      regionFingerprint: index + 1,
      samplePoint: { x: 0, y: 0 },
      sourceArea: 10 + index
    }
  }
}));

describe('Loft card', () => {
  it('lays the apex checkbox out with its label and names each Remove', () => {
    render(
      <ModelingOperationsForm
        operation="loft"
        scope={{}}
        bodies={[]}
        profileOptions={profiles}
        onPreflight={vi.fn()}
        onSubmit={vi.fn()}
      />
    );
    // In a `.field` grid the box took a full-width row of its own.
    const apex = screen.getByRole('checkbox', {
      name: 'Close the last section to an apex point'
    });
    expect(apex.closest('label')).toHaveClass('field-check');
    expect(apex.closest('label')).not.toHaveClass('field');
    expect(
      screen.getByRole('button', { name: 'Remove section 1' })
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Remove section 2' })
    ).toBeInTheDocument();
  });
});

describe('Sweep card with no path sketch', () => {
  it('names the empty path list and says what to do without claiming a failure', () => {
    render(
      <ModelingOperationsForm
        operation="sweep"
        scope={{}}
        bodies={[]}
        profileOptions={profiles.slice(0, 1)}
        pathOptions={[]}
        unsupportedReason="Create a line or arc path sketch"
        onPreflight={vi.fn()}
        onSubmit={vi.fn()}
      />
    );
    expect(screen.getByLabelText('Path sketch')).toHaveDisplayValue(
      'No path sketches yet'
    );
    // Nothing was attempted, so nothing was "Not created".
    expect(screen.getByRole('alert')).toHaveTextContent(
      /^Create a line or arc path sketch\.$/
    );
    expect(screen.queryByText('Choose a profile and a path.')).toBeNull();
    expect(screen.getByRole('button', { name: 'Create sweep' })).toBeDisabled();
  });
});

describe('Enter in a modeling card', () => {
  it('submits from a select, as every other card does', async () => {
    const onPreflight = vi.fn(async () => ({ status: 'ready' as const }));
    render(
      <ModelingOperationsForm
        operation="helical-sweep"
        scope={{}}
        bodies={[]}
        profileOptions={profiles}
        onPreflight={onPreflight}
        onSubmit={vi.fn()}
      />
    );
    const create = screen.getByRole('button', { name: 'Create helical sweep' });
    expect(create).toHaveAttribute('aria-keyshortcuts', 'Enter');
    fireEvent.keyDown(screen.getByLabelText('Profile'), { key: 'Enter' });
    await waitFor(() => expect(onPreflight).toHaveBeenCalledOnce());
  });
});
