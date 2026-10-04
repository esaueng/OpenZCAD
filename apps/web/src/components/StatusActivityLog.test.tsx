import { createRef } from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { StatusActivityLog } from './StatusActivityLog';

describe('StatusActivityLog', () => {
  it('keeps the full diagnostic with its compact status entry', async () => {
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

    expect(
      await screen.findByText('Parameter height was not changed.')
    ).toBeTruthy();
    expect(
      screen.getByText('move-face would change topology at face 9')
    ).toHaveClass('status-log-detail');
  });

  it('logs a message set while the geometry line is up, not only the line', async () => {
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
        geometryStatus="Starting geometry worker · the model appears when it is ready"
        tone="running"
      />
    );
    rerender(
      <StatusActivityLog
        {...props}
        status="Cannot use Box: This shared project is read-only."
        geometryStatus="Starting geometry worker · the model appears when it is ready"
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

    const log = await screen.findByRole('region', { name: 'Activity log' });
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

  it('leaves a lane-only message out of the log', async () => {
    const props = {
      id: 'test-activity-log',
      open: true,
      tone: 'ready' as const,
      triggerRef: createRef<HTMLButtonElement>(),
      onClose: vi.fn()
    };
    const { rerender } = render(
      <StatusActivityLog {...props} status="Added box." />
    );
    // A workspace switch says where the user is, not what the model did.
    rerender(
      <StatusActivityLog
        {...props}
        status="Build mode · modeling tools are back."
        logged={false}
      />
    );
    rerender(<StatusActivityLog {...props} status="Added cylinder." />);

    const log = await screen.findByRole('region', { name: 'Activity log' });
    const messages = within(log)
      .getAllByRole('listitem')
      .map((item) => item.textContent ?? '');
    expect(messages).toHaveLength(2);
    expect(messages[0]).toContain('Added box.');
    expect(messages[1]).toContain('Added cylinder.');
    expect(log).not.toHaveTextContent('Build mode');
  });

  it('closes on Escape before the workspace sees the key', async () => {
    const onClose = vi.fn();
    const workspaceEscape = vi.fn();
    window.addEventListener('keydown', workspaceEscape);
    try {
      render(
        <StatusActivityLog
          id="test-activity-log"
          open
          status="Ready"
          tone="ready"
          triggerRef={createRef<HTMLButtonElement>()}
          onClose={onClose}
        />
      );
      // The panel loads on demand; its key handler arrives with it.
      await screen.findByRole('region', { name: 'Activity log' });
      fireEvent.keyDown(document.body, { key: 'Escape' });
      expect(onClose).toHaveBeenCalledWith(true);
      expect(workspaceEscape).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener('keydown', workspaceEscape);
    }
  });
});
