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
});
