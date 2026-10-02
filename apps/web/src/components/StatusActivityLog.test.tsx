import { createRef } from 'react';
import { render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { StatusActivityLog } from './StatusActivityLog';

describe('StatusActivityLog', () => {
  it('keeps the full diagnostic with its compact status entry', () => {
    render(
      <StatusActivityLog
        id="test-activity-log"
        open
        status="Parameter height was not changed."
        detail="move-face would change topology at face 9"
        tone="warning"
        triggerRef={createRef<HTMLButtonElement>()}
        onClose={vi.fn()}
      />
    );

    expect(screen.getByText('Parameter height was not changed.')).toBeTruthy();
    expect(
      screen.getByText('move-face would change topology at face 9')
    ).toHaveClass('status-log-detail');
  });

  it('logs a message set while the geometry line is up, not only the line', () => {
    const props = {
      id: 'test-activity-log',
      open: true,
      triggerRef: createRef<HTMLButtonElement>(),
      onClose: vi.fn()
    };
    const { rerender } = render(
      <StatusActivityLog
        {...props}
        status="Offline workspace"
        geometryStatus="Starting geometry worker · no exact projection is available yet"
        tone="running"
      />
    );
    rerender(
      <StatusActivityLog
        {...props}
        status="Cannot use Box: This shared project is read-only."
        geometryStatus="Starting geometry worker · no exact projection is available yet"
        tone="running"
      />
    );
    // The geometry settling changes the tone, but is not the message again.
    rerender(
      <StatusActivityLog
        {...props}
        status="Cannot use Box: This shared project is read-only."
        geometryStatus={null}
        tone="ready"
      />
    );

    const log = screen.getByRole('region', { name: 'Activity log' });
    const messages = within(log)
      .getAllByRole('listitem')
      .map((item) => item.textContent ?? '');
    expect(messages).toHaveLength(3);
    expect(messages[0]).toContain('Offline workspace');
    expect(messages[1]).toContain('Starting geometry worker');
    expect(messages[2]).toContain(
      'Cannot use Box: This shared project is read-only.'
    );
  });
});
