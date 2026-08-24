import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ToolCard } from './ToolCard';

describe('ToolCard', () => {
  it('renders an unavailable face-sketch action with its exact reason', async () => {
    const onAction = vi.fn();
    render(
      <ToolCard
        model={{
          icon: 'offset-face',
          title: 'Offset Face',
          hint: 'Drag the arrow to offset the face.',
          phase: 'armed',
          actions: [
            {
              id: 'offset-face',
              label: 'Offset Face',
              active: true,
              enabled: true
            },
            {
              id: 'sketch-on-face',
              label: 'Sketch',
              active: false,
              enabled: false,
              disabledReason:
                'This edited face has no stable topology reference.'
            }
          ]
        }}
        onAction={onAction}
        onClose={() => undefined}
      />
    );

    const sketch = screen.getByRole('tab', {
      name: /Sketch: This edited face has no stable topology reference/
    });
    expect(sketch).toBeDisabled();
    await userEvent.click(sketch);
    expect(onAction).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole('tab', { name: 'Offset Face' }));
    expect(onAction).toHaveBeenCalledWith('offset-face');
  });

  it('offers the feature a refusal named as the way out of it', async () => {
    // The recorded failure told the user to go and edit an earlier fillet and
    // left them to find it. The rejection knows which feature refused.
    const onEditCulprit = vi.fn();
    render(
      <ToolCard
        model={{
          icon: 'fillet',
          title: 'Fillet',
          hint: 'Adjust the value and try again.',
          phase: 'failed',
          error: {
            message: 'Fillet could not be created on 1 selected edge.',
            detail: 'Feature "Lower rim fillet": BRepFilletAPI reported 0 faces.',
            culprit: {
              featureId: 'feat_lower_rim',
              featureName: 'Lower rim fillet'
            }
          }
        }}
        onEditCulprit={onEditCulprit}
        onClose={vi.fn()}
      />
    );

    // The cause leads; the kernel's own words wait behind a disclosure.
    expect(
      screen.getByText('Fillet could not be created on 1 selected edge.')
    ).toBeTruthy();
    expect(screen.getByText('Details')).toBeTruthy();

    await userEvent.click(
      screen.getByRole('button', { name: 'Edit Lower rim fillet' })
    );
    expect(onEditCulprit).toHaveBeenCalledWith('feat_lower_rim');
  });

  it('states a refusal plainly when nothing names a way out', async () => {
    render(
      <ToolCard
        model={{
          icon: 'offset-face',
          title: 'Offset Face',
          hint: 'Adjust the value and try again.',
          phase: 'failed',
          error: { message: 'The offset removed the whole body.' }
        }}
        onClose={vi.fn()}
      />
    );
    expect(screen.getByRole('alert').textContent).toBe(
      'The offset removed the whole body.'
    );
    expect(screen.queryByText('Details')).toBeNull();
  });
});
