import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ToolCard } from './ToolCard';

describe('ToolCard', () => {
  it("offers a region's other tools, open while its check runs", async () => {
    const onVerb = vi.fn();
    render(
      <ToolCard
        model={{
          icon: 'extrude',
          title: 'Extrude',
          eyebrow: 'create',
          hint: 'Drag the region to pull it into a solid.',
          phase: 'validating'
        }}
        cancelableWhileValidating
        verbs={[
          {
            id: 'tool:revolve',
            label: 'Revolve',
            title: 'Revolve',
            disabled: false,
            pressed: false
          },
          {
            id: 'tool:sweep',
            label: 'Sweep',
            title: 'Needs a path',
            disabled: true,
            pressed: false
          }
        ]}
        onVerb={onVerb}
        onClose={vi.fn()}
      />
    );
    await userEvent.click(
      screen.getByRole('button', { name: 'Selection: Revolve' })
    );
    expect(onVerb).toHaveBeenCalledWith('tool:revolve');
    expect(
      screen.getByRole('button', { name: 'Selection: Sweep' })
    ).toBeDisabled();
  });

  it('offers all-edge selection beside the active fillet and locks it during validation', async () => {
    const select = vi.fn();
    const model = {
      icon: 'fillet' as const,
      title: 'Fillet',
      eyebrow: 'create' as const,
      hint: 'Drag the handle.',
      phase: 'armed' as const
    };
    const { rerender } = render(
      <ToolCard
        model={model}
        selectAllEdges={{ count: 12, select }}
        onClose={vi.fn()}
      />
    );
    await userEvent.click(
      screen.getByRole('button', { name: 'Select all 12 edges' })
    );
    expect(select).toHaveBeenCalledOnce();
    rerender(
      <ToolCard
        model={{ ...model, phase: 'validating' }}
        selectAllEdges={{ count: 12, select }}
        onClose={vi.fn()}
      />
    );
    expect(
      screen.getByRole('button', { name: 'Select all 12 edges' })
    ).toBeDisabled();
  });
  it('keeps a geometry caveat out of the hint and exposes it from a badge', () => {
    render(
      <ToolCard
        model={{
          icon: 'offset-face',
          title: 'Offset Face',
          eyebrow: 'direct',
          hint: 'Drag the arrow to offset the face.',
          badge: {
            label: 'Geometry-anchored',
            detail: 'This face will need re-picking if earlier geometry moves.'
          }
        }}
        onClose={vi.fn()}
      />
    );

    expect(screen.getByText('Drag the arrow to offset the face.')).toBeTruthy();
    expect(screen.queryByText(/need re-picking/)).toBeNull();
    const badge = screen.getByLabelText('Geometry-anchored');
    expect(badge).not.toHaveAttribute('title');
    fireEvent.focus(badge);
    expect(screen.getByRole('tooltip')).toHaveTextContent(
      'Geometry-anchoredThis face will need re-picking if earlier geometry moves.'
    );
  });

  it('reduces an active drag to a compact status marker', () => {
    render(
      <ToolCard
        model={{
          icon: 'offset-face',
          title: 'Offset Face',
          eyebrow: 'direct',
          hint: 'Drag the arrow to offset the face.',
          phase: 'dragging',
          badge: {
            label: 'Geometry-anchored',
            detail: 'This face will need re-picking if earlier geometry moves.'
          },
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
              enabled: true
            }
          ]
        }}
        onClose={vi.fn()}
      />
    );

    const card = screen.getByRole('region', {
      name: 'Offset Face operation'
    });
    expect(card).toHaveClass('phase-dragging');
    expect(screen.getByLabelText('Dragging')).toBeTruthy();
    expect(screen.queryByText('Dragging')).toBeNull();
  });

  it('renders an unavailable face-sketch action with its exact reason', async () => {
    const onAction = vi.fn();
    render(
      <ToolCard
        model={{
          icon: 'offset-face',
          title: 'Offset Face',
          eyebrow: 'direct',
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

    const sketch = screen.getByRole('button', {
      name: /Sketch: This edited face has no stable topology reference/
    });
    expect(sketch).toBeDisabled();
    await userEvent.click(sketch);
    expect(onAction).not.toHaveBeenCalled();

    const offset = screen.getByRole('button', { name: 'Offset Face' });
    expect(offset).toHaveAttribute('aria-pressed', 'true');
    expect(sketch).toHaveAttribute('aria-pressed', 'false');
    await userEvent.click(offset);
    expect(onAction).toHaveBeenCalledWith('offset-face');
  });

  it('offers the feature a refusal named as the way out of it', async () => {
    // The recorded failure told the user to go and edit an earlier fillet and
    // left them to find it. The rejection knows which feature refused.
    const onEditCulprit = vi.fn();
    const onViewDetails = vi.fn();
    render(
      <ToolCard
        model={{
          icon: 'fillet',
          title: 'Fillet',
          eyebrow: 'create',
          hint: 'Adjust the value and try again.',
          phase: 'failed',
          error: {
            message: 'Fillet could not be created on 1 selected edge.',
            detail:
              'Feature "Lower rim fillet": BRepFilletAPI reported 0 faces.',
            culprit: {
              featureId: 'feat_lower_rim',
              featureName: 'Lower rim fillet'
            }
          }
        }}
        onEditCulprit={onEditCulprit}
        onViewDetails={onViewDetails}
        onClose={vi.fn()}
      />
    );

    // The cause leads; the kernel's own words stay out of the compact card.
    expect(
      screen.getByText('Fillet could not be created on 1 selected edge.')
    ).toBeTruthy();
    expect(screen.queryByText(/BRepFilletAPI/)).toBeNull();

    await userEvent.click(screen.getByRole('button', { name: 'View details' }));
    expect(onViewDetails).toHaveBeenCalledOnce();

    await userEvent.click(
      screen.getByRole('button', { name: 'Edit Lower rim fillet' })
    );
    expect(onEditCulprit).toHaveBeenCalledWith('feat_lower_rim');
  });

  it('offers to keep the last value that built after a refusal', async () => {
    // Releasing on a refused value leaves the model at the last passing
    // preview; the card can commit that instead of sending the hand back.
    const keep = vi.fn();
    render(
      <ToolCard
        model={{
          icon: 'offset-face',
          title: 'Offset Face',
          eyebrow: 'direct',
          hint: 'Adjust the value and try again.',
          phase: 'failed',
          error: { message: 'The offset removed the whole body.' }
        }}
        keepLastValid={{ label: 'Keep 8.4 mm', keep }}
        onClose={vi.fn()}
      />
    );
    await userEvent.click(screen.getByRole('button', { name: 'Keep 8.4 mm' }));
    expect(keep).toHaveBeenCalledTimes(1);
  });

  it('states a refusal plainly when nothing names a way out', async () => {
    render(
      <ToolCard
        model={{
          icon: 'offset-face',
          title: 'Offset Face',
          eyebrow: 'direct',
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
    expect(screen.queryByText('View details')).toBeNull();
  });
});

describe('pending extrusion cancellation', () => {
  it('keeps Dismiss available while a cancellable extrusion is validating', async () => {
    const onClose = vi.fn();
    render(
      <ToolCard
        model={{
          icon: 'extrude',
          title: 'Extrude',
          eyebrow: 'create',
          hint: 'Checking geometry…',
          phase: 'validating'
        }}
        cancelableWhileValidating
        onClose={onClose}
      />
    );
    await userEvent
      .setup()
      .click(screen.getByRole('button', { name: 'Dismiss Extrude' }));
    expect(onClose).toHaveBeenCalledOnce();
  });
});

describe('validating indicator', () => {
  it('runs the orbit ring in the badge only while validating', () => {
    const model = {
      icon: 'fillet' as const,
      title: 'Edit Fillet',
      eyebrow: 'edit' as const,
      hint: 'Checking geometry…'
    };
    const { container, rerender } = render(
      <ToolCard model={{ ...model, phase: 'validating' }} onClose={vi.fn()} />
    );
    const badge = container.querySelector('.tool-card-phase')!;
    expect(badge).toHaveTextContent('Validating');
    expect(badge.querySelector('.tool-card-orbit')).not.toBeNull();

    rerender(
      <ToolCard model={{ ...model, phase: 'failed' }} onClose={vi.fn()} />
    );
    expect(container.querySelector('.tool-card-orbit')).toBeNull();
  });
});

describe('header', () => {
  /*
    The 11 Oct 2026 review (G8): the region Extrude card drew an icon tile, a
    "Ready" badge, a subtitle and a bare ×, while the Box, Hole, Fillet and
    Union cards beside it wore a title, an eyebrow and a boxed close button.
  */
  it('wears the command-card header: title, eyebrow and the shared close', async () => {
    const onClose = vi.fn();
    const { container } = render(
      <ToolCard
        model={{
          icon: 'extrude',
          title: 'Extrude',
          eyebrow: 'create',
          hint: 'Drag the region to pull it into a solid.',
          phase: 'armed'
        }}
        onClose={onClose}
      />
    );
    const card = screen.getByRole('region', { name: 'Extrude operation' });
    expect(card.querySelector('.panel-header h2')).toHaveTextContent('Extrude');
    expect(card.querySelector('.panel-eyebrow')).toHaveTextContent(
      'New feature'
    );
    const close = screen.getByRole('button', { name: 'Dismiss Extrude' });
    expect(close).toHaveClass('icon-button', 'panel-close');
    await userEvent.click(close);
    expect(onClose).toHaveBeenCalledOnce();
    // Armed is the resting state: no "Ready" badge says so, and no icon
    // tile stands before the title.
    expect(screen.queryByText('Ready')).toBeNull();
    expect(container.querySelector('.tool-card-phase')).toBeNull();
    expect(container.querySelector('.tool-card-icon')).toBeNull();
  });

  it.each([
    ['direct', 'Direct edit'],
    ['edit', 'Edit feature']
  ] as const)('names a %s card with its eyebrow', (eyebrow, text) => {
    render(
      <ToolCard
        model={{ icon: 'offset-face', title: 'Offset Face', eyebrow, hint: '' }}
        onClose={vi.fn()}
      />
    );
    expect(
      screen
        .getByRole('region', { name: 'Offset Face operation' })
        .querySelector('.panel-eyebrow')
    ).toHaveTextContent(text);
  });
});
